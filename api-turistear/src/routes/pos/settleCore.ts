import { and, eq, isNull, sql, type SQL } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import type { Db } from '../../db/client'
import { devoladaLinks, devoladaPayments, folioLineExtras, folioLines, folios, organizations } from '../../db/schema'
import { sendTicketConfirmationEmail } from '../../services/resend'
import { ApiError } from '../../types/errors'
import { orderForCascade, type LineAllocation } from '../../utils/folioAllocations'
import { folioEventRow, folioEventRowWhere } from '../../utils/folioEvents'
import { allocationRows, commissionRow, depositMethodSql, paymentRow } from '../../utils/folioPayments'
import { deriveBookingExpiresAtSql, deriveStatusSql } from '../../utils/folioStatus'
import { emitNotification } from '../../utils/notifications'
import type { PaymentLinkView } from '../../utils/devoladaLinkView'
import {
  issuePaymentLink,
  linkClosedEventsStatement,
  markLinksClosingStatement,
  type ClosedLink,
  type PaymentLinkError,
} from '../devolada/links'
import { issuePortalLink, signLineTickets } from './handler'

// devolada-transfer-verification D8 — settling an apartado's balance, without a request.
//
// `settleBooking` (the whole sale) and `settleFolioLine` (one line, US-AG54) collect a balance the
// same way: the balance and its allocations, the payment row, the commission top-up, settled_at /
// settled_by, the `payment` event (kind `settlement`), and — once the money is cleared — the tickets.
// That core lives here, so a settlement Devolada proves (a confirmed verdict) or the admin accepts
// (D15) is recorded by the same code as one the seller collects: two paths would drift.
//
// A Devolada settlement is recorded only once proven, and at most once per link: the link itself is
// the claim (`SettlementClaim`). D1 checks a foreign key at each statement (migration 0040), so the
// batch first writes the payment row while the link is still unclaimed, then claims the link with
// that row's id, and every later statement is gated on the claim (constitution V). A second
// processor — the webhook and the sweep at once, a Devolada retry, an admin's double tap — matches
// nothing and writes nothing.

export type SettleMethod = 'cash' | 'card' | 'transfer' | 'link'

export interface SettleDeps {
  db: Db
  env: CloudflareBindings
  waitUntil: (promise: Promise<unknown>) => void
}

export interface SettlementScope {
  organizationId: string
  folioId: string
  /** One line's balance (`settleFolioLine`), or null for the whole sale's (`settleBooking`). */
  folioLineId: string | null
}

interface PlanLine {
  id: string
  serviceId: string
  slotId: string | null
  serviceName: string
  slotDate: string | null
  slotStartTime: string | null
  checkIn: string | null
  checkOut: string | null
  quantity: number
  unitPrice: number
  lineTotal: number
  commissionType: string
  commissionValue: number
  cancelledAt: Date | null
  bookingExpiresAt: Date | null
  /** The net of the line's allocations, signed: what the line has collected. */
  allocated: number
}

export interface SettlementPlan extends SettlementScope {
  folio: {
    total: number
    amountPaid: number
    commissionAmount: number
    customerName: string | null
    customerEmail: string | null
    /** The deposit's method: the settle default, and the ticket email's method. */
    depositMethod: SettleMethod
    paymentVerification: string
  }
  /** Every line of the sale, cancelled ones included. */
  lines: PlanLine[]
  /** The line a per-line settlement collects. */
  line: PlanLine | null
  /** What this settlement collects. */
  amount: number
  allocations: LineAllocation[]
  /** The commission it books: the top-up that only accrues once the money is collected. */
  commission: number
  /** Whether it completes the sale: the whole sale's balance, or the last line still owed. */
  completing: boolean
}

const fullCommission = (l: PlanLine): number =>
  l.commissionType === 'fixed' ? l.commissionValue * l.quantity : Math.round((l.lineTotal * l.commissionValue) / 10000)

/**
 * What a settlement of this scope collects now, after the handlers' own guards, in their order:
 * the sale must be a live apartado, the line live and owing, and its clock not run out — unless
 * `bypassExpiry`, for a settlement whose payment was submitted before its link expired (D8).
 */
