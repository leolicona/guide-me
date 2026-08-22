import type { Context } from 'hono'
import type { BatchItem } from 'drizzle-orm/batch'
import { and, desc, eq, inArray, isNull, ne, sql, type SQL } from 'drizzle-orm'
import { getDb, type Db } from '../../db/client'
import {
  accommodationReservations,
  affiliateOperators,
  folioRequests,
  folioLines,
  folioPaymentAllocations,
  folios,
  organizations,
  slotZones,
  slots,
  users,
} from '../../db/schema'
import { reconcileSlotTotals } from '../services/zones.reconcile'
import { ApiError } from '../../types/errors'
import type { AppVariables } from '../../types/context'
import type {
  CancelFolioInput,
  ConfirmRefundInput,
  RejectCancellationRequestInput,
} from './schema'
import {
  sendCancellationEmail,
  type CancellationEmailInput,
} from '../../services/resend'
import { generateRefundPin } from '../../utils/portal'
import { folioFulfillment } from '../../utils/folioFulfillment'
import {
  anyLineStatusSql,
  deriveBookingExpiresAtSql,
  deriveRefundAmountSql,
  deriveRefundStatusSql,
  deriveStatusSql,
} from '../../utils/folioStatus'
import {
  rescheduleFolio,
  reissueTicketsAfterReschedule,
  viableAlternatives,
} from '../pos/reschedule'
import { emitNotification, recordEmailOutcome } from '../../utils/notifications'
import { buildCancellationReversal, displayMethodSql } from '../../utils/folioPayments'
import { folioEventRow, readFolioEvents } from '../../utils/folioEvents'
import { readFolioDetail } from '../../utils/folioDetail'
import {
  readListCancellationRequests,
  readListLines,
  readListPortalLinks,
  serializeFolioListRow,
} from '../../utils/folioListRows'
import {
  DEFAULT_WINDOW_DAYS,
  listWindowFilter,
  overdueFilter,
  refundPendingFilter,
  requestPendingFilter,
  undeliveredFilter,
  verificationPendingFilter,
} from '../../utils/folioPendingWork'
import {
  asDay,
  dateRangeFilter,
  MIN_QUERY_LENGTH,
  normalizeQuery,
  searchFilter,
  SEARCH_LIMIT,
} from '../../utils/folioSearch'
import {
  computeCancellationRefund,
  lineCommissions,
  resolvePolicy,
  type CancellationOutcome,
} from '../../utils/cancellationPolicy'
// US-A22 (line-autonomy) — the refund debt's per-line split shares the allocation engine's
// largest-remainder rule, and the cascade ordering keeps every split deterministic.
import { orderForCascade, prorateByWeight } from '../../utils/folioAllocations'

export type FoliosContext = Context<{
  Bindings: CloudflareBindings
  Variables: AppVariables
}>

const tsOrNull = (d: Date | null) => (d ? Math.floor(d.getTime() / 1000) : null)

// docs/oversight/folio-surface-parity.spec.md D6 — the folio detail is read and serialized in ONE
// place, shared with the seller's surface (`utils/folioDetail.ts`). This wrapper exists only so the
// admin call sites keep reading as they did; it is not a second shape.
const readFolio = (
  db: Db,
  org: string,
  folioId: string,
  apiBaseUrl?: string,
  qrSecret?: string,
) => readFolioDetail(db, org, folioId, { apiBaseUrl, qrSecret })

// --- Admin surface (US-A21) ---------------------------------------------------

// US-A21 — list folios in the caller's org (find one to cancel). A lean row shape:
// enough to identify a folio, not a sales dashboard (that is the occupancy-dashboard
// feature). Optional `status` / `date` (created_at UTC day) / `agent_id` filters.
//
// US-A84 — the read is now BOUNDED, by a union rather than a page: every folio with pending work
// at any age, plus the last N org-local days of everything else. The union half is what lets the
// client filter in memory honestly — a facet computed over a partial set would answer about the
// rows that happened to load and present it as the answer about the organization (D8).
export const listFolios = async (c: FoliosContext) => {
  const admin = c.get('user')
  const org = admin.organizationId
  const db = getDb(c.env)

  const statusQ = c.req.query('status')
  const dateQ = c.req.query('date')
  const agentQ = c.req.query('agent_id')
  // US-A67 — the "Por verificar" queue filters to electronic payments awaiting an admin.
  const verificationQ = c.req.query('verification')
  // US-A78/A79 (docs/oversight/pending-work-queues.spec.md) — the two work queues. Both are pure
  // WHERE clauses over existing columns: no stored "overdue" state, because a stored stage needs a
  // writer and a cron that writes state drifts from the clock that defines it (apartado-stages S7).
  const refundStatusQ = c.req.query('refund_status')
  const overdueQ = c.req.query('overdue')
  // US-A83 — the two ways to reach PAST the load window: a date range, and a free-text query.
  // `date` is now an alias for a one-day range (D10), so there is exactly one implementation of
  // "which day is this" — the previous `strftime(… 'unixepoch')` compared a UTC day, which for an
  // org at UTC−5 answered for tomorrow from 19:00 local, the busiest hours of a beach counter.
  const dayQ = asDay(dateQ)
  const fromQ = asDay(c.req.query('from')) ?? dayQ
  const toQ = asDay(c.req.query('to')) ?? dayQ
  const normalizedQ = normalizeQuery(c.req.query('q') ?? '')
  const hasQuery = normalizedQ.length >= MIN_QUERY_LENGTH
  const hasDateFilter = !!(fromQ || toQ)

  const filters = [eq(folios.organizationId, org)]
  if (statusQ === 'paid' || statusQ === 'booking' || statusQ === 'cancelled') {
    // D15 (line-autonomy) — ANY-LINE semantics: the filter answers "is there work of this kind
    // here?", so a mixed folio appears under every facet one of its lines earns.
    filters.push(anyLineStatusSql(statusQ))
  }
  if (
    verificationQ === 'pending' ||
    verificationQ === 'verified' ||
    verificationQ === 'not_required'
  ) {
    filters.push(eq(folios.paymentVerification, verificationQ))
    // US-A67 — the "Por verificar" queue is ACTIVE folios awaiting an admin: a rejected payment
    // cancels the folio (its stale 'pending' flag stays), so exclude cancelled to drop it out.
    if (verificationQ === 'pending') filters.push(isNull(folios.cancelledAt))
  }
  if (agentQ) filters.push(eq(folios.agentId, agentQ))

  // US-A78 — refunds still owed. Unknown values fall through to "no filter", matching `status`.
  if (refundStatusQ === 'pending' || refundStatusQ === 'none' || refundStatusQ === 'refunded') {
    // TECH_DEBT #25 — the obligation derives from the line debts.
    filters.push(sql`${deriveRefundStatusSql} = ${refundStatusQ}`)
  }
  // US-A79 — apartados past their settle deadline. DERIVED here, never stored.
  const now = new Date()
  if (overdueQ === 'true') filters.push(overdueFilter(now))

  // The org's zone decides every calendar boundary on this route — the window (US-A84 rule 2) and,
  // since US-A83, the range too.
  const [orgRow] = await db
    .select({ tz: organizations.timezone, noShowMargin: organizations.noShowMarginMinutes })
    .from(organizations)
    .where(eq(organizations.id, org))
    .limit(1)
  const tz = orgRow?.tz ?? 'UTC'
  // US-A85 — the fulfilment axis is DERIVED on read, so the clock and the margin travel with the
  // query rather than being baked into a column. `now` is the one already taken above.
  const fulfillmentCtx = {
    tz,
    marginMinutes: orgRow?.noShowMargin ?? 0,
    nowEpoch: Math.floor(now.getTime() / 1000),
  }

  // US-A83 rule 1 — an inclusive org-local range over `created_at`.
  const range = dateRangeFilter(tz, fromQ, toQ)
  if (range) filters.push(range)
  // US-A83 rule 4 — the five fields a folio gets described by.
  if (hasQuery) filters.push(searchFilter(db, org, normalizedQ))

  // US-A84 rule 1/2 — the union, UNLESS the caller narrowed deliberately. A date range or a query
  // REPLACES the window (US-A83 D11/D12): the caller has named what they want, and applying both
  // would let a search reach into the past and silently return nothing — which is a search with a
  // hidden date filter, exactly what the fallback exists to remove.
  const windowDays = DEFAULT_WINDOW_DAYS
  const windowed = !hasDateFilter && !hasQuery
  if (windowed) {
    filters.push(listWindowFilter(db, org, tz, windowDays, now))
  }

  // US-A84 rule 9 — ONE order, always. The queues used to sort by their own clock (refund debt by
  // age, hold by how long it has sat), which was right when each was its own screen and unreadable
  // once facets compose. Q5's signal — the age — moves onto the card's time chip instead (D10).
  const order = desc(folios.createdAt)

  const rows = await db
    .select({
      id: folios.id,
      agentId: folios.agentId,
      agentName: users.name,
      customerName: folios.customerName,
      customerPhone: folios.customerPhone,
      status: deriveStatusSql, // D11 — derived from the lines; equals the column by construction
      total: folios.total,
      amountPaid: folios.amountPaid,
      createdAt: folios.createdAt,
      cancelledAt: folios.cancelledAt,
      // US-AG07.3/D5 — booking-recovery fields so the admin list can decorate apartado rows
      // (urgency accent, pending balance, WhatsApp reminder) exactly like the agent list.
      bookingExpiresAt: deriveBookingExpiresAtSql,
      reminderStatus: folios.reminderStatus,
      reminderSentAt: folios.reminderSentAt,
      reminderSentBy: folios.reminderSentBy,
      ticketsSentAt: folios.ticketsSentAt,
      ticketsViewedAt: folios.ticketsViewedAt,
      paymentMethod: displayMethodSql,
      paymentReference: folios.paymentReference,
      paymentVerification: folios.paymentVerification,
      operatorName: affiliateOperators.name,
      // US-A78 — the debt itself. The lean row never carried these, so the pending-refunds queue
      // could not show what is owed without a second read per folio.
      refundStatus: deriveRefundStatusSql,
      creditAmount: folios.creditAmount,
      creditExpiresAt: folios.creditExpiresAt,
      refundAmount: deriveRefundAmountSql,
      // US-A82 — no surface may infer Express from a null name (business rule 4).
      saleMode: folios.saleMode,
    })
    .from(folios)
    .innerJoin(users, eq(folios.agentId, users.id))
    .leftJoin(affiliateOperators, eq(folios.operatorId, affiliateOperators.id))
    .where(and(...filters))
    .orderBy(order)
    // US-A83 D6 — a query is an unindexed scan over the whole history, so it gets a ceiling. One
    // extra row is fetched purely to learn whether there were more, without a second COUNT.
    .limit(hasQuery ? SEARCH_LIMIT + 1 : -1)

  const truncated = hasQuery && rows.length > SEARCH_LIMIT
  const page = truncated ? rows.slice(0, SEARCH_LIMIT) : rows

  // US-A82/US-A84 — the card names what was sold, sends the ticket from the list, and marks the
  // folios a customer is waiting on.
  //
  // The decorations normally re-apply `filters` through a join rather than an id list, because D1
  // caps bound parameters and this list is otherwise unbounded (see folioListRows). A SEARCH is the
  // one case where that reverses: the result is capped at 50, so an id list is exactly 50
  // parameters — while re-applying the filters would fetch lines for every folio the query matched
  // and then discard all but the page.
  const decorationFilters = hasQuery
    ? [eq(folios.organizationId, org), inArray(folios.id, page.map((r) => r.id))]
    : filters
  const [linesByFolio, portalLinkByFolio, requestByFolio] = await Promise.all([
    readListLines(db, org, decorationFilters, fulfillmentCtx),
    readListPortalLinks(db, org, decorationFilters, c.env.API_BASE_URL),
    readListCancellationRequests(db, org, decorationFilters),
  ])

  return c.json({
    // US-A84 — what the list covers, so the UI can SAY so rather than imply completeness.
    // US-A83 — null once a range or a query replaced the window: the list is no longer "the last
    // N days", and saying it is would be the same false claim of completeness in reverse.
    window_days: windowed ? windowDays : null,
    // US-A83 D6 — a cap that does not announce itself reports "these are the matches" when it
    // means "these are the first 50".
    truncated,
    // US-AG58 (folio-surface-parity D1/D13) — ONE row serializer, shared with the seller's list.
    folios: page.map((r) =>
      serializeFolioListRow(r, {
        linesByFolio,
        portalLinkByFolio,
        requestByFolio,
        nowMs: now.getTime(),
      }),
    ),
  })
}

