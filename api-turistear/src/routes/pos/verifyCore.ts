import { and, eq, sql } from 'drizzle-orm'
import type { Db } from '../../db/client'
import { folioLineExtras, folioLines, folioPayments, folios, organizations } from '../../db/schema'
import { sendTicketConfirmationEmail } from '../../services/resend'
import { folioEventRowWhere } from '../../utils/folioEvents'
import { displayMethodSql } from '../../utils/folioPayments'
import { emitNotification } from '../../utils/notifications'
import { markLinksClosingStatement, type ClosedLink } from '../devolada/links'
import { issuePortalLink, signLineTickets } from './handler'

// devolada-transfer-verification D10 — verifying one payment at a time, without a request.
//
// `verifyPayment` (the admin's Verificar) flips EVERY pending row of a sale, which is right for an
// admin who clears a sale and wrong for a provider that proves one transfer. These two cores are
// the part of it that a webhook or a sweep can call: no Hono context, `deps` instead (precedent:
// `queueCancellationEmail({env, executionCtx})`, routes/folios/handler.ts). The admin endpoint
// calls them with `paymentId: 'all'`, so its behaviour does not change.

export interface VerifyDeps {
  db: Db
  env: CloudflareBindings
  waitUntil: (promise: Promise<unknown>) => void
}

export interface VerifyFolioPaymentInput {
  organizationId: string
  folioId: string
  /** One ledger row (Devolada proves one transfer), or every pending one (the admin's Verificar). */
  paymentId: string | 'all'
  /** NULL = «Sistema» (Devolada's verdict). */
  actorId: string | null
  /** Stored on the flipped row: Devolada's receipt number. Omitted, the row keeps its own. */
  reference?: string
  at: Date
  /** Do nothing for a cancelled sale: a cancelled sale is never verified (D9). */
  refuseCancelled?: boolean
  /** The `payment_verified` event's payload. */
  eventPayload?: Record<string, unknown>
  /**
   * The admin's Verificar (D13): the links that collect the rows this call verifies stop taking
   * money (`verified_by_admin`), in the same batch — except one whose payment is in flight, which
   * its verdict ends. Verifying a deposit leaves the sale's settlement link open: it collects no row.
   */
  closeVerifiedLinks?: boolean
}

/**
 * Flips the row(s) and rolls the sale's `payment_verification` up to `verified` once no pending
 * row is left, in one batch where each statement is guarded by its own transition. Returns whether
 * THIS call's row flip matched and whether THIS call's rollup matched: only a call that got both
 * may release the tickets, so a second processor (the webhook and the sweep at once, a Devolada
 * retry, an admin who verified by hand first) never signs the QR again — which would invalidate the
 * codes already delivered — nor sends the email twice. With `closeVerifiedLinks`, also the links
 * it marked `closing`.
 */
export async function verifyFolioPayment(
  deps: Pick<VerifyDeps, 'db'>,
  input: VerifyFolioPaymentInput,
): Promise<{ flipped: boolean; rollupVerified: boolean; closedLinks: ClosedLink[] }> {
  const { db } = deps
  const { organizationId: org, folioId, paymentId, actorId, at } = input
  const atSec = Math.floor(at.getTime() / 1000)
  const notCancelled = sql`EXISTS (SELECT 1 FROM folios f WHERE f.id = ${folioId} AND f.organization_id = ${org} AND f.cancelled_at IS NULL)`

  const flip = db
    .update(folioPayments)
    .set({
      verification: 'verified',
      verifiedAt: at,
      verifiedBy: actorId,
      ...(input.reference !== undefined ? { reference: input.reference } : {}),
    })
    .where(
      and(
        eq(folioPayments.folioId, folioId),
        eq(folioPayments.organizationId, org),
        eq(folioPayments.entryType, 'payment'),
        eq(folioPayments.verification, 'pending'),
        paymentId === 'all' ? undefined : eq(folioPayments.id, paymentId),
        input.refuseCancelled ? notCancelled : undefined,
      ),
    )
    .returning({ id: folioPayments.id })

  const rollup = db
    .update(folios)
    .set({
      paymentVerification: 'verified',
      paymentVerifiedAt: at,
      paymentVerifiedBy: actorId,
      updatedAt: at,
    })
    .where(
      and(
        eq(folios.id, folioId),
        eq(folios.organizationId, org),
        eq(folios.paymentVerification, 'pending'),
        input.refuseCancelled ? sql`${folios.cancelledAt} IS NULL` : undefined,
        sql`NOT EXISTS (SELECT 1 FROM folio_payments p WHERE p.folio_id = ${folioId} AND p.organization_id = ${org} AND p.verification = 'pending')`,
      ),
    )
    .returning({ id: folios.id })

  // US-A24 — the clearance's narrative row, written only if this batch's own flip matched.
  const event = folioEventRowWhere(
    db,
    {
      organizationId: org,
      folioId,
      type: 'payment_verified',
      actorId,
      payload: input.eventPayload,
      at,
    },
    sql`EXISTS (SELECT 1 FROM folio_payments p WHERE p.folio_id = ${folioId} AND p.organization_id = ${org}
      AND p.verification = 'verified' AND p.verified_at = ${atSec} AND p.verified_by IS ${actorId}
      ${paymentId === 'all' ? sql`` : sql`AND p.id = ${paymentId}`})`,
  )

  // D13 — gated like the event: only the links of rows this batch's own flip verified.
  const closing = input.closeVerifiedLinks
    ? [markLinksClosingStatement(db, org, folioId, 'verified_by_admin', { at, rowsVerified: { at, actorId } })]
    : []
  const [flipped, rolled, , closed] = await db.batch([flip, rollup, event, ...closing])
  return {
    flipped: flipped.length > 0,
    rollupVerified: rolled.length > 0,
    closedLinks: (closed as ClosedLink[] | undefined) ?? [],
  }
}