export async function planSettlement(
  db: Db,
  scope: SettlementScope,
  opts: { now: Date; bypassExpiry?: boolean },
): Promise<SettlementPlan> {
  const { organizationId: org, folioId, folioLineId } = scope
  const [folio] = await db
    .select({
      status: deriveStatusSql, // TECH_DEBT #25
      total: folios.total,
      amountPaid: folios.amountPaid,
      commissionAmount: folios.commissionAmount,
      customerName: folios.customerName,
      customerEmail: folios.customerEmail,
      depositMethod: depositMethodSql,
      paymentVerification: folios.paymentVerification,
      bookingExpiresAt: deriveBookingExpiresAtSql, // TECH_DEBT #25 — epoch seconds
    })
    .from(folios)
    .where(and(eq(folios.id, folioId), eq(folios.organizationId, org)))
    .limit(1)
  if (!folio) throw new ApiError('NOT_FOUND', 404, 'Folio not found')
  if (folio.status === 'paid') throw new ApiError('ALREADY_SETTLED', 409, 'Folio is already paid')
  if (folio.status === 'cancelled') throw new ApiError('FOLIO_CANCELLED', 409, 'Folio is cancelled')

  const lines: PlanLine[] = (
    await db
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
        commissionType: folioLines.commissionType,
        commissionValue: folioLines.commissionValue,
        cancelledAt: folioLines.cancelledAt,
        bookingExpiresAt: folioLines.bookingExpiresAt,
        allocated: sql<number>`coalesce((select sum(a.amount) from folio_payment_allocations a where a.folio_line_id = folio_lines.id), 0)`,
      })
      .from(folioLines)
      .where(and(eq(folioLines.folioId, folioId), eq(folioLines.organizationId, org)))
  ).map((l) => ({ ...l, allocated: Number(l.allocated ?? 0) }))
  // US-AG54 (line-autonomy F3) — a settlement collects, signs and commissions only what LIVES: a
  // cancelled line's seats went back, its money reversed, its commission clawed.
  const live = lines.filter((l) => !l.cancelledAt)
  const base = {
    ...scope,
    folio: { ...folio, depositMethod: folio.depositMethod as SettleMethod },
    lines,
  }

  if (!folioLineId) {
    if (!opts.bypassExpiry && folio.bookingExpiresAt && folio.bookingExpiresAt * 1000 <= opts.now.getTime()) {
      throw new ApiError('BOOKING_EXPIRED', 409, 'Booking has expired')
    }
    // Full commission from the per-line snapshot: percent on the full line total + fixed, which
    // only accrues now that the folio reaches `paid` (US-AG07 D8).
    const commission = Math.max(0, live.reduce((sum, l) => sum + fullCommission(l), 0) - folio.commissionAmount)
    // US-LG09 — each line receives exactly what it is still owed, in cascade order. With every line
    // alive the balance is the scalar arithmetic it always was; once a line was cancelled, only the
    // allocations can say what the live lines are still owed. When the sums do not close (a folio
    // hand-seeded by an older test), the allocations are skipped rather than blocking the settle.
    const remainingByLine = orderForCascade(live)
      .map((l) => ({ folioLineId: l.id, amount: Math.max(0, l.lineTotal - l.allocated) }))
      .filter((x) => x.amount > 0)
    const remainingTotal = remainingByLine.reduce((s, x) => s + x.amount, 0)
    const amount = live.length !== lines.length ? remainingTotal : folio.total - folio.amountPaid
    return {
      ...base,
      line: null,
      amount,
      allocations: remainingTotal === amount ? remainingByLine : [],
      commission,
      completing: true,
    }
  }

  const line = lines.find((l) => l.id === folioLineId)
  // Cross-org and wrong-folio land indistinguishably on 404 (S-14).
  if (!line) throw new ApiError('FOLIO_LINE_NOT_FOUND', 404, 'Line not found in this folio')
  if (line.cancelledAt) throw new ApiError('LINE_ALREADY_CANCELLED', 409, 'This line is cancelled')
  // bug: settled-line-clock-expiry — paid is asked BEFORE the clock.
  const remaining = Math.max(0, line.lineTotal - Math.max(0, line.allocated))
  if (remaining === 0) throw new ApiError('LINE_ALREADY_PAID', 409, 'This line is already fully paid')
  // The LINE's own clock guards its own settle (D5) — a sibling's expiry is not this line's fact.
  if (!opts.bypassExpiry && line.bookingExpiresAt && line.bookingExpiresAt.getTime() <= opts.now.getTime()) {
    throw new ApiError('BOOKING_EXPIRED', 409, 'This line’s hold has expired')
  }
  // The line's full commission minus what the deposit's percent-on-collected already attributed to
  // it; fixed accrues only now, when the line reaches paid (D8/D9).
  const accrued =
    line.commissionType === 'fixed'
      ? 0
      : Math.round((fullCommission(line) * Math.max(0, line.allocated)) / line.lineTotal)
  return {
    ...base,
    line,
    amount: remaining,
    allocations: [{ folioLineId: line.id, amount: remaining }],
    commission: Math.max(0, fullCommission(line) - accrued),
    completing: live.every((l) => l.id === line.id || Math.max(0, l.allocated) >= l.lineTotal),
  }
}