// US-A84 (D7) — the pending-work counts, as ONE aggregate.
//
// Replaces five badges that each downloaded a whole filtered list to call `.length` in the browser
// (`useFolios.ts`) — `/folios` fired four unbounded reads per load and `/dashboard` three, one of
// which pulled every paid folio WITH its lines and portal link to produce a single integer.
//
// The counts describe the WHOLE organization and never the loaded window (rule 4). That is what
// lets the list be bounded without the banner lying: `Hoy` says 2 refunds, the destination shows 2,
// even when one was cancelled eight months ago (S-3/S-4).
export const listFolioCounts = async (c: FoliosContext) => {
  const admin = c.get('user')
  const org = admin.organizationId
  const db = getDb(c.env)
  const now = new Date()

  const countWhere = async (predicate: SQL): Promise<number> => {
    const [row] = await db
      .select({ n: sql<number>`count(*)` })
      .from(folios)
      .where(and(eq(folios.organizationId, org), predicate))
    return row?.n ?? 0
  }

  const [verification, refunds, overdue, undelivered, requests] = await Promise.all([
    countWhere(verificationPendingFilter()),
    countWhere(refundPendingFilter()),
    countWhere(overdueFilter(now)),
    countWhere(undeliveredFilter()),
    // Counted over FOLIOS, not over requests: two pending requests on one folio are one folio to
    // act on, and the pill reads "1 Solicitud" beside a list that shows one row.
    countWhere(requestPendingFilter(db, org)),
  ])

  return c.json({
    verification,
    folio_requests: requests,
    refunds,
    overdue,
    undelivered,
  })
}

// US-A21 — one folio's detail (confirm before cancelling). 404 cross-org/unknown.
export const getFolioDetail = async (c: FoliosContext) => {
  const admin = c.get('user')
  const id = c.req.param('id')
  const db = getDb(c.env)

  // US-A93 — the detail GET echoes the access tickets, so the admin can see what the customer is
  // holding. The mutation replies below deliberately do not: they answer "what did I just change".
  const folio = await readFolio(db, admin.organizationId, id, c.env.API_BASE_URL, c.env.QR_SECRET)
  if (!folio) {
    throw new ApiError('NOT_FOUND', 404, 'Folio not found')
  }

  // What cancelling RIGHT NOW would cost — so the confirm sheet states the refund before the admin
  // commits, instead of discovering it afterwards. Pure read: it persists nothing, and it is
  // computed by the same function the cancel endpoint uses, so the number shown is the number
  // written. `null` only for an already-cancelled folio: there is nothing left to quote.
  const quote =
    folio.status === 'cancelled'
      ? null
      : await quoteCancellation(db, admin.organizationId, id, new Date())

  // US-A24 — the narrative rides the detail ("the folio is one object" applies to the API too).
  const events = await readFolioEvents(db, admin.organizationId, id)

  return c.json({
    folio,
    cancellation_quote: quote ? serializeQuote(quote, folio.lines) : null,
    events,
  })
}

export const serializeQuote = (
  o: CancellationOutcome,
  // US-A22 — the per-line ALLOCATED sums (readFolio already computed them), so each line can
  // carry what cancelling IT ALONE would return. Omitted by callers that only need folio totals.
  linesOut?: Array<{ id: string; allocated?: number }>,
) => {
  const allocatedByLine = new Map(
    (linesOut ?? []).map((l) => [l.id, Math.max(0, l.allocated ?? 0)]),
  )
  return {
    refund: o.refund,
    retention: o.retention,
    kept_commission: o.keptCommission,
    reversed_commission: o.reversedCommission,
    lines: o.lines.map((l) => {
      // The single-line SUBSET quote's arithmetic, computed server-side so the ConfirmSheet
      // never derives money (the folioCardState rule): refund = what the line holds minus what
      // the ladder retains of it — pooling of one. Identical to quoteCancellation([lineId]) by
      // construction; null when the caller sent no allocations.
      const allocated = allocatedByLine.get(l.lineId)
      const lineRefund = allocated === undefined ? null : Math.max(0, allocated - l.retention)
      const realRetention = allocated === undefined ? null : allocated - (lineRefund ?? 0)
      const lineReversed =
        realRetention === null
          ? null
          : l.commission - Math.min(l.keptCommission, realRetention)
      return {
        line_id: l.lineId,
        // Rounded for display; the decision itself used the exact value.
        hours_out: Number.isFinite(l.hoursOut) ? Math.round(l.hoursOut) : null,
        refund_pct: l.refundPct,
        retention: l.retention,
        redeemed: l.redeemed,
        line_refund: lineRefund,
        line_reversed_commission: lineReversed,
      }
    }),
  }
}