/**
 * The paid path's deferred side effects, once a sale's money is cleared: sign the QR of every live
 * slot line, issue the portal token, send the ticket email, and emit `payment_verified` and
 * `tickets_delivered`. Call it only after a `verifyFolioPayment` that returned
 * `flipped && rollupVerified`, for a sale that is paid (D10).
 */
export async function releaseClearedFolio(
  deps: VerifyDeps,
  { organizationId: org, folioId, at }: { organizationId: string; folioId: string; at: Date },
): Promise<void> {
  const { db, env } = deps
  const folio = (
    await db
      .select({
        customerName: folios.customerName,
        customerEmail: folios.customerEmail,
        total: folios.total,
        paymentMethod: displayMethodSql,
      })
      .from(folios)
      .where(and(eq(folios.id, folioId), eq(folios.organizationId, org)))
      .limit(1)
  )[0]
  if (!folio) return
  const orgRow = (
    await db
      .select({ name: organizations.name, tz: organizations.timezone })
      .from(organizations)
      .where(eq(organizations.id, org))
      .limit(1)
  )[0]
  const tz = orgRow?.tz ?? 'America/Mexico_City'

  const allLineRows = await db
    .select({
      id: folioLines.id,
      serviceId: folioLines.serviceId,
      slotId: folioLines.slotId,
      serviceName: folioLines.serviceName,
      slotDate: folioLines.slotDate,
      slotStartTime: folioLines.slotStartTime,
      checkIn: folioLines.checkIn,
      checkOut: folioLines.checkOut,
      quantity: folioLines.quantity,
      unitPrice: folioLines.unitPrice,
      lineTotal: folioLines.lineTotal,
      cancelledAt: folioLines.cancelledAt,
    })
    .from(folioLines)
    .where(and(eq(folioLines.folioId, folioId), eq(folioLines.organizationId, org)))
  // US-A89 (F4, PR-7) — verification releases tickets for the lines that LIVE: re-signing a
  // cancelled line's QR would hand back a pass for a seat already returned to the pool.
  const lineRows = allLineRows.filter((l) => !l.cancelledAt)

  const slotLineRows = lineRows.filter((l) => l.slotId && l.slotDate)
  const identity = folio.customerName?.trim() || folio.customerEmail?.trim() || `folio:${folioId}`
  const tickets = await signLineTickets(
    env,
    org,
    folioId,
    identity,
    slotLineRows.map((l) => ({
      id: l.id,
      serviceId: l.serviceId,
      slotId: l.slotId!,
      quantity: l.quantity,
      slotDate: l.slotDate!,
    })),
    tz,
  )
  const [firstQr, ...moreQr] = slotLineRows.map((line) =>
    db
      .update(folioLines)
      .set({ qrToken: tickets.get(line.id)!.token })
      .where(and(eq(folioLines.id, line.id), eq(folioLines.organizationId, org))),
  )
  if (firstQr) await db.batch([firstQr, ...moreQr])

  // Deferred portal token + ticket email (auto-delivery on verify, US-A67 D8).
  const portalLink = await issuePortalLink(
    db,
    env,
    org,
    folioId,
    lineRows.map((l) => l.slotDate ?? l.checkOut ?? l.checkIn).filter((d): d is string => !!d),
  )
  if (folio.customerEmail && env.RESEND_API_KEY) {
    const extraRows = await db
      .select({
        folioLineId: folioLineExtras.folioLineId,
        name: folioLineExtras.name,
        price: folioLineExtras.price,
        quantity: folioLineExtras.quantity,
      })
      .from(folioLineExtras)
      .where(and(eq(folioLineExtras.folioId, folioId), eq(folioLineExtras.organizationId, org)))
    const extrasByLine = new Map<string, typeof extraRows>()
    for (const ex of extraRows) {
      const list = extrasByLine.get(ex.folioLineId) ?? []
      list.push(ex)
      extrasByLine.set(ex.folioLineId, list)
    }
    // Fire-and-forget (waitUntil), so a Resend failure never rolls back the verification.
    deps.waitUntil(
      sendTicketConfirmationEmail(env, {
        to: folio.customerEmail,
        customerName: folio.customerName,
        orgName: orgRow?.name ?? 'Turistear Ya!',
        folioId,
        createdAt: at,
        paymentMethod: folio.paymentMethod,
        total: folio.total,
        portalLink,
        lines: slotLineRows.map((line) => ({
          serviceName: line.serviceName,
          slotDate: line.slotDate!,
          slotStartTime: line.slotStartTime!,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          lineTotal: line.lineTotal,
          qrToken: tickets.get(line.id)!.token,
          extras: (extrasByLine.get(line.id) ?? []).map((ex) => ({
            name: ex.name,
            price: ex.price,
            quantity: ex.quantity,
          })),
        })),
      }).catch((err) => console.error('[email] confirmation send failed', folioId, err)),
    )
  }

  // US-A86 — the money cleared AND the tickets exist now, so both events are real: one answers
  // "¿ya les llegó mi transferencia?", the other IS the product.
  const hasEmail = !!folio.customerEmail
  await emitNotification(db, { organizationId: org, folioId, event: 'payment_verified', hasEmail })
  await emitNotification(db, { organizationId: org, folioId, event: 'tickets_delivered', hasEmail })
}