/** D8 — a settlement Devolada proved, or the admin accepted: its link is the claim. */
export interface SettlementClaim {
  linkId: string
  /** A confirmed verdict ends the link `paid`; the admin's accept of a payment in flight leaves it
   *  open until its verdict (D15). */
  markPaid: boolean
  /** D15 — the accept's own decision, recorded by the same claimed batch. */
  resolve?: { devoladaPaymentId: string; resolvedBy: string }
}

export interface SettlementInput {
  method: SettleMethod
  /** Stored on a transfer's row: the bank reference, or Devolada's receipt number. */
  reference: string | null
  /** `pending`: a transfer the admin verifies later; `verified`: proven as it is recorded (D8). */
  verification: 'pending' | 'not_required' | 'verified'
  /** Who verified a proven payment (NULL = «Sistema») and when. */
  verifiedBy?: string | null
  verifiedAt?: Date | null
  collectedBy: string
  settledBy: string
  /** The `payment` event's actor; NULL = «Sistema». */
  actorId: string | null
  /** settled_at, and the event's moment. */
  at: Date
  /** The ledger rows' own date — a verdict's (D8); omitted, the database's clock. */
  recordedAt?: Date
  claim?: SettlementClaim
}

/**
 * Records a planned settlement in one batch, then its tickets once the money is cleared:
 * - the whole sale's: every live slot line's QR in the batch, then the portal token and the ticket
 *   email;
 * - one line's: that line's QR in the batch, and the portal token once it completes the sale.
 * A proven settlement that completes a cleared sale also emits `payment_verified` and
 * `tickets_delivered`, as a verification does (D10). With a claim, it answers whether the claim
 * matched; nothing is written otherwise.
 */