// POST /folios/:id/ticket-delivery — the admin records the tickets were sent over WhatsApp
// (whatsapp-qr-delivery D4/D13). Org-scoped (any folio in the org, no agent filter). Last-write-wins.
export const markTicketsSentAdmin = async (c: FoliosContext) => {
  const admin = c.get('user')
  const id = c.req.param('id')
  const db = getDb(c.env)
  const now = new Date()

  const updated = await db
    .update(folios)
    .set({ ticketsSentAt: now, ticketsSentBy: admin.userId, updatedAt: now })
    .where(and(eq(folios.id, id), eq(folios.organizationId, admin.organizationId)))
    .returning({ sentAt: folios.ticketsSentAt, viewedAt: folios.ticketsViewedAt })

  const row = updated[0]
  if (!row) throw new ApiError('NOT_FOUND', 404, 'Folio not found')
  // US-A24 — EACH send appends a row (the column is last-write-wins; the narrative is not).
  await folioEventRow(db, {
    organizationId: admin.organizationId,
    folioId: id,
    type: 'tickets_sent',
    actorId: admin.userId,
    at: now,
  })
  return c.json({
    tickets_sent_at: tsOrNull(row.sentAt),
    tickets_viewed_at: tsOrNull(row.viewedAt),
  })
}

// The cancellation commit (US-A21), shared by the direct admin cancel and the
// tourist-request approval — ONE cancellation path, two entrances. Two steps in
// race-safe order (BUG-013):
//   1. Flip the FOLIO first with a guarded UPDATE (`status != 'cancelled'`); RETURNING
//      tells us whether WE won. A concurrent cancellation loses here and releases nothing.
//   2. Only the winner releases the seats, per line `booked = MAX(0, booked − quantity)`
//      (clamped so a manually edited counter can never go negative), in one batch.
// The reversed order (seats in the same batch as the guarded flip) double-released seats
// when two cancellations raced: a 0-row guarded UPDATE does not abort a D1 batch, so the
// loser's seat decrements still applied. Residual: a crash between 1 and 2 leaves seats
// booked on a cancelled folio — conservative (no oversell), same compensate-style
// trade-off as POS confirm.
//
// BUG — a ZONED line (US-A64) releases its seats on `slot_zones`, then reconciles the slot
// totals from the zone sums; decrementing `slots.booked` directly would be overwritten by the
// next reconcile and leave the zone counter permanently inflated (its seats unsellable
// forever). Every other release site already branched on `zone_id` (`cancelBooking`,
// `rejectPayment`, `sweepExpiredBookings`); this one — the MANUAL cancellation path — did not.
const applyCancellation = async (
  db: Db,
  org: string,
  folioId: string,
  lines: Array<{ slotId: string | null; quantity: number; zoneId: string | null }>,
  now: Date,
  folioUpdate: Partial<typeof folios.$inferInsert>,
  // Cancellation Policy Engine — how much of the collected money and commission to reverse. OMITTED
  // (no policy configured) means "reverse everything", the pre-feature behaviour (D1).
  reversal?: { refundAmount: number; reversedCommission: number },
): Promise<boolean> => {
  // The agent whose ledger the cancellation reversal (US-LG05/LG06) attributes to.
  const [meta] = await db
    .select({ agentId: folios.agentId })
    .from(folios)
    .where(and(eq(folios.id, folioId), eq(folios.organizationId, org)))
    .limit(1)

  const won = await db
    .update(folios)
    .set({ ...folioUpdate, updatedAt: now })
    .where(
      and(
        eq(folios.id, folioId),
        eq(folios.organizationId, org),
        // TECH_DEBT #25 — cancelled_at is the flip guard now: the full cancellation is the only
        // writer of the folio-level stamp, so its NULLness carries exactly ne(status,'cancelled').
        isNull(folios.cancelledAt),
      ),
    )
    .returning({ id: folios.id })
  if (won.length === 0) return false

  const statements: BatchItem<'sqlite'>[] = []

  // US-A22 (line-autonomy, D1's written half + D6) — a TOTAL cancellation stamps every live line
  // with the same facts the folio records, and distributes the refund obligation across them
  // pro-rata to the money each line actually holds (its positive allocations), floors + remainder
  // to the heaviest — the exact rule migration 0063 used to backfill pre-feature cancellations,
  // so a folio cancelled yesterday and one cancelled today read identically.
  const liveLines = await db
    .select({
      id: folioLines.id,
      slotDate: folioLines.slotDate,
      slotStartTime: folioLines.slotStartTime,
      checkIn: folioLines.checkIn,
      lineTotal: folioLines.lineTotal,
      allocated: sql<number>`coalesce((select sum(a.amount) from folio_payment_allocations a where a.folio_line_id = folio_lines.id and a.amount > 0), 0)`,
    })
    .from(folioLines)
    .where(
      and(
        eq(folioLines.folioId, folioId),
        eq(folioLines.organizationId, org),
        sql`${folioLines.cancelledAt} is null`,
      ),
    )
  const refundShares = new Map(
    prorateByWeight(
      orderForCascade(liveLines).map((l) => ({
        folioLineId: l.id,
        weight: Math.max(0, Number(l.allocated ?? 0)),
      })),
      // TECH_DEBT #25 — the obligation no longer travels on `folioUpdate` (the folio columns are
      // gone): `reversal.refundAmount` IS the amount owed, and the lines are where it lands.
      reversal?.refundAmount ?? 0,
    ).map((s) => [s.folioLineId, s.amount]),
  )
  for (const line of liveLines) {
    const share = refundShares.get(line.id) ?? 0
    statements.push(
      db
        .update(folioLines)
        .set({
          cancelledAt: now,
          cancelledBy: folioUpdate.cancelledBy ?? null,
          cancellationSource: folioUpdate.cancellationSource ?? null,
          ...(share > 0 ? { refundStatus: 'pending' as const, refundAmount: share } : {}),
        })
        .where(
          and(
            eq(folioLines.id, line.id),
            eq(folioLines.organizationId, org),
            sql`${folioLines.cancelledAt} is null`,
          ),
        ),
    )
  }

  for (const line of lines) {
    if (!line.slotId) continue // a lodging stay line has no slot (released via reservations below)
    if (line.zoneId) {
      // Zoned: the zone counter is authoritative; `slots.booked` is re-derived from the zone
      // sums by the reconcile, which must run in the SAME batch (US-A64, zones.reconcile).
      statements.push(
        db
          .update(slotZones)
          .set({
            booked: sql`MAX(0, ${slotZones.booked} - ${line.quantity})`,
            updatedAt: now,
          })
          .where(
            and(
              eq(slotZones.slotId, line.slotId),
              eq(slotZones.zoneId, line.zoneId),
              eq(slotZones.organizationId, org),
            ),
          ),
        reconcileSlotTotals(db, line.slotId),
      )
    } else {
      statements.push(
        db
          .update(slots)
          .set({
            booked: sql`MAX(0, ${slots.booked} - ${line.quantity})`,
            updatedAt: now,
          })
          .where(and(eq(slots.id, line.slotId), eq(slots.organizationId, org))),
      )
    }
  }

  // US-LG — reverse the collected money per method + (on clawback) the commission, dated at the
  // cancellation, so the folio drops out of the ledger buckets exactly as status-exclusion did.
  if (meta) {
    const reversalRows = await buildCancellationReversal(db, {
      organizationId: org,
      folioId,
      collectedBy: meta.agentId,
      at: now,
      clawback: folioUpdate.cancellationClawback === true,
      ...(reversal
        ? {
            refundAmount: reversal.refundAmount,
            reversedCommission: reversal.reversedCommission,
          }
        : {}),
    })
    statements.push(...reversalRows)
  }
  // Lodging: release any stay reservations on this folio (US-A21 / tourist-approved cancel).
  statements.push(
    db
      .update(accommodationReservations)
      .set({ status: 'cancelled', updatedAt: now })
      .where(
        and(
          eq(accommodationReservations.folioId, folioId),
          eq(accommodationReservations.organizationId, org),
          eq(accommodationReservations.status, 'active'),
        ),
      ),
  )
  // US-A24 — the narrative row, derived from the same folioUpdate the flip wrote, so the event and
  // the audit columns can never disagree. It rides the WINNER's batch: only the guarded flip's
  // winner reaches this point, so a racing cancellation can never write a second `cancelled` row.
  // This one edit covers every cancelFolioPriced entrance: admin (US-A21), agent apartado,
  // tourist-request approval, and the expiry sweep (cancelled_by NULL renders "Sistema").
  statements.push(
    folioEventRow(db, {
      organizationId: org,
      folioId,
      type: 'cancelled',
      actorId: folioUpdate.cancelledBy ?? null,
      payload: {
        source: folioUpdate.cancellationSource,
        reason: folioUpdate.cancellationReason,
        clawback: folioUpdate.cancellationClawback === true,
        refund_amount: folioUpdate.refundAmount,
        credit_amount: folioUpdate.creditAmount,
      },
      at: now,
    }),
  )
  await db.batch(statements as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]])
  return true
}

