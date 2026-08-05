import type { Context } from 'hono'
import type { BatchItem } from 'drizzle-orm/batch'
import { and, asc, desc, eq, inArray, isNotNull, lt, ne, sql, type SQL } from 'drizzle-orm'
import { getDb, type Db } from '../../db/client'
import {
  accommodationReservations,
  affiliateOperators,
  folioRequests,
  folioAccessTokens,
  folioLineExtras,
  folioLines,
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
import { folioFulfillment, lineFulfillment } from '../../utils/folioFulfillment'
import { emitNotification, recordEmailOutcome } from '../../utils/notifications'
import { buildCancellationReversal, displayMethodSql, readFolioPayments } from '../../utils/folioPayments'
import {
  readListCancellationRequests,
  readListLines,
  readListPortalLinks,
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
  resolvePolicy,
  type CancellationOutcome,
} from '../../utils/cancellationPolicy'

export type FoliosContext = Context<{
  Bindings: CloudflareBindings
  Variables: AppVariables
}>

const tsOrNull = (d: Date | null) => (d ? Math.floor(d.getTime() / 1000) : null)

// --- Admin folio detail read (org-scoped; no QR echo — admins don't scan) -----

// Re-read one folio (lines + extras) scoped to the caller's org, with its cancellation
// audit. Returns null when no such folio exists in the org. Shared by getFolioDetail and
// the response of cancelFolio.
const readFolio = async (db: Db, org: string, folioId: string, apiBaseUrl?: string) => {
  const folioRows = await db
    .select({
      id: folios.id,
      agentId: folios.agentId,
      agentName: users.name,
      operatorName: affiliateOperators.name,
      status: folios.status,
      ticketsSentAt: folios.ticketsSentAt,
      ticketsViewedAt: folios.ticketsViewedAt,
      paymentMethod: displayMethodSql,
      paymentReference: folios.paymentReference,
      paymentVerification: folios.paymentVerification,
      paymentVerifiedAt: folios.paymentVerifiedAt,
      customerName: folios.customerName,
      customerEmail: folios.customerEmail,
      customerPhone: folios.customerPhone,
      subtotal: folios.subtotal,
      discountTotal: folios.discountTotal,
      total: folios.total,
      amountPaid: folios.amountPaid,
      commissionAmount: folios.commissionAmount,
      cancelledAt: folios.cancelledAt,
      cancelledBy: folios.cancelledBy,
      cancellationReason: folios.cancellationReason,
      cancellationClawback: folios.cancellationClawback,
      // US-AG07/D5 — apartado state, so the admin detail can show the expiry banner +
      // Liquidar/Reactivar and the reminder status.
      bookingExpiresAt: folios.bookingExpiresAt,
      reminderStatus: folios.reminderStatus,
      reminderSentAt: folios.reminderSentAt,
      reminderSentBy: folios.reminderSentBy,
      // US-A23 — refund tracking. refund_pin is DELIBERATELY not selected: the PIN is
      // portal-only (spec D6) — the admin learns it from the tourist in person, which is
      // exactly what proves the cash changed hands.
      refundStatus: folios.refundStatus,
      creditAmount: folios.creditAmount,
      creditExpiresAt: folios.creditExpiresAt,
      refundAmount: folios.refundAmount,
      refundNote: folios.refundNote,
      refundedAt: folios.refundedAt,
      refundedBy: folios.refundedBy,
      createdAt: folios.createdAt,
    })
    .from(folios)
    .innerJoin(users, eq(folios.agentId, users.id))
    .leftJoin(affiliateOperators, eq(folios.operatorId, affiliateOperators.id))
    .where(and(eq(folios.id, folioId), eq(folios.organizationId, org)))
    .limit(1)

  const folio = folioRows[0]
  if (!folio) return null

  // Delivery axis (whatsapp-qr-delivery) — the newest portal token's URL, for the admin's
  // "Enviar/Reenviar por WhatsApp" affordance. Only when a base URL is supplied.
  let portalLink: string | null = null
  if (apiBaseUrl) {
    const tokenRows = await db
      .select({ token: folioAccessTokens.token })
      .from(folioAccessTokens)
      .where(
        and(eq(folioAccessTokens.folioId, folioId), eq(folioAccessTokens.organizationId, org)),
      )
      .orderBy(desc(folioAccessTokens.createdAt))
      .limit(1)
    if (tokenRows[0]) portalLink = `${apiBaseUrl}/portal/${tokenRows[0].token}`
  }

  // US-A84 rule 7 — this folio's cancellation-request history, newest first. This is where the
  // absorbed *Solicitudes* tab actually lands (D2): a rejected request never changed the folio, so
  // the folio it was about is the only surface that can carry it. One folio, one cheap read.
  const requestRows = await db
    .select({
      id: folioRequests.id,
      status: folioRequests.status,
      reason: folioRequests.reason,
      resolutionNote: folioRequests.resolutionNote,
      resolvedBy: folioRequests.resolvedBy,
      resolvedAt: folioRequests.resolvedAt,
      createdAt: folioRequests.createdAt,
    })
    .from(folioRequests)
    .where(
      and(
        eq(folioRequests.folioId, folioId),
        eq(folioRequests.organizationId, org),
      ),
    )
    .orderBy(desc(folioRequests.createdAt))

  // US-A85 — fulfilment is derived on read, so the detail resolves the org's clock and margin the
  // same way the list does. One derivation, two callers: they cannot disagree.
  const [fulfillmentOrg] = await db
    .select({ tz: organizations.timezone, noShowMargin: organizations.noShowMarginMinutes })
    .from(organizations)
    .where(eq(organizations.id, org))
    .limit(1)
  const fulfillmentTz = fulfillmentOrg?.tz ?? 'America/Mexico_City'
  const fulfillmentMargin = fulfillmentOrg?.noShowMargin ?? 0
  const nowEpoch = Math.floor(Date.now() / 1000)

  const lineRows = await db
    .select({
      id: folioLines.id,
      serviceId: folioLines.serviceId,
      slotId: folioLines.slotId,
      serviceName: folioLines.serviceName,
      slotDate: folioLines.slotDate,
      slotStartTime: folioLines.slotStartTime,
      quantity: folioLines.quantity,
      basePrice: folioLines.basePrice,
      minimumPrice: folioLines.minimumPrice,
      unitPrice: folioLines.unitPrice,
      lineTotal: folioLines.lineTotal,
      lineType: folioLines.lineType,
      unitTypeId: folioLines.unitTypeId,
      checkIn: folioLines.checkIn,
      checkOut: folioLines.checkOut,
      guests: folioLines.guests,
      nights: folioLines.nights,
      redeemedCount: folioLines.redeemedCount,
    })
    .from(folioLines)
    .where(and(eq(folioLines.folioId, folioId), eq(folioLines.organizationId, org)))
    .orderBy(asc(folioLines.createdAt))

  const extraRows = await db
    .select({
      id: folioLineExtras.id,
      folioLineId: folioLineExtras.folioLineId,
      extraId: folioLineExtras.extraId,
      name: folioLineExtras.name,
      price: folioLineExtras.price,
      quantity: folioLineExtras.quantity,
    })
    .from(folioLineExtras)
    .where(
      and(
        eq(folioLineExtras.folioId, folioId),
        eq(folioLineExtras.organizationId, org),
      ),
    )

  const extrasByLine = new Map<string, typeof extraRows>()
  for (const ex of extraRows) {
    const list = extrasByLine.get(ex.folioLineId) ?? []
    list.push(ex)
    extrasByLine.set(ex.folioLineId, list)
  }

  // US-LG08 — the per-payment breakdown (deposit vs balance, each with its own method).
  const payments = await readFolioPayments(db, org, folioId)

  return {
    id: folio.id,
    agent: { id: folio.agentId, name: folio.agentName },
    // US-A68 — the affiliate shift operator who took the sale (null ⇒ sold directly).
    operator_name: folio.operatorName ?? null,
    status: folio.status,
    payment_method: folio.paymentMethod,
    // US-AG41/US-A67 — payment reference + verification gate for the admin detail + verify actions.
    payment_reference: folio.paymentReference,
    payment_verification: folio.paymentVerification,
    payment_verified_at: tsOrNull(folio.paymentVerifiedAt),
    customer_name: folio.customerName,
    customer_email: folio.customerEmail,
    customer_phone: folio.customerPhone,
    subtotal: folio.subtotal,
    discount_total: folio.discountTotal,
    total: folio.total,
    amount_paid: folio.amountPaid,
    pending_balance: folio.total - folio.amountPaid,
    commission_amount: folio.commissionAmount,
    booking_expires_at: tsOrNull(folio.bookingExpiresAt),
    reminder_status: folio.reminderStatus,
    reminder_sent_at: tsOrNull(folio.reminderSentAt),
    reminder_sent_by: folio.reminderSentBy,
    cancelled_at: tsOrNull(folio.cancelledAt),
    cancelled_by: folio.cancelledBy,
    cancellation_reason: folio.cancellationReason,
    cancellation_clawback: folio.cancellationClawback,
    refund_status: folio.refundStatus,
    // US-A87 — the credit and its expiry, so the detail can state both.
    credit_amount: folio.creditAmount,
    credit_expires_at: tsOrNull(folio.creditExpiresAt),
    refund_amount: folio.refundAmount,
    refund_note: folio.refundNote,
    refunded_at: tsOrNull(folio.refundedAt),
    refunded_by: folio.refundedBy,
    // Delivery axis (whatsapp-qr-delivery) — portal_link + sent/viewed stamps for the admin's
    // oversight badge and Reenviar action.
    portal_link: portalLink,
    tickets_sent_at: tsOrNull(folio.ticketsSentAt),
    tickets_viewed_at: tsOrNull(folio.ticketsViewedAt),
    created_at: Math.floor(folio.createdAt.getTime() / 1000),
    payments,
    // US-A84 rule 7 — the absorbed request history (newest first). Empty for the vast majority of
    // folios, which is why it costs nothing to always send it.
    folio_requests: requestRows.map((r) => ({
      id: r.id,
      status: r.status,
      reason: r.reason,
      resolution_note: r.resolutionNote,
      resolved_by: r.resolvedBy,
      resolved_at: tsOrNull(r.resolvedAt),
      created_at: Math.floor(r.createdAt.getTime() / 1000),
    })),
    // US-A85 (D7) — the worst of the lines. Computed from the same readings the array carries, so
    // the summary and the breakdown are one number and its parts, never two opinions.
    fulfillment: folioFulfillment(
      lineRows.map((line) =>
        lineFulfillment(
          {
            lineId: line.id,
            lineType: line.lineType,
            slotDate: line.slotDate,
            slotStartTime: line.slotStartTime,
            checkIn: line.checkIn,
            lineTotal: line.lineTotal,
            quantity: line.quantity,
            redeemedCount: line.redeemedCount,
          },
          fulfillmentTz,
          fulfillmentMargin,
          nowEpoch,
        ),
      ),
    ),
    lines: lineRows.map((line) => ({
      id: line.id,
      line_type: line.lineType,
      service_id: line.serviceId,
      slot_id: line.slotId,
      service_name: line.serviceName,
      slot_date: line.slotDate,
      slot_start_time: line.slotStartTime,
      unit_type_id: line.unitTypeId,
      check_in: line.checkIn,
      check_out: line.checkOut,
      guests: line.guests,
      nights: line.nights,
      quantity: line.quantity,
      // US-A85 — the per-line fulfilment the folio's roll-up is made of (D2). The detail is where
      // "two of four boarded, and the Thursday tour nobody came to" can actually be read.
      redeemed_count: line.redeemedCount,
      fulfillment: lineFulfillment(
        {
          lineId: line.id,
          lineType: line.lineType,
          slotDate: line.slotDate,
          slotStartTime: line.slotStartTime,
          checkIn: line.checkIn,
          lineTotal: line.lineTotal,
          quantity: line.quantity,
          redeemedCount: line.redeemedCount,
        },
        fulfillmentTz,
        fulfillmentMargin,
        nowEpoch,
      ),
      base_price: line.basePrice,
      minimum_price: line.minimumPrice,
      unit_price: line.unitPrice,
      line_total: line.lineTotal,
      extras: (extrasByLine.get(line.id) ?? []).map((ex) => ({
        id: ex.id,
        extra_id: ex.extraId,
        name: ex.name,
        price: ex.price,
        quantity: ex.quantity,
      })),
    })),
  }
}

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
    filters.push(eq(folios.status, statusQ))
  }
  if (
    verificationQ === 'pending' ||
    verificationQ === 'verified' ||
    verificationQ === 'not_required'
  ) {
    filters.push(eq(folios.paymentVerification, verificationQ))
    // US-A67 — the "Por verificar" queue is ACTIVE folios awaiting an admin: a rejected payment
    // cancels the folio (its stale 'pending' flag stays), so exclude cancelled to drop it out.
    if (verificationQ === 'pending') filters.push(ne(folios.status, 'cancelled'))
  }
  if (agentQ) filters.push(eq(folios.agentId, agentQ))

  // US-A78 — refunds still owed. Unknown values fall through to "no filter", matching `status`.
  if (refundStatusQ === 'pending' || refundStatusQ === 'none' || refundStatusQ === 'refunded') {
    filters.push(eq(folios.refundStatus, refundStatusQ))
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
      status: folios.status,
      total: folios.total,
      amountPaid: folios.amountPaid,
      createdAt: folios.createdAt,
      cancelledAt: folios.cancelledAt,
      // US-AG07.3/D5 — booking-recovery fields so the admin list can decorate apartado rows
      // (urgency accent, pending balance, WhatsApp reminder) exactly like the agent list.
      bookingExpiresAt: folios.bookingExpiresAt,
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
      refundStatus: folios.refundStatus,
      creditAmount: folios.creditAmount,
      creditExpiresAt: folios.creditExpiresAt,
      refundAmount: folios.refundAmount,
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
    folios: page.map((r) => ({
      id: r.id,
      agent: { id: r.agentId, name: r.agentName },
      customer_name: r.customerName,
      customer_phone: r.customerPhone,
      status: r.status,
      total: r.total,
      amount_paid: r.amountPaid,
      pending_balance: r.total - r.amountPaid,
      created_at: Math.floor(r.createdAt.getTime() / 1000),
      cancelled_at: tsOrNull(r.cancelledAt),
      booking_expires_at: tsOrNull(r.bookingExpiresAt),
      reminder_status: r.reminderStatus,
      reminder_sent_at: tsOrNull(r.reminderSentAt),
      reminder_sent_by: r.reminderSentBy,
      // US-AG41/US-A67 — payment method + reference + the verification gate (the "Por verificar"
      // queue reads these; the delivery axis is blocked while pending).
      payment_method: r.paymentMethod,
      payment_reference: r.paymentReference,
      payment_verification: r.paymentVerification,
      // Delivery axis (whatsapp-qr-delivery) — a paid folio is deliverable ONLY once its money has
      // cleared (cash, or the electronic payment verified). Pending electronic → not yet.
      deliverable: r.status === 'paid' && r.paymentVerification !== 'pending',
      tickets_sent_at: tsOrNull(r.ticketsSentAt),
      tickets_viewed_at: tsOrNull(r.ticketsViewedAt),
      // US-A68 — the affiliate shift operator who took the sale (null ⇒ sold directly).
      operator_name: r.operatorName ?? null,
      // US-A78 — 'pending' = cancelled, money owed, nobody confirmed the hand-back.
      refund_status: r.refundStatus,
      refund_amount: r.refundAmount,
      // US-A87 — what a closed apartado left the customer, and until when.
      credit_amount: r.creditAmount,
      credit_expires_at: tsOrNull(r.creditExpiresAt),
      // US-A82 — what was sold (card title + the WhatsApp {itinerary}), the link the ticket send
      // needs, and the sale mode a null customer_name must never be used to infer.
      sale_mode: r.saleMode,
      portal_link: portalLinkByFolio.get(r.id) ?? null,
      lines: linesByFolio.get(r.id) ?? [],
      // US-A85 (D7) — the worst of the lines, so a folio with one wasted seat never reads as
      // consumed. Derived; refused from any request body.
      fulfillment: folioFulfillment(
        (linesByFolio.get(r.id) ?? []).map((l) => l.fulfillment),
      ),
      // US-A84 rule 6 — 'pending' ⇒ a customer is waiting on an answer (the card's first verb);
      // 'resolved' ⇒ requests exist but none live (the `Con solicitud` facet); null ⇒ none.
      cancellation_request: requestByFolio.get(r.id) ?? null,
      // US-A84 — the same predicate `?overdue=true` applies, surfaced per row so the card's time
      // chip does not have to re-derive the deadline against a clock the client owns.
      overdue:
        r.status === 'booking' &&
        r.bookingExpiresAt != null &&
        r.bookingExpiresAt.getTime() < now.getTime(),
    })),
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

  const folio = await readFolio(db, admin.organizationId, id, c.env.API_BASE_URL)
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

  return c.json({ folio, cancellation_quote: quote ? serializeQuote(quote) : null })
}