export async function applySettlement(
  deps: SettleDeps,
  plan: SettlementPlan,
  input: SettlementInput,
): Promise<{ recorded: boolean; cleared: boolean; closedLinks: ClosedLink[] }> {
  const { db, env } = deps
  const { organizationId: org, folioId, folio, line } = plan
  const { claim } = input
  // The QR can mint now only if THIS money clears AND no earlier payment awaits an admin (US-A67).
  const cleared = input.verification !== 'pending' && folio.paymentVerification !== 'pending'
  const proven = input.verification === 'verified'
  if (claim && plan.amount <= 0) return { recorded: false, cleared, closedLinks: [] }

  const paymentId = crypto.randomUUID()
  // The link is still claimable — unclaimed, and not closed by a write that changed what the sale
  // owes (D13) — and its sale still alive.
  const claimable: SQL | undefined = claim
    ? sql`EXISTS (SELECT 1 FROM devolada_links cl
        WHERE cl.id = ${claim.linkId} AND cl.organization_id = ${org} AND cl.folio_id = ${folioId}
          AND cl.kind = 'settlement' AND cl.folio_payment_id IS NULL AND cl.closed_reason IS NULL)
      AND EXISTS (SELECT 1 FROM folios cf WHERE cf.id = ${folioId} AND cf.organization_id = ${org} AND cf.cancelled_at IS NULL)`
    : undefined
  // The link now holds THIS batch's row: every later statement is gated on it.
  const claimed: SQL | undefined = claim
    ? sql`EXISTS (SELECT 1 FROM devolada_links cl
        WHERE cl.id = ${claim.linkId} AND cl.organization_id = ${org} AND cl.folio_payment_id = ${paymentId})`
    : undefined

  const statements: BatchItem<'sqlite'>[] = []
  if (plan.amount > 0) {
    statements.push(
      paymentRow(db, {
        id: paymentId,
        organizationId: org,
        folioId,
        amount: plan.amount,
        method: input.method,
        reference: input.method === 'transfer' ? input.reference : null,
        verification: input.verification,
        collectedBy: input.collectedBy,
        verifiedBy: input.verifiedBy,
        verifiedAt: input.verifiedAt,
        createdAt: input.recordedAt,
        gate: claimable,
      }),
    )
  }
  const claimIndex = statements.length
  if (claim) {
    statements.push(
      db
        .update(devoladaLinks)
        .set({ folioPaymentId: paymentId, ...(claim.markPaid ? { state: 'paid' as const } : {}), updatedAt: input.at })
        .where(
          and(
            eq(devoladaLinks.id, claim.linkId),
            eq(devoladaLinks.organizationId, org),
            eq(devoladaLinks.folioId, folioId),
            eq(devoladaLinks.kind, 'settlement'),
            isNull(devoladaLinks.folioPaymentId),
            sql`EXISTS (SELECT 1 FROM folio_payments np WHERE np.id = ${paymentId} AND np.organization_id = ${org})`,
          ),
        )
        .returning({ id: devoladaLinks.id }),
    )
  }
  if (plan.amount > 0) {
    statements.push(
      ...allocationRows(db, {
        organizationId: org,
        paymentId,
        allocations: plan.allocations,
        sign: 1,
        createdAt: input.recordedAt,
        gate: claimed,
      }),
    )
  }
  if (plan.commission > 0) {
    statements.push(
      commissionRow(db, {
        organizationId: org,
        folioId,
        amount: plan.commission,
        method: input.method,
        collectedBy: input.collectedBy,
        createdAt: input.recordedAt,
        gate: claimed,
      }),
    )
  }
  statements.push(
    db
      .update(folios)
      .set({
        // TECH_DEBT #25 — status derives from the lines. With a cancelled line amount_paid is NOT the
        // total: the customer pays what the live lines are owed, and amount_paid records it.
        amountPaid: folio.amountPaid + plan.amount,
        commissionAmount: folio.commissionAmount + plan.commission,
        ...(plan.completing ? { settledAt: input.at, settledBy: input.settledBy } : {}),
        // A transfer the admin verifies later re-arms the sale's verification (US-A67).
        ...(input.verification === 'pending'
          ? { paymentReference: input.reference, paymentVerification: 'pending' as const }
          : {}),
        // A proven transfer verifies the sale, unless an earlier payment still awaits the admin: the
        // rollup then waits for it (D10).
        ...(proven && folio.paymentVerification !== 'pending'
          ? {
              paymentReference: input.reference,
              paymentVerification: 'verified' as const,
              paymentVerifiedAt: input.verifiedAt ?? input.at,
              paymentVerifiedBy: input.verifiedBy ?? null,
            }
          : {}),
        updatedAt: input.at,
      })
      .where(and(eq(folios.id, folioId), eq(folios.organizationId, org), claimed)),
  )
  // US-A24 — the settlement's narrative row, on the same clock as settled_at (S-6).
  const event = {
    organizationId: org,
    folioId,
    type: 'payment' as const,
    actorId: input.actorId,
    ...(line ? { folioLineId: line.id } : {}),
    payload: {
      amount: plan.amount,
      method: input.method,
      kind: 'settlement',
      ...(line
        ? { line: { service_name: line.serviceName, slot_date: line.slotDate, slot_start_time: line.slotStartTime } }
        : {}),
    },
    at: input.at,
  }
  statements.push(claimed ? folioEventRowWhere(db, event, claimed) : folioEventRow(db, event))

  // The tickets mint with the money, in the same batch — SLOT lines only; a stay's access is its
  // reservation. The whole sale's settlement signs every live slot line; one line's, that line.
  const live = plan.lines.filter((l) => !l.cancelledAt)
  const toSign = !cleared ? [] : line ? [line].filter((l) => l.slotId && l.slotDate) : live.filter((l) => l.slotId && l.slotDate)
  const tz =
    toSign.length === 0
      ? null
      : ((await db.select({ tz: organizations.timezone }).from(organizations).where(eq(organizations.id, org)).limit(1))[0]
          ?.tz ?? 'America/Mexico_City')
  const tickets = tz
    ? await signLineTickets(
        env,
        org,
        folioId,
        folio.customerName?.trim() || folio.customerEmail?.trim() || `folio:${folioId}`,
        toSign.map((l) => ({ id: l.id, serviceId: l.serviceId, slotId: l.slotId!, quantity: l.quantity, slotDate: l.slotDate! })),
        tz,
      )
    : new Map<string, { token: string }>()
  for (const l of toSign) {
    statements.push(
      db
        .update(folioLines)
        .set({ qrToken: tickets.get(l.id)!.token })
        .where(and(eq(folioLines.id, l.id), eq(folioLines.organizationId, org), claimed)),
    )
  }
  if (claim?.resolve) {
    statements.push(
      db
        .update(devoladaPayments)
        .set({ resolution: 'accepted', resolvedBy: claim.resolve.resolvedBy, resolvedAt: input.at, updatedAt: input.at })
        .where(
          and(
            eq(devoladaPayments.id, claim.resolve.devoladaPaymentId),
            eq(devoladaPayments.organizationId, org),
            isNull(devoladaPayments.resolution),
            claimed,
          ),
        ),
    )
  }

  // D13 — a settlement collected some other way (cash, card, or a transfer recorded by hand) closes
  // the open settlement links that ask part of what it settles: any for the whole sale; for one
  // line, a whole-sale link or that line's own. Another line's link still asks what its line owes.
  // The seller's settle refuses first when such a link's payment is in flight (FR-011).
  const closingIndex = claim ? -1 : statements.length
  if (!claim) {
    statements.push(
      markLinksClosingStatement(db, org, folioId, 'settled_otherwise', {
        at: input.at,
        kinds: ['settlement'],
        ...(line ? { forLines: [line.id] } : {}),
      }),
      linkClosedEventsStatement(db, org, folioId, { at: input.at, actorId: input.actorId }),
    )
  }

  const results = await db.batch(statements as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]])
  if (claim && (results[claimIndex] as unknown[]).length === 0) return { recorded: false, cleared, closedLinks: [] }
  const closedLinks = closingIndex >= 0 ? (results[closingIndex] as ClosedLink[]) : []

  if (cleared && plan.completing) {
    // The deferred half of the paid path: the portal token, and for the whole sale the ticket email.
    const portalLink = await issuePortalLink(
      db,
      env,
      org,
      folioId,
      line
        ? plan.lines.map((l) => l.slotDate).filter((d): d is string => !!d)
        : live.map((l) => l.slotDate ?? l.checkOut ?? l.checkIn).filter((d): d is string => !!d),
    )
    if (!line && folio.customerEmail && env.RESEND_API_KEY) {
      await sendTicketEmail(deps, plan, input.method, portalLink, toSign, tickets)
    }
    if (proven) {
      // US-A86 — the money is proven AND the tickets exist: as after a verification (D10).
      const hasEmail = !!folio.customerEmail
      await emitNotification(db, { organizationId: org, folioId, event: 'payment_verified', hasEmail })
      await emitNotification(db, { organizationId: org, folioId, event: 'tickets_delivered', hasEmail })
    }
  }
  return { recorded: true, cleared, closedLinks }
}