// Cancellation Policy Engine — price a cancellation, or decide there is no policy to price it with.
// Spec: docs/cancellation/cancellation-policy-engine.spec.md
//
// THE single place a policy is resolved and applied, shared by the admin cancel, the tourist-request
// approval, and the read-only quote on folio detail. Before this existed the two cancellation paths
// disagreed about the same folio — the admin one recorded no refund for a tour while the tourist one
// refunded everything. Routing both through here is what makes that impossible rather than merely
// fixed.
//
// D17 — this ALWAYS returns an outcome. Phase 1 returned null for an org with no policy and the
// caller fell back to a legacy branch; both the null and the branch are gone. `null` here now means
// only "no such folio", which callers check before ever getting this far.
export const quoteCancellation = async (
  db: Db,
  org: string,
  folioId: string,
  now: Date,
  // US-A22 — price a SUBSET of the folio's lines. The pooling the engine does folio-wide (D3's
  // "a deposit against a retention refunds nothing") applies WITHIN the subset: the money
  // considered is what is allocated to those lines, and the booked commission is their
  // reconciled share. For the full set this reproduces the folio-level numbers exactly, because
  // Σ allocations = amount_paid (US-LG09 rule 1).
  lineIds?: string[],
): Promise<CancellationOutcome> => {
  const [folio] = await db
    .select({
      amountPaid: folios.amountPaid,
      commissionAmount: folios.commissionAmount,
      snapshot: folios.cancellationPolicySnapshot,
      affiliateCompanyId: folios.affiliateCompanyId,
    })
    .from(folios)
    .where(and(eq(folios.id, folioId), eq(folios.organizationId, org)))
    .limit(1)
  if (!folio) {
    // Unreachable from the handlers, which 404 on a missing folio first. Throwing rather than
    // returning a fake outcome keeps "priced by nothing" from being representable.
    throw new ApiError('NOT_FOUND', 404, 'Folio not found')
  }

  const [orgRow] = await db
    .select({ policy: organizations.cancellationPolicy, timezone: organizations.timezone })
    .from(organizations)
    .where(eq(organizations.id, org))
    .limit(1)

  // D6 — the folio's own snapshot wins; the org's live ladder is the fallback for folios sold
  // before the feature. D17 — if neither exists, the module default applies, so this never fails.
  const policy = resolvePolicy(folio.snapshot, orgRow?.policy)

  const lines = await db
    .select({
      id: folioLines.id,
      lineTotal: folioLines.lineTotal,
      quantity: folioLines.quantity,
      redeemedCount: folioLines.redeemedCount,
      commissionType: folioLines.commissionType,
      commissionValue: folioLines.commissionValue,
      lineType: folioLines.lineType,
      slotDate: folioLines.slotDate,
      slotStartTime: folioLines.slotStartTime,
      checkIn: folioLines.checkIn,
    })
    .from(folioLines)
    .where(and(eq(folioLines.folioId, folioId), eq(folioLines.organizationId, org)))

  const nowEpoch = Math.floor(now.getTime() / 1000)
  const timezone = orgRow?.timezone ?? 'America/Mexico_City'
  // D12 — an affiliate sale is already stamped on the folio (US-A51), so which of the tier's two
  // commission percentages applies needs no join.
  const sellerKind = folio.affiliateCompanyId ? ('affiliate' as const) : ('agent' as const)

  if (lineIds === undefined) {
    return computeCancellationRefund({
      policy,
      lines,
      amountPaid: folio.amountPaid,
      nowEpoch,
      timezone,
      sellerKind,
      // The authoritative commission the sale booked. Only differs from the per-line sum for folios
      // sold before `0028` snapshotted commission onto lines; without it those would forfeit nothing.
      bookedCommission: folio.commissionAmount,
    })
  }

  // US-A22 — the subset's money is what its allocations say it holds (net: payments minus any
  // prior reversal), and its commission is its reconciled share of what the folio booked — the
  // same lineCommissions rule the engine itself applies, so the split exists once.
  const subset = lines.filter((l) => lineIds.includes(l.id))
  const shares = lineCommissions(lines, folio.commissionAmount)
  const subsetBooked = lines.reduce(
    (s, l, i) => (lineIds.includes(l.id) ? s + shares[i]! : s),
    0,
  )
  const allocRows = await db
    .select({
      folioLineId: folioPaymentAllocations.folioLineId,
      net: sql<number>`coalesce(sum(${folioPaymentAllocations.amount}), 0)`,
    })
    .from(folioPaymentAllocations)
    .where(
      and(
        eq(folioPaymentAllocations.organizationId, org),
        inArray(folioPaymentAllocations.folioLineId, lineIds),
      ),
    )
    .groupBy(folioPaymentAllocations.folioLineId)
  const subsetPaid = allocRows.reduce((s, r) => s + Math.max(0, Number(r.net ?? 0)), 0)

  return computeCancellationRefund({
    policy,
    lines: subset,
    amountPaid: subsetPaid,
    nowEpoch,
    timezone,
    sellerKind,
    bookedCommission: subsetBooked,
  })
}

// The realised numbers a cancellation returns, so the client can state what just happened without
// re-deriving it. (US-A71's company-cancellation override lived here in Phase 1; it is withdrawn —
// D10. Nothing overrides the ladder any more.)
const serializeOutcome = (o: CancellationOutcome) => ({
  refund: o.refund,
  retention: o.retention,
  kept_commission: o.keptCommission,
  reversed_commission: o.reversedCommission,
})

// The folio fields a priced cancellation writes. Refund obligation and PIN follow the MONEY, not
// the path that produced it (spec Rules 3–4): any cancellation that owes the customer something
// mints a PIN, because a tourist owed money must be able to prove they were present to receive it
// regardless of who pressed cancel.
const refundFieldsFor = (outcome: CancellationOutcome): Partial<typeof folios.$inferInsert> =>
  // TECH_DEBT #25 — the obligation itself lives on the LINES (applyCancellation distributes it);
  // the folio keeps only the PIN, which is person-scoped by design (D6).
  outcome.refund > 0 ? { refundPin: generateRefundPin() } : {}

// Cancel a folio at the ladder's price: quote it, flip it, release its inventory, reverse its money.
//
// The entrances differ ONLY in who is recorded as having cancelled and why:
//   * admin (US-A21)                    — the admin cancels a folio outright
//   * tourist_request (US-T04)          — an admin approves a tourist's request
//   * agent (US-AG07.4)                 — an agent cancels an apartado from the POS
//   * system_expiry (US-A74/A77)        — the sweep releases an apartado at its grace instant
//
// Everything that touches money — the price, the refund obligation, the PIN, the clawback flag, the
// proportional ledger reversal — is derived HERE, so no entrance can express a different opinion
// about the same folio. That is the whole point of the engine: the original defect was two paths
// answering differently, and the agent path was a third answering differently again (it retained the
// deposit unconditionally and reversed the collected money in full, which left cash in a drawer that
// no report accounted for). Adding a fourth entrance means passing a different `source`, nothing else.
//
// Returns `won: false` when a concurrent cancellation won the guarded flip; the caller decides what
// that means for its own bookkeeping.
export const cancelFolioPriced = async (
  db: Db,
  org: string,
  folioId: string,
  lines: Array<{ slotId: string | null; quantity: number; zoneId: string | null }>,
  now: Date,
  by: {
    cancelledBy: string | null
    reason: string | null
    source: 'admin' | 'agent' | 'tourist_request' | 'system_expiry'
  },
): Promise<{ won: boolean; outcome: CancellationOutcome }> => {
  const outcome = await quoteCancellation(db, org, folioId, now)
  const won = await applyCancellation(
    db,
    org,
    folioId,
    lines,
    now,
    {
      // TECH_DEBT #25 — status is derived; cancelled_at is both the fact and the flip guard.
      cancelledAt: now,
      cancelledBy: by.cancelledBy,
      cancellationReason: by.reason,
      // Derived, never chosen (D10). The flag keeps its meaning for every existing reader — the
      // cash engine and the commission report both ask "was any commission taken back".
      cancellationClawback: outcome.reversedCommission > 0,
      cancellationSource: by.source,
      ...refundFieldsFor(outcome),
    },
    { refundAmount: outcome.refund, reversedCommission: outcome.reversedCommission },
  )
  return { won, outcome }
}