const serializeQuote = (o: CancellationOutcome) => ({
  refund: o.refund,
  retention: o.retention,
  kept_commission: o.keptCommission,
  reversed_commission: o.reversedCommission,
  lines: o.lines.map((l) => ({
    line_id: l.lineId,
    // Rounded for display; the decision itself used the exact value.
    hours_out: Number.isFinite(l.hoursOut) ? Math.round(l.hoursOut) : null,
    refund_pct: l.refundPct,
    retention: l.retention,
    redeemed: l.redeemed,
  })),
})

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
        ne(folios.status, 'cancelled'),
      ),
    )
    .returning({ id: folios.id })
  if (won.length === 0) return false

  const statements: BatchItem<'sqlite'>[] = []
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
): Promise<CancellationOutcome> => {
  const [folio] = await db
    .select({
      status: folios.status,
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

  return computeCancellationRefund({
    policy,
    lines,
    amountPaid: folio.amountPaid,
    nowEpoch: Math.floor(now.getTime() / 1000),
    timezone: orgRow?.timezone ?? 'America/Mexico_City',
    // D12 — an affiliate sale is already stamped on the folio (US-A51), so which of the tier's two
    // commission percentages applies needs no join.
    sellerKind: folio.affiliateCompanyId ? 'affiliate' : 'agent',
    // The authoritative commission the sale booked. Only differs from the per-line sum for folios
    // sold before `0028` snapshotted commission onto lines; without it those would forfeit nothing.
    bookedCommission: folio.commissionAmount,
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
  outcome.refund > 0
    ? {
        refundStatus: 'pending' as const,
        refundAmount: outcome.refund,
        refundPin: generateRefundPin(),
      }
    : { refundStatus: 'none' as const, refundAmount: 0 }

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
      status: 'cancelled',
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
    .select({ id: folios.id, status: folios.status })
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
      folioStatus: folios.status,
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

  const [folio] = await db
    .select({ id: folios.id, status: folios.status, amountPaid: folios.amountPaid })
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
      refundStatus: folios.refundStatus,
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
  await db
    .update(folios)
    .set({
      refundStatus: 'refunded',
      refundNote: overrideNote,
      refundedAt: now,
      refundedBy: admin.userId,
      updatedAt: now,
    })
    .where(
      and(
        eq(folios.id, id),
        eq(folios.organizationId, org),
        eq(folios.refundStatus, 'pending'),
      ),
    )

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