/** D8 — what a settlement link shows the customer: the organization, the first line and its date. */
export async function settlementConcept(db: Db, plan: SettlementPlan): Promise<string> {
  const first = plan.line ?? plan.lines.find((l) => !l.cancelledAt)
  const orgName =
    (await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, plan.organizationId)).limit(1))[0]
      ?.name ?? 'Turistear Ya!'
  return first ? `${orgName} · ${first.serviceName} ${first.slotDate ?? first.checkIn ?? ''}`.trim() : orgName
}

/** The fields a line cancellation's response adds when it replaced the settlement link (D13). */
export type ReplacementLink = { payment_link: PaymentLinkView } | { payment_link: null; payment_link_error: PaymentLinkError }

/**
 * D13 — a line cancellation closed the whole-sale settlement link (`amount_changed`): while the sale
 * still owes, a replacement asks the new balance, issued after the write (constitution VIII) by the
 * seller who issued the first one, who collects the settlement (D8). Nothing when no replacement
 * applies: the cancellation closed no whole-sale link, or the sale no longer owes — its settlement
 * already recorded (D15), or its clock run out — or the organization has no key any more.
 */
export async function replaceSettlementLink(
  deps: Pick<SettleDeps, 'db' | 'env'>,
  { organizationId, folioId, closed }: { organizationId: string; folioId: string; closed: ClosedLink[] },
): Promise<ReplacementLink | null> {
  const { db } = deps
  const old = closed.find((l) => l.kind === 'settlement' && l.folioLineId === null && l.closedReason === 'amount_changed')
  if (!old) return null
  let plan: SettlementPlan
  try {
    plan = await planSettlement(db, { organizationId, folioId, folioLineId: null }, { now: new Date() })
  } catch (err) {
    if (err instanceof ApiError) return null
    throw err
  }
  if (plan.amount <= 0) return null
  try {
    const result = await issuePaymentLink(deps, {
      organizationId,
      folioId,
      folioPaymentId: null,
      folioLineId: null,
      kind: 'settlement',
      amount: plan.amount,
      requestedBy: old.requestedBy,
      customerName: plan.folio.customerName,
      concept: await settlementConcept(db, plan),
    })
    if (result.link) return { payment_link: result.link }
    return result.error ? { payment_link: null, payment_link_error: result.error } : null
  } catch (err) {
    // Another request opened the sale's settlement link first (one per sale), or the write failed:
    // no replacement from here. The sale shows the link that is open, if any, and can settle again.
    console.error('[devolada] replacement settlement link failed', folioId, err)
    return { payment_link: null, payment_link_error: 'DEVOLADA_UNAVAILABLE' }
  }
}