// Fire-and-forget cancellation email — a Resend failure must never fail a committed
// cancellation. waitUntil guarantees the send completes after the response returns (a bare
// floating promise can be cancelled when the Worker returns, silently dropping the email).
//
// The context and folio are STRUCTURAL rather than the admin's concrete types, so the agent's
// apartado cancel can send the same email. That path never sent one — tolerable while it never
// owed anybody money, and not tolerable now that it can open a refund obligation (US-A76): a
// customer owed cash has to learn about it from something other than a phone call that may not
// happen. Both POS and admin contexts satisfy `{ env, executionCtx }`.
export const queueCancellationEmail = async (
  c: { env: CloudflareBindings; executionCtx: ExecutionContext },
  db: Db,
  org: string,
  folioId: string,
  folioOut: {
    customer_email: string | null
    customer_name: string | null
    cancellation_reason?: string | null
    lines: Array<{
      service_name: string
      slot_date: string | null
      slot_start_time: string | null
      quantity: number
    }>
  },
) => {
  if (!folioOut.customer_email || !c.env.RESEND_API_KEY) return

  const orgRows = await db
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, org))
    .limit(1)
  const orgName = orgRows[0]?.name ?? 'Turistear Ya!'

  const emailData: CancellationEmailInput = {
    to: folioOut.customer_email,
    customerName: folioOut.customer_name,
    orgName,
    folioId,
    cancelledAt: new Date(),
    cancellationReason: folioOut.cancellation_reason ?? null,
    lines: folioOut.lines.map((l) => ({
      serviceName: l.service_name,
      slotDate: l.slot_date,
      slotStartTime: l.slot_start_time,
      quantity: l.quantity,
    })),
  }

  // The send stays here; what changed is that its OUTCOME is recorded (US-A86). A Resend outage
  // used to vanish into a console line — the outbox now carries `failed` with the error, so the
  // one notification a customer gets is never silently consumed.
  c.executionCtx.waitUntil(
    sendCancellationEmail(c.env, emailData)
      .then(() => recordEmailOutcome(db, org, folioId, 'cancellation_approved', { ok: true }))
      .catch((err) => {
        console.error('[email] cancellation send failed', folioId, err)
        return recordEmailOutcome(db, org, folioId, 'cancellation_approved', {
          ok: false,
          error: String(err),
        })
      }),
  )
}

// US-A21 — cancel the whole folio: release every line's spots and record the cancellation.
//
// D1 has no interactive transactions, so the release + flip is one atomic batch (rolls back
// as a unit). A pre-check returns 409 for an already-cancelled folio so spots are never
// released twice. Tickets follow status — the scanner's CANCELLED gate handles them.
export const cancelFolio = async (c: FoliosContext) => {
  const admin = c.get('user')
  const org = admin.organizationId
  const id = c.req.param('id')
  const input = (await c.req.json().catch(() => ({}))) as CancelFolioInput
  const db = getDb(c.env)

  const folioRows = await db
    .select({
      id: folios.id,
      status: deriveStatusSql,
      paymentVerification: folios.paymentVerification,
    })
    .from(folios)
    .where(and(eq(folios.id, id), eq(folios.organizationId, org)))
    .limit(1)

  const folio = folioRows[0]
  if (!folio) {
    throw new ApiError('NOT_FOUND', 404, 'Folio not found')
  }
  if (folio.status === 'cancelled') {
    throw new ApiError('CONFLICT', 409, 'This folio is already cancelled')
  }
  // BUG-030 — the ladder would price `amount_paid`, which counts the unconfirmed transfer, and
  // `refundFieldsFor` would mint a cash-refund PIN for money that may never have arrived. The
  // cancel path for unconfirmed money is `rejectPayment` (no refund, clawback); this entrance
  // refuses until the money is decided. The sweep is untouched: it enters via `cancelFolioPriced`.
  if (folio.paymentVerification === 'pending') {
    throw new ApiError(
      'PAYMENT_UNVERIFIED',
      409,
      'El pago está por verificar — verifica o rechaza el pago antes de cancelar',
    )
  }

  const lines = await db
    .select({
      slotId: folioLines.slotId,
      quantity: folioLines.quantity,
      zoneId: folioLines.zoneId,
      lineType: folioLines.lineType,
      lineTotal: folioLines.lineTotal,
      checkIn: folioLines.checkIn,
    })
    .from(folioLines)
    .where(and(eq(folioLines.folioId, id), eq(folioLines.organizationId, org)))

  const now = new Date()

  // D17 — the ladder prices every cancellation. There is no second path: the legacy branch (a
  // lodging-only refund for stays, nothing at all for tours) was deleted in Phase 2, and
  // `quoteCancellation` always returns an outcome because `resolvePolicy` always resolves.
  const { won, outcome } = await cancelFolioPriced(db, org, id, lines, now, {
    cancelledBy: admin.userId,
    reason: input.reason ?? null,
    source: 'admin',
  })
  if (!won) {
    // A concurrent cancellation won the guarded flip after our pre-check.
    throw new ApiError('CONFLICT', 409, 'This folio is already cancelled')
  }

  const folioOut = await readFolio(db, org, id)
  if (folioOut) await queueCancellationEmail(c, db, org, id, folioOut)

  return c.json({ folio: folioOut, cancellation: serializeOutcome(outcome) })
}

