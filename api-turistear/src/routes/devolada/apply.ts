import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm'
import type { Db } from '../../db/client'
import {
  devoladaConnections,
  devoladaLinks,
  devoladaPayments,
  folios,
  type DevoladaLink,
  type DevoladaPayment,
  type DevoladaPaymentStatus,
} from '../../db/schema'
import type { DevoladaPaymentRead } from '../../services/devolada'
import { folioEventRowWhere } from '../../utils/folioEvents'
import { deriveStatusSql } from '../../utils/folioStatus'
import { cancelForUnreceivedTransfer } from '../pos/unreceivedTransfer'
import { releaseClearedFolio, verifyFolioPayment } from '../pos/verifyCore'
import { setCreditPaused } from './connection'

// devolada-transfer-verification D9 — applying what Devolada reports for a payment. The webhook and
// the sweep share this one function, and both call it with a RE-READ, never with a webhook body.
//
// Applying twice changes nothing, and a final status never goes back. `applied_status` lets a
// repeat return early, but that read is only an optimization: the guarantee is the guarded write
// each branch makes (D10's flip and rollup).
//
// Sale and deposit links (the D9 table's first column): `confirmed` verifies that payment row and
// releases the tickets of a sale that is now paid; `partial`, `invalid` and `unapplied` record a
// verdict for the admin; `expired` cancels a sale whose money never arrived (D11); `superseded` is
// recorded and ignored. `validating`, `queued_for_credit` and an `awaiting` wait are snapshots.
// Every final status stamps the connection's `last_verdict_at` (FR-005).
//
// A status a branch does not handle yet is only recorded, WITHOUT marking it applied, so the code
// that handles it applies it then (research D19).

export interface ApplyDeps {
  db: Db
  env: CloudflareBindings
  waitUntil: (promise: Promise<unknown>) => void
}

const FINAL: ReadonlySet<DevoladaPaymentStatus> = new Set([
  'confirmed',
  'partial',
  'unapplied',
  'invalid',
  'expired',
  'superseded',
])

const toDate = (sec: number | null): Date | null => (sec === null ? null : new Date(sec * 1000))

/**
 * Stores Devolada's latest word on a payment. A final status is never overwritten by another
 * status: Devolada promises a verdict is final, and an older re-read must not undo it.
 */
async function upsertSnapshot(
  db: Db,
  link: DevoladaLink,
  payment: DevoladaPaymentRead,
  now: Date,
): Promise<{ stored: DevoladaPayment; previousStatus: DevoladaPaymentStatus | null }> {
  const existing = (
    await db
      .select()
      .from(devoladaPayments)
      .where(
        and(
          eq(devoladaPayments.devoladaPaymentId, payment.id),
          eq(devoladaPayments.organizationId, link.organizationId),
        ),
      )
      .limit(1)
  )[0]
  const snapshot = {
    status: payment.status,
    proofDoor: payment.proofDoor,
    askedAmount: payment.askedCents,
    claimedAmount: payment.claimedCents,
    receivedAmount: payment.receivedCents,
    match: payment.match,
    receiptNumber: payment.receiptNumber,
    verdictAt: toDate(payment.confirmedAt),
    awaiting: payment.awaiting,
    awaitingReason: payment.awaitingReason,
    updatedAt: now,
  }
  if (!existing) {
    const [inserted] = await db
      .insert(devoladaPayments)
      .values({
        id: crypto.randomUUID(),
        organizationId: link.organizationId,
        linkId: link.id,
        folioId: link.folioId,
        devoladaPaymentId: payment.id,
        devoladaCreatedAt: new Date(payment.createdAt * 1000),
        createdAt: now,
        ...snapshot,
      })
      // Two processors at once (the webhook and the sweep): the second one reads the first's row.
      .onConflictDoNothing({ target: devoladaPayments.devoladaPaymentId })
      .returning()
    if (inserted) return { stored: inserted, previousStatus: null }
    return upsertSnapshot(db, link, payment, now)
  }
  if (FINAL.has(existing.status) && existing.status !== payment.status) {
    return { stored: existing, previousStatus: existing.status }
  }
  const [updated] = await db
    .update(devoladaPayments)
    .set(snapshot)
    .where(and(eq(devoladaPayments.id, existing.id), eq(devoladaPayments.organizationId, link.organizationId)))
    .returning()
  return { stored: updated ?? existing, previousStatus: existing.status }
}