/** The ticket email of a sale the whole-sale settlement cleared, fire-and-forget (waitUntil). */
async function sendTicketEmail(
  deps: SettleDeps,
  plan: SettlementPlan,
  method: SettleMethod,
  portalLink: string | undefined,
  lines: PlanLine[],
  tickets: Map<string, { token: string }>,
): Promise<void> {
  const { db, env } = deps
  const { organizationId: org, folioId, folio } = plan
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
  const orgName =
    (await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, org)).limit(1))[0]
      ?.name ?? 'Turistear Ya!'
  deps.waitUntil(
    sendTicketConfirmationEmail(env, {
      to: folio.customerEmail!,
      customerName: folio.customerName,
      orgName,
      folioId,
      createdAt: new Date(),
      // US-LG08 — the folio is now paid: its display method, 'Mixto' when the deposit and the
      // balance were collected differently.
      paymentMethod: folio.depositMethod === method ? folio.depositMethod : 'Mixto',
      total: folio.total,
      portalLink,
      lines: lines.map((l) => ({
        serviceName: l.serviceName,
        slotDate: l.slotDate!,
        slotStartTime: l.slotStartTime!,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        lineTotal: l.lineTotal,
        qrToken: tickets.get(l.id)!.token,
        extras: (extrasByLine.get(l.id) ?? []).map((ex) => ({ name: ex.name, price: ex.price, quantity: ex.quantity })),
      })),
    }).catch((err) => console.error('[email] confirmation send failed', folioId, err)),
  )
}