// US-A22 / US-AG54 (docs/folios/line-autonomy.spec.md) — THE subset commit: cancel some of a
// folio's lines, the rest byte-identical. One implementation for its three entrances — the
// admin's line cancel, the agent's apartado line cancel, and the expiry sweep — exactly as
// cancelFolioPriced is for total cancellations: no entrance can express a different opinion
// about the same lines.
//
// Race-safe order (BUG-013): guarded per-line flips FIRST — a racing cancel loses a flip and
// that line is excluded before anything is priced against it — then the winner's batch releases
// inventory, reverses money (allocations scoped to the winners), rolls the folio up from its
// lines, and flips the folio itself only when no live line remains.
//
// `creditInsteadOfRefund` is the sweep's mode (US-A87): a clock-produced close has nobody
// standing there to hand cash to, so what the ladder does not retain accrues as CREDIT — no
// refund obligation, no PIN — and the folio's hold clock re-rolls to the surviving lines' MIN.
export const cancelFolioLinesPriced = async (
  db: Db,
  org: string,
  folioId: string,
  lineIds: string[],
  now: Date,
  by: {
    cancelledBy: string | null
    reason: string | null
    source: 'admin' | 'agent' | 'tourist_request' | 'system_expiry'
  },
  opts?: { creditInsteadOfRefund?: { validDays: number } },
): Promise<{ won: boolean; outcome: CancellationOutcome; cancelledLineIds: string[] }> => {
  const [folioMeta] = await db
    .select({ agentId: folios.agentId })
    .from(folios)
    .where(and(eq(folios.id, folioId), eq(folios.organizationId, org)))
    .limit(1)
  if (!folioMeta) throw new ApiError('NOT_FOUND', 404, 'Folio not found')
  const credit = opts?.creditInsteadOfRefund ?? null

  const targetLines = await db
    .select({
      id: folioLines.id,
      slotId: folioLines.slotId,
      quantity: folioLines.quantity,
      zoneId: folioLines.zoneId,
      lineType: folioLines.lineType,
      unitTypeId: folioLines.unitTypeId,
      checkIn: folioLines.checkIn,
      checkOut: folioLines.checkOut,
      serviceName: folioLines.serviceName,
      slotDate: folioLines.slotDate,
      slotStartTime: folioLines.slotStartTime,
      cancelledAt: folioLines.cancelledAt,
      allocated: sql<number>`coalesce((select sum(a.amount) from folio_payment_allocations a where a.folio_line_id = folio_lines.id and a.amount > 0), 0)`,
    })
    .from(folioLines)
    .where(
      and(
        eq(folioLines.folioId, folioId),
        eq(folioLines.organizationId, org),
        inArray(folioLines.id, lineIds),
      ),
    )
  const liveTargets = targetLines.filter((l) => !l.cancelledAt)
  if (liveTargets.length === 0) {
    return {
      won: false,
      outcome: await quoteCancellation(db, org, folioId, now, lineIds),
      cancelledLineIds: [],
    }
  }

  const liveIds = liveTargets.map((l) => l.id)
  const outcome = await quoteCancellation(db, org, folioId, now, liveIds)
  const shares = new Map(
    prorateByWeight(
      orderForCascade(liveTargets).map((l) => ({
        folioLineId: l.id,
        weight: Math.max(0, Number(l.allocated ?? 0)),
      })),
      outcome.refund,
    ).map((s) => [s.folioLineId, s.amount]),
  )

  // 1. Guarded per-line flips. In credit mode the remainder never becomes a cash obligation, so
  //    the refund fields stay untouched (the credit accrues on the folio below).
  const winners: typeof liveTargets = []
  for (const line of liveTargets) {
    const share = shares.get(line.id) ?? 0
    const flip = await db
      .update(folioLines)
      .set({
        cancelledAt: now,
        cancelledBy: by.cancelledBy,
        cancellationSource: by.source,
        ...(share > 0 && !credit
          ? { refundStatus: 'pending' as const, refundAmount: share }
          : {}),
      })
      .where(
        and(
          eq(folioLines.id, line.id),
          eq(folioLines.organizationId, org),
          sql`${folioLines.cancelledAt} is null`,
        ),
      )
      .returning({ id: folioLines.id })
    if (flip.length > 0) winners.push(line)
  }
  if (winners.length === 0) return { won: false, outcome, cancelledLineIds: [] }
  // Residual: a race that took SOME of the targets leaves the outcome priced over the full live
  // set — the same pre-check-then-commit residual every cancellation path accepts.

  // 2. The winners' batch.
  const statements: BatchItem<'sqlite'>[] = []
  for (const line of winners) {
    if (line.slotId && line.zoneId) {
      statements.push(
        db
          .update(slotZones)
          .set({ booked: sql`MAX(0, ${slotZones.booked} - ${line.quantity})`, updatedAt: now })
          .where(
            and(
              eq(slotZones.slotId, line.slotId),
              eq(slotZones.zoneId, line.zoneId),
              eq(slotZones.organizationId, org),
            ),
          ),
        reconcileSlotTotals(db, line.slotId),
      )
    } else if (line.slotId) {
      statements.push(
        db
          .update(slots)
          .set({ booked: sql`MAX(0, ${slots.booked} - ${line.quantity})`, updatedAt: now })
          .where(and(eq(slots.id, line.slotId), eq(slots.organizationId, org))),
      )
    } else if (line.lineType === 'stay' && line.unitTypeId) {
      // A stay line's inventory is its reservation row, matched by the stay's own coordinates
      // (the reservations table predates line autonomy and carries no folio_line_id).
      statements.push(
        db
          .update(accommodationReservations)
          .set({ status: 'cancelled', updatedAt: now })
          .where(
            and(
              eq(accommodationReservations.folioId, folioId),
              eq(accommodationReservations.organizationId, org),
              eq(accommodationReservations.unitTypeId, line.unitTypeId),
              eq(accommodationReservations.checkIn, line.checkIn ?? ''),
              eq(accommodationReservations.checkOut, line.checkOut ?? ''),
              eq(accommodationReservations.status, 'active'),
            ),
          ),
      )
    }
  }

  statements.push(
    ...(await buildCancellationReversal(db, {
      organizationId: org,
      folioId,
      collectedBy: folioMeta.agentId,
      at: now,
      clawback: outcome.reversedCommission > 0,
      refundAmount: outcome.refund,
      reversedCommission: outcome.reversedCommission,
      lineIds: winners.map((l) => l.id),
    })),
  )

  // The folio-level roll-up while the columns live (D11's honesty rule): the refund obligation is
  // Σ of its pending lines (one PIN, minted once) — or, in credit mode, the remainder ACCRUES as
  // credit with a fresh expiry. Either way the hold clock re-rolls to the surviving live lines'
  // MIN, so the settle guard and the sweep keep reading a truthful folio.
  statements.push(
    db
      .update(folios)
      .set({
        ...(outcome.reversedCommission > 0 ? { cancellationClawback: true } : {}),
        // TECH_DEBT #25 — the obligation and the clock LIVE on the lines now; only the PIN
        // (folio-scoped by design, D6) and the credit accrual still write here.
        ...(outcome.refund > 0 && !credit
          ? { refundPin: sql`coalesce(${folios.refundPin}, ${generateRefundPin()})` }
          : {}),
        ...(outcome.refund > 0 && credit
          ? {
              creditAmount: sql`${folios.creditAmount} + ${outcome.refund}`,
              creditExpiresAt: new Date(now.getTime() + credit.validDays * 86_400_000),
            }
          : {}),
        updatedAt: now,
      })
      .where(and(eq(folios.id, folioId), eq(folios.organizationId, org))),
    // The folio itself flips only when no live line remains — then it IS a total cancellation
    // and every existing reader stays truthful.
    db
      .update(folios)
      .set({
        cancelledAt: now,
        cancelledBy: by.cancelledBy,
        cancellationSource: by.source,
        cancellationReason: by.reason,
      })
      .where(
        and(
          eq(folios.id, folioId),
          eq(folios.organizationId, org),
          isNull(folios.cancelledAt),
          sql`not exists (select 1 from folio_lines fl where fl.folio_id = ${folioId} and fl.cancelled_at is null)`,
        ),
      ),
  )
  // The narrative names each line (D13/D9) — payload identity, never a join.
  for (const line of winners) {
    statements.push(
      folioEventRow(db, {
        organizationId: org,
        folioId,
        type: 'cancelled',
        actorId: by.cancelledBy,
        folioLineId: line.id,
        payload: {
          source: by.source,
          reason: by.reason,
          clawback: outcome.reversedCommission > 0,
          refund_amount: credit ? 0 : (shares.get(line.id) ?? 0),
          credit_amount: credit ? (shares.get(line.id) ?? 0) : undefined,
          line: {
            service_name: line.serviceName,
            slot_date: line.slotDate,
            slot_start_time: line.slotStartTime,
            check_in: line.checkIn,
          },
        },
        at: now,
      }),
    )
  }
  await db.batch(statements as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]])
  return { won: true, outcome, cancelledLineIds: winners.map((l) => l.id) }
}

// US-A22 (docs/folios/line-autonomy.spec.md, F2) — cancel ONE line; the siblings come out
// byte-identical. Priced by the same quote the total cancellation uses, restricted to the line
// (subset pooling over its allocated money); committed through cancelFolioLinesPriced, the same
// commit the agent's apartado line cancel and the expiry sweep use.
export const cancelFolioLine = async (c: FoliosContext) => {
  const admin = c.get('user')
  const org = admin.organizationId
  const id = c.req.param('id')
  const lineId = c.req.param('lineId')
  const input = (await c.req.json().catch(() => ({}))) as CancelFolioInput
  const db = getDb(c.env)

  const folioRows = await db
    .select({
      id: folios.id,
      status: deriveStatusSql,
      paymentVerification: folios.paymentVerification,
      agentId: folios.agentId,
      customerEmail: folios.customerEmail,
    })
    .from(folios)
    .where(and(eq(folios.id, id), eq(folios.organizationId, org)))
    .limit(1)
  const folio = folioRows[0]
  if (!folio) throw new ApiError('NOT_FOUND', 404, 'Folio not found')
  if (folio.status === 'cancelled') {
    throw new ApiError('CONFLICT', 409, 'This folio is already cancelled')
  }
  // BUG-030 parity — unconfirmed money is decided via verify/reject, never priced by the ladder.
  if (folio.paymentVerification === 'pending') {
    throw new ApiError(
      'PAYMENT_UNVERIFIED',
      409,
      'El pago está por verificar — verifica o rechaza el pago antes de cancelar',
    )
  }

  const lineRows = await db
    .select({ id: folioLines.id, cancelledAt: folioLines.cancelledAt })
    .from(folioLines)
    .where(and(eq(folioLines.id, lineId), eq(folioLines.folioId, id), eq(folioLines.organizationId, org)))
    .limit(1)
  const line = lineRows[0]
  // Cross-org and wrong-folio land here indistinguishably: a 404, never a 403 (S-14).
  if (!line) throw new ApiError('FOLIO_LINE_NOT_FOUND', 404, 'Line not found in this folio')
  if (line.cancelledAt) {
    throw new ApiError('LINE_ALREADY_CANCELLED', 409, 'This line is already cancelled')
  }

  const now = new Date()
  const { won, outcome } = await cancelFolioLinesPriced(db, org, id, [lineId], now, {
    cancelledBy: admin.userId,
    reason: input.reason ?? null,
    source: 'admin',
  })
  if (!won) {
    throw new ApiError('LINE_ALREADY_CANCELLED', 409, 'This line is already cancelled')
  }

  // Written notice (D20), line-scoped (D13): a second line's cancellation months later is a
  // second message — the guard keyed by (folio, line, event, channel) cannot swallow it.
  await emitNotification(db, {
    organizationId: org,
    folioId: id,
    event: 'cancellation_approved',
    hasEmail: !!folio.customerEmail,
    folioLineId: lineId,
  })

  const folioOut = await readFolio(db, org, id)
  if (folioOut) {
    await queueCancellationEmail(c, db, org, id, {
      ...folioOut,
      lines: folioOut.lines.filter((l) => l.id === lineId),
    })
  }
  return c.json({ folio: folioOut, cancellation: serializeOutcome(outcome) })
}

// --- Tourist cancellation requests (US-T04) + refund tracking (US-A23/US-T05) ---
// Spec: docs/tourist-portal/tourist-self-service-portal.spec.md

const serializeRequest = (r: {
  id: string
  folioId: string
  status: 'pending' | 'approved' | 'rejected'
  reason: string | null
  resolutionNote: string | null
  resolvedBy: string | null
  resolvedAt: Date | null
  createdAt: Date
}) => ({
  id: r.id,
  folio_id: r.folioId,
  status: r.status,
  reason: r.reason,
  resolution_note: r.resolutionNote,
  resolved_by: r.resolvedBy,
  resolved_at: tsOrNull(r.resolvedAt),
  created_at: Math.floor(r.createdAt.getTime() / 1000),
})