const markApplied = (db: Db, row: DevoladaPayment, now: Date) =>
  db
    .update(devoladaPayments)
    .set({ appliedStatus: row.status, appliedAt: now })
    .where(and(eq(devoladaPayments.id, row.id), eq(devoladaPayments.organizationId, row.organizationId)))

/** FR-005 — the connection's health shows when Devolada last decided a payment. */
const stampLastVerdict = (db: Db, organizationId: string, now: Date) =>
  db
    .update(devoladaConnections)
    .set({ lastVerdictAt: now, updatedAt: now })
    .where(eq(devoladaConnections.organizationId, organizationId))

/** A final status whose whole action is to be recorded. */
async function finish(db: Db, row: DevoladaPayment, now: Date): Promise<'applied'> {
  await db.batch([markApplied(db, row, now), stampLastVerdict(db, row.organizationId, now)])
  return 'applied'
}

/**
 * A verdict the admin must see (D9): `partial`, `invalid`, `unapplied`, or `confirmed` on a
 * cancelled sale. The sale's timeline gets a `payment_verdict` event with a NULL actor, written by
 * the processor that marks the verdict applied and never by a second one (the webhook and the
 * sweep at once): the event is gated on the mark not being there yet, and comes first in the batch.
 */
async function recordVerdict(db: Db, link: DevoladaLink, row: DevoladaPayment, now: Date): Promise<'applied'> {
  const notYetApplied = sql`NOT EXISTS (SELECT 1 FROM devolada_payments ap
    WHERE ap.id = ${row.id} AND ap.applied_status = ${row.status})`
  await db.batch([
    folioEventRowWhere(
      db,
      {
        organizationId: link.organizationId,
        folioId: link.folioId,
        type: 'payment_verdict',
        actorId: null,
        folioLineId: link.folioLineId,
        payload: {
          link_id: link.id,
          status: row.status,
          asked: row.askedAmount,
          received: row.receivedAmount,
          receipt_number: row.receiptNumber,
          awaiting: row.awaiting,
        },
        at: row.verdictAt ?? now,
      },
      notYetApplied,
    ),
    markApplied(db, row, now),
    stampLastVerdict(db, link.organizationId, now),
  ])
  return 'applied'
}

/** Whether `row` is its link's current payment: the latest non-superseded one (data-model). */
async function isCurrentPayment(db: Db, row: DevoladaPayment): Promise<boolean> {
  const [current] = await db
    .select({ id: devoladaPayments.id })
    .from(devoladaPayments)
    .where(
      and(
        eq(devoladaPayments.linkId, row.linkId),
        eq(devoladaPayments.organizationId, row.organizationId),
        ne(devoladaPayments.status, 'superseded'),
      ),
    )
    .orderBy(desc(devoladaPayments.devoladaCreatedAt), desc(sql`rowid`))
    .limit(1)
  return current?.id === row.id
}

/**
 * D9 — applies one re-read payment of one of our links. Answers whether a branch acted
 * (`applied`), or the payment was only recorded or already applied (`no_change`).
 */