// US-T04 (D7) — the admin review queue. Defaults to status=pending (the actionable set);
// `?status=all|approved|rejected` for history. Each row carries enough folio context to
// decide without opening the detail: customer, totals, the tourist's reason.
export const listCancellationRequests = async (c: FoliosContext) => {
  const admin = c.get('user')
  const org = admin.organizationId
  const db = getDb(c.env)

  const statusQ = c.req.query('status')
  const filters = [eq(folioRequests.organizationId, org)]
  if (statusQ === 'approved' || statusQ === 'rejected' || statusQ === 'pending') {
    filters.push(eq(folioRequests.status, statusQ))
  } else if (statusQ !== 'all') {
    filters.push(eq(folioRequests.status, 'pending'))
  }

  const rows = await db
    .select({
      id: folioRequests.id,
      folioId: folioRequests.folioId,
      status: folioRequests.status,
      reason: folioRequests.reason,
      resolutionNote: folioRequests.resolutionNote,
      resolvedBy: folioRequests.resolvedBy,
      resolvedAt: folioRequests.resolvedAt,
      createdAt: folioRequests.createdAt,
      customerName: folios.customerName,
      folioStatus: deriveStatusSql,
      total: folios.total,
      amountPaid: folios.amountPaid,
    })
    .from(folioRequests)
    .innerJoin(folios, eq(folioRequests.folioId, folios.id))
    .where(and(...filters))
    .orderBy(desc(folioRequests.createdAt))

  return c.json({
    requests: rows.map((r) => ({
      ...serializeRequest(r),
      folio: {
        id: r.folioId,
        customer_name: r.customerName,
        status: r.folioStatus,
        total: r.total,
        amount_paid: r.amountPaid,
      },
    })),
  })
}

// Load one request scoped to the caller's org. 404 unknown/cross-org (no existence leak).
const loadRequest = async (db: Db, org: string, requestId: string) => {
  const [request] = await db
    .select({
      id: folioRequests.id,
      folioId: folioRequests.folioId,
      status: folioRequests.status,
      reason: folioRequests.reason,
      // US-AG52 — a reschedule petition carries where it wants to go.
      kind: folioRequests.kind,
      folioLineId: folioRequests.folioLineId,
      toSlotId: folioRequests.toSlotId,
    })
    .from(folioRequests)
    .where(
      and(
        eq(folioRequests.id, requestId),
        eq(folioRequests.organizationId, org),
      ),
    )
    .limit(1)
  if (!request) {
    throw new ApiError('NOT_FOUND', 404, 'Cancellation request not found')
  }
  return request
}

// US-AG52 — approving a tourist's reschedule. Separated from the cancellation approval rather than
// branched inside it: they share a table and a queue, not a body.
const approveRescheduleRequest = async (
  c: FoliosContext,
  db: Db,
  org: string,
  actorId: string,
  request: { id: string; folioId: string; folioLineId: string | null; toSlotId: string | null },
) => {
  const now = new Date()
  const nowSec = Math.floor(now.getTime() / 1000)

  const rejectWith = async (note: string, alternatives: unknown[]) => {
    await db
      .update(folioRequests)
      .set({ status: 'rejected', resolutionNote: note, resolvedBy: actorId, resolvedAt: now, updatedAt: now })
      .where(and(eq(folioRequests.id, request.id), eq(folioRequests.organizationId, org)))
    return c.json({ request: { id: request.id, status: 'rejected', resolution_note: note }, alternatives })
  }

  if (!request.folioLineId || !request.toSlotId) {
    return rejectWith('La solicitud no indicaba un horario válido.', [])
  }

  // Everything the counter path checks, in the same order and with the same compensation.
  let moved: Awaited<ReturnType<typeof rescheduleFolio>> | null = null
  try {
    moved = await rescheduleFolio({
      db,
      org,
      actorId,
      folioId: request.folioId,
      moves: [{ folio_line_id: request.folioLineId, to_slot_id: request.toSlotId }],
      nowSec,
      origin: 'tourist_request',
    })
  } catch (err) {
    // The one refusal a customer can do something about. Everything else (a departed slot, a folio
    // that is no longer live) is refused with its own reason and no alternatives, because offering
    // dates for a sale that ended would be noise.
    const code = err instanceof ApiError ? err.code : 'UNKNOWN'
    let alternatives: Awaited<ReturnType<typeof viableAlternatives>> = []
    if (code === 'NO_CAPACITY_AVAILABLE') {
      const [line] = await db
        .select({ serviceId: folioLines.serviceId, quantity: folioLines.quantity })
        .from(folioLines)
        .where(
          and(eq(folioLines.id, request.folioLineId), eq(folioLines.organizationId, org)),
        )
        .limit(1)
      const [orgRow] = await db
        .select({
          tz: organizations.timezone,
          cutoff: organizations.salesCutoffOffsetMinutes,
          creationCutoff: organizations.bookingCreationCutoffHours,
          buffer: organizations.bookingPreDepartureBufferHours,
          grace: organizations.bookingGraceOffsetMinutes,
        })
        .from(organizations)
        .where(eq(organizations.id, org))
        .limit(1)
      const [folioRow] = await db
        .select({ status: deriveStatusSql })
        .from(folios)
        .where(and(eq(folios.id, request.folioId), eq(folios.organizationId, org)))
        .limit(1)
      if (line) {
        alternatives = await viableAlternatives(
          db, org, line.serviceId, line.quantity, nowSec,
          orgRow?.tz ?? 'America/Mexico_City', orgRow?.cutoff ?? 0,
          // Rules 5/5b bind an apartado's destinations, so they bind its suggestions too — a slot
          // the move would refuse with BOOKING_TOO_LATE must not be offered as viable.
          folioRow?.status === 'booking'
            ? {
                creationCutoffHours: orgRow?.creationCutoff ?? 0,
                bufferHours: orgRow?.buffer ?? 24,
                graceMinutes: orgRow?.grace ?? 15,
              }
            : undefined,
        )
      }
    }
    const note =
      err instanceof ApiError ? err.message : 'No se pudo mover a ese horario.'
    return rejectWith(note, alternatives)
  }

  // D16 / rule 11 — the origin does not change what a paid folio needs: its QR names the old slot
  // and carries an `expires_at` derived from the OLD departure, so a ticket moved further out would
  // die before its tour. The counter path re-signs; approving a portal request must too, or the
  // customer whose request was GRANTED is the one left holding a dead ticket.
  if (moved && moved.folio.status === 'paid' && moved.folio.paymentVerification !== 'pending') {
    await reissueTicketsAfterReschedule(
      db, c.env, org, request.folioId,
      moved.folio.agentId, !!moved.folio.customerEmail, moved.tz,
    )
  }

  await db
    .update(folioRequests)
    .set({ status: 'approved', resolvedBy: actorId, resolvedAt: now, updatedAt: now })
    .where(and(eq(folioRequests.id, request.id), eq(folioRequests.organizationId, org)))

  const folioOut = await readFolio(db, org, request.folioId)
  return c.json({ request: { id: request.id, status: 'approved' }, folio: folioOut })
}

// US-T04 → US-A21 — APPROVE a tourist's cancellation request: runs the same race-safe
// cancellation as the direct admin cancel (folio flipped first, then seats released, email
// sent), marks the request approved, and — when the folio was PAID — opens the refund
// obligation (US-A23): refund_status='pending', refund_amount = amount_paid, and a freshly
// generated Refund PIN the tourist will read in their portal (D5/D6). The refund fields
// ride the guarded folio flip itself, so they can never apply to a folio someone else
// already cancelled. If a crash lands between the flip and the request update, the request
// stays pending against a cancelled folio — the admin resolves it explicitly (409 path).
export const approveCancellationRequest = async (c: FoliosContext) => {
  const admin = c.get('user')
  const org = admin.organizationId
  const requestId = c.req.param('requestId')
  // No body. Approving is an authorisation, not a pricing decision — the ladder decides the money
  // (D10), so there is nothing for a caller to supply. The `clawback` flag this used to accept was
  // withdrawn with US-A26's supersession.
  const db = getDb(c.env)

  const request = await loadRequest(db, org, requestId)
  if (request.status !== 'pending') {
    throw new ApiError('CONFLICT', 409, 'This request has already been resolved')
  }

  // US-AG52 — a RESCHEDULE approval is not a cancellation approval. It runs the same seven guards
  // the counter path runs, because a petition holds no seats: the capacity was never reserved and
  // may be gone by now.
  //
  // When it IS gone the request is REJECTED automatically, with the reason and with viable
  // alternatives. Leaving it `pending` would be worse than useless: `uq_folio_requests_open` allows
  // one open petition per folio, so an unfulfillable request would block the customer from asking
  // for anything else — including cancelling.
  if (request.kind === 'reschedule') {
    return approveRescheduleRequest(c, db, org, admin.userId, request)
  }

  const [folio] = await db
    .select({ id: folios.id, status: deriveStatusSql, amountPaid: folios.amountPaid })
    .from(folios)
    .where(and(eq(folios.id, request.folioId), eq(folios.organizationId, org)))
    .limit(1)
  if (!folio) {
    throw new ApiError('NOT_FOUND', 404, 'Folio not found')
  }
  if (folio.status === 'cancelled') {
    throw new ApiError('CONFLICT', 409, 'This folio is already cancelled')
  }

  const lines = await db
    .select({
      slotId: folioLines.slotId,
      quantity: folioLines.quantity,
      zoneId: folioLines.zoneId,
    })
    .from(folioLines)
    .where(
      and(eq(folioLines.folioId, folio.id), eq(folioLines.organizationId, org)),
    )

  const now = new Date()
  // The SAME pricing the admin path uses — that identity IS the fix. Approving a tourist's request
  // used to refund `amount_paid` in full while an admin cancelling the identical folio recorded no
  // refund at all; routing both through one function makes that divergence unrepresentable rather
  // than merely corrected. Approving is an authorisation, not a pricing decision, so this endpoint
  // takes no body fields (D10). `refundFieldsFor` still opens no obligation when the refund is 0,
  // which covers the unpaid-folio case the old `owesRefund` guard handled.
  const { won, outcome } = await cancelFolioPriced(db, org, folio.id, lines, now, {
    cancelledBy: admin.userId,
    reason: request.reason ?? 'Solicitud de cancelación del cliente',
    source: 'tourist_request',
  })
  if (!won) {
    // A concurrent cancellation won the guarded flip after our pre-check. The request
    // stays pending — the admin resolves it explicitly (same recovery as approving a
    // request whose folio was already cancelled directly).
    throw new ApiError('CONFLICT', 409, 'This folio is already cancelled')
  }

  await db
    .update(folioRequests)
    .set({
      status: 'approved',
      resolvedBy: admin.userId,
      resolvedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(folioRequests.id, requestId),
        eq(folioRequests.organizationId, org),
        eq(folioRequests.status, 'pending'),
      ),
    )

  const folioOut = await readFolio(db, org, folio.id)
  // US-A86 — the customer asked and is waiting on the answer; the row is written whether or not an
  // address exists, because WhatsApp is the channel that always reaches them (D20).
  await emitNotification(db, {
    organizationId: org,
    folioId: folio.id,
    event: 'cancellation_approved',
    hasEmail: !!folioOut?.customer_email,
  })
  if (folioOut) await queueCancellationEmail(c, db, org, folio.id, folioOut)

  const [updated] = await db
    .select()
    .from(folioRequests)
    .where(eq(folioRequests.id, requestId))
    .limit(1)

  return c.json({
    request: updated ? serializeRequest(updated) : null,
    folio: folioOut,
    cancellation: serializeOutcome(outcome),
  })
}

// US-T04 — REJECT a tourist's cancellation request with a REQUIRED note (the tourist reads
// it in their portal). The folio is untouched — seats stay booked, tickets stay valid.
export const rejectCancellationRequest = async (c: FoliosContext) => {
  const admin = c.get('user')
  const org = admin.organizationId
  const requestId = c.req.param('requestId')
  const input = (await c.req.json()) as RejectCancellationRequestInput
  const db = getDb(c.env)

  const request = await loadRequest(db, org, requestId)
  if (request.status !== 'pending') {
    throw new ApiError('CONFLICT', 409, 'This request has already been resolved')
  }

  const now = new Date()
  await db
    .update(folioRequests)
    .set({
      status: 'rejected',
      resolutionNote: input.note,
      resolvedBy: admin.userId,
      resolvedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(folioRequests.id, requestId),
        eq(folioRequests.organizationId, org),
        eq(folioRequests.status, 'pending'),
      ),
    )

  const [updated] = await db
    .select()
    .from(folioRequests)
    .where(eq(folioRequests.id, requestId))
    .limit(1)

  return c.json({ request: updated ? serializeRequest(updated) : null })
}

const REFUND_PIN_MAX_ATTEMPTS = 5

// US-A23 / US-T05 — CONFIRM the physical cash refund. Two mutually-exclusive bodies:
//   { pin }           — the primary path: the tourist read the PIN in their portal and
//                       handed it over, proving they were present to receive the cash.
//                       Mismatch → 422 + attempt counter; ≥5 fails locks the PIN path.
//   { override_note } — lost-link escape hatch: records the refund without a PIN, audited
//                       via refund_note.
// 409 when there is nothing pending to confirm. Never alters amounts (frozen history).
export const confirmRefund = async (c: FoliosContext) => {
  const admin = c.get('user')
  const org = admin.organizationId
  const id = c.req.param('id')
  const input = (await c.req.json()) as ConfirmRefundInput
  const db = getDb(c.env)

  const [folio] = await db
    .select({
      id: folios.id,
      refundStatus: deriveRefundStatusSql,
      refundAmount: deriveRefundAmountSql,
      creditAmount: folios.creditAmount,
      creditExpiresAt: folios.creditExpiresAt,
      refundPin: folios.refundPin,
      refundPinAttempts: folios.refundPinAttempts,
    })
    .from(folios)
    .where(and(eq(folios.id, id), eq(folios.organizationId, org)))
    .limit(1)
  if (!folio) {
    throw new ApiError('NOT_FOUND', 404, 'Folio not found')
  }
  if (folio.refundStatus !== 'pending') {
    throw new ApiError('CONFLICT', 409, 'This folio has no pending refund to confirm')
  }

  const pin = input.pin?.trim() || null
  const overrideNote = input.override_note?.trim() || null
  if ((pin && overrideNote) || (!pin && !overrideNote)) {
    throw new ApiError(
      'VALIDATION_ERROR',
      400,
      'Provide either the refund PIN or an override note — not both, not neither',
    )
  }

  if (pin) {
    if (folio.refundPinAttempts >= REFUND_PIN_MAX_ATTEMPTS) {
      throw new ApiError(
        'CONFLICT',
        409,
        'PIN entry is locked after too many failed attempts — confirm with an override note',
      )
    }
    if (pin !== folio.refundPin) {
      await db
        .update(folios)
        .set({
          refundPinAttempts: folio.refundPinAttempts + 1,
          updatedAt: new Date(),
        })
        .where(and(eq(folios.id, id), eq(folios.organizationId, org)))
      throw new ApiError('VALIDATION_ERROR', 422, 'Incorrect refund PIN')
    }
  }

  const now = new Date()
  await db.batch([
    // ORDER MATTERS (TECH_DEBT #25): the folio update's guard below asks "is anything still
    // pending?" — so it must run BEFORE the lines flip to refunded, or the rotation never fires.
    db
      .update(folios)
      .set({
        refundNote: overrideNote,
        refundedAt: now,
        refundedBy: admin.userId,
        // D7 — the PIN proves presence at THIS handshake, so a successful confirm CONSUMES it: a
        // later debt on the same folio mints its own proof, and the agent who just learned this
        // PIN cannot confirm that future debt with the tourist absent. Attempts reset with it.
        refundPin: generateRefundPin(),
        refundPinAttempts: 0,
        updatedAt: now,
      })
      .where(
        and(
          eq(folios.id, id),
          eq(folios.organizationId, org),
          // TECH_DEBT #25 — the obligation lives on the lines.
          sql`exists (select 1 from folio_lines fl where fl.folio_id = ${id} and fl.refund_status = 'pending')`,
        ),
      ),
    // US-A22 (D6) — the handshake settles every line-debt present at the counter: the person is
    // one, the PIN is one, the debts are per line.
    db
      .update(folioLines)
      .set({ refundStatus: 'refunded' })
      .where(
        and(
          eq(folioLines.folioId, id),
          eq(folioLines.organizationId, org),
          eq(folioLines.refundStatus, 'pending'),
        ),
      ),
    // US-A24 — the hand-back's narrative row, same batch, same clock as refunded_at. The `pending`
    // pre-check above already 409s a resolved refund, so a raced double-confirm is the same
    // pre-check-then-batch residual rejectPayment accepts.
    folioEventRow(db, {
      organizationId: org,
      folioId: id,
      type: 'refund_confirmed',
      actorId: admin.userId,
      payload: { amount: folio.refundAmount, via: pin ? 'pin' : 'override' },
      at: now,
    }),
  ])

  const folioOut = await readFolio(db, org, id)

  // US-AG51 (D20) — the receipt. The cash and the PIN are the confirmation in the moment; this is
  // the record the customer keeps afterwards, and the only place the ladder's arithmetic is ever
  // shown to them (business rule 13). An earlier draft (D18, withdrawn) left it off WhatsApp to
  // save a tap — it is an action-tail, so it rides the tap the agent has just made.
  await emitNotification(db, {
    organizationId: org,
    folioId: id,
    event: 'refund_completed',
    hasEmail: !!folioOut?.customer_email,
  })

  return c.json({ folio: folioOut })
}