export async function applyDevoladaPayment(
  deps: ApplyDeps,
  { link, payment }: { link: DevoladaLink; payment: DevoladaPaymentRead },
): Promise<'applied' | 'no_change'> {
  const { db } = deps
  const org = link.organizationId
  const now = new Date()
  const { stored, previousStatus } = await upsertSnapshot(db, link, payment, now)

  // Every notification applied, and every successful re-read, stamps the link: the sweep spends
  // its budget only on links nothing has reported on for 10 minutes (D12).
  await db
    .update(devoladaLinks)
    .set({ lastCheckedAt: now })
    .where(and(eq(devoladaLinks.id, link.id), eq(devoladaLinks.organizationId, org)))

  // A payment stored as queued_for_credit that moves on — a final verdict included, since a
  // re-read may never show the `validating` in between — means the credit is flowing again.
  if (previousStatus === 'queued_for_credit' && stored.status !== 'queued_for_credit') {
    await setCreditPaused(db, org, false)
  }

  if (stored.appliedStatus === stored.status) return 'no_change'

  switch (stored.status) {
    case 'validating':
    case 'queued_for_credit': {
      // A snapshot is the whole action: the sale shows «Verificando pago», «Verificación en pausa»
      // or «Pide al cliente su clave de rastreo». Paused credit is the CURRENT business's: a retired
      // credential's link leaves the connection's health alone (D21).
      if (stored.status === 'queued_for_credit') {
        const current = (
          await db
            .select({ id: devoladaConnections.currentCredentialId })
            .from(devoladaConnections)
            .where(eq(devoladaConnections.organizationId, org))
            .limit(1)
        )[0]
        if (current?.id === link.credentialId) await setCreditPaused(db, org, true)
      }
      await markApplied(db, stored, now)
      return 'applied'
    }
    case 'confirmed': {
      const sale = (
        await db
          .select({ cancelledAt: folios.cancelledAt, status: deriveStatusSql })
          .from(folios)
          .where(and(eq(folios.id, link.folioId), eq(folios.organizationId, org)))
          .limit(1)
      )[0]
      if (!sale) return 'no_change'
      // A cancelled sale is never verified: its money is money to return, as `unapplied` (D9).
      if (sale.cancelledAt) return recordVerdict(db, link, stored, now)
      if (link.kind === 'settlement' || !link.folioPaymentId) return 'no_change'
      return applyConfirmedSale(deps, link, stored, sale.status, now)
    }
    case 'partial':
    case 'invalid':
      // The sale stays pending: it shows in Por verificar with the amounts and its label, and the
      // admin uses Verificar or Rechazar as today (FR-018). A deposit's apartado waits (D8).
      if (link.kind === 'settlement') return 'no_change'
      return recordVerdict(db, link, stored, now)
    case 'unapplied':
      // «Dinero por devolver»: an attention item until the admin marks it returned (D15).
      return recordVerdict(db, link, stored, now)
    case 'expired':
      if (link.kind === 'settlement') return 'no_change'
      // D11 acts on the link's current payment only: a newer one still being decided keeps the sale.
      // D11's own checks keep a sale holding other money, verified by hand, or with another payment
      // in flight; a `'kept'` or `'noop'` result leaves this snapshot as the record.
      if (await isCurrentPayment(db, stored)) {
        await cancelForUnreceivedTransfer(deps, { organizationId: org, folioId: link.folioId, linkId: link.id, at: now })
      }
      return finish(db, stored, now)
    case 'superseded':
      // Recorded and ignored: the correction arrives as a new payment with its own id.
      return finish(db, stored, now)
    default:
      return 'no_change'
  }
}

/**
 * D9, D10 — a confirmed transfer of a sale or deposit link: verify THAT row, release once, mark the
 * link paid. A deposit releases nothing: its apartado is not paid yet (US3 scenario 2).
 */
async function applyConfirmedSale(
  deps: ApplyDeps,
  link: DevoladaLink,
  stored: DevoladaPayment,
  saleStatus: 'paid' | 'booking' | 'cancelled',
  now: Date,
): Promise<'applied'> {
  const { db } = deps
  const org = link.organizationId
  const verdictAt = stored.verdictAt ?? now
  const receipt = stored.receiptNumber ?? undefined
  // 1. One row, «Sistema» as the actor. It matches nothing if an admin already verified it by
  //    hand, so nothing is released twice (D10).
  const { flipped, rollupVerified } = await verifyFolioPayment(
    { db },
    {
      organizationId: org,
      folioId: link.folioId,
      paymentId: link.folioPaymentId!,
      actorId: null,
      reference: receipt,
      at: verdictAt,
      refuseCancelled: true,
      eventPayload: { source: 'devolada', receipt_number: stored.receiptNumber, received: stored.receivedAmount },
    },
  )
  // 2. The tickets, only in the call whose own flip and rollup both matched, for a paid sale.
  if (flipped && rollupVerified && saleStatus === 'paid') {
    await releaseClearedFolio(deps, { organizationId: org, folioId: link.folioId, at: verdictAt })
  }
  // 3-5. The receipt number becomes the sale's reference, the link is paid, and the connection
  //      records its last verdict (FR-005).
  await db.batch([
    db
      .update(folios)
      .set({ paymentReference: stored.receiptNumber, updatedAt: now })
      .where(
        and(eq(folios.id, link.folioId), eq(folios.organizationId, org), sql`${folios.cancelledAt} IS NULL`),
      ),
    db
      .update(devoladaLinks)
      .set({ state: 'paid', updatedAt: now })
      .where(
        and(
          eq(devoladaLinks.id, link.id),
          eq(devoladaLinks.organizationId, org),
          inArray(devoladaLinks.state, ['open', 'closing', 'closed']),
        ),
      ),
    stampLastVerdict(db, org, now),
    markApplied(db, stored, now),
  ])
  return 'applied'
}
