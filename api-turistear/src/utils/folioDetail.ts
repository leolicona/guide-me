// The folio detail, read and serialized ONCE for both audiences.
//
// docs/oversight/folio-surface-parity.spec.md D6. Two hand-maintained copies of this payload used
// to live in `routes/folios/handler.ts` and `routes/pos/handler.ts`, and they drifted: the seller's
// omitted `refund_status`, `refund_amount`, `credit_amount`, `credit_expires_at`, `refund_note`,
// `cancellation_reason`, `folio_requests`, `fulfillment`, the folio-level `booking_expires_at`,
// `pending_balance` and the reminder stamps — so a cancelled sale rendered `Pagado $3,000` and then
// said nothing about where the money went (BUG-034), on the one screen the person answering for it
// can open.
//
// The rule the server already stated (`routes/pos/handler.ts`, listAgentFolios): the line between
// the two audiences is CAPABILITY, never information. A field added here therefore reaches both
// surfaces or neither — which is a property of the code now, not a convention to remember.

import { and, asc, desc, eq, sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import {
  affiliateOperators,
  folioAccessTokens,
  folioLineExtras,
  folioLines,
  folioRequests,
  folios,
  organizations,
  slots,
  users,
} from '../db/schema'
import { folioFulfillment, lineFulfillment } from './folioFulfillment'
import {
  deriveBookingExpiresAtSql,
  deriveRefundAmountSql,
  deriveRefundStatusSql,
  deriveStatusSql,
} from './folioStatus'
import { displayMethodSql, readFolioPayments } from './folioPayments'
import { deriveOrgKey, verifyTicket, type TicketPayload } from './qr'

export interface FolioDetailOpts {
  /** Scope the read to one seller's own folios (the POS surface). Omit for the admin surface. */
  agentId?: string
  /** Echo each line's access ticket. Omit where the caller has no use for it (mutation replies). */
  qrSecret?: string
  /** Resolve the portal link. Omit and `portal_link` is null. */
  apiBaseUrl?: string
}

/** The signature-free subset of a ticket payload echoed on folio responses, so the client need
 *  not base64-decode the token to render labels. */
const qrEcho = (p: TicketPayload) => ({
  folio_id: p.folio_id,
  folio_line_id: p.folio_line_id,
  service_id: p.service_id,
  slot_id: p.slot_id,
  client_identity: p.client_identity,
  passes_total: p.passes_total,
  expires_at: p.expires_at,
})

const tsOrNull = (d: Date | null) => (d ? Math.floor(d.getTime() / 1000) : null)

/**
 * Read one folio in full — folio, lines, extras, payments, petitions — and serialize it to the
 * API shape both detail surfaces render.
 *
 * `opts.agentId` scopes the read to one seller (the POS surface); omitted, it reads any folio in
 * the org (the admin surface). `opts.qrSecret` echoes each line's access ticket; `opts.apiBaseUrl`
 * resolves the portal link. Nothing else varies by audience — that is the point of the function.
 */
export const readFolioDetail = async (
  db: Db,
  org: string,
  folioId: string,
  opts: FolioDetailOpts = {},
) => {
  const { agentId, qrSecret, apiBaseUrl } = opts
  const folioRows = await db
    .select({
      id: folios.id,
      agentId: folios.agentId,
      agentName: users.name,
      operatorName: affiliateOperators.name,
      status: deriveStatusSql, // D11 — derived from the lines; equals the column by construction
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
      // US-AG07/D5 — apartado state, so the admin detail can show the expiry banner +
      // Liquidar/Reactivar and the reminder status.
      // TECH_DEBT #25 — the roll-ups derive from the lines; the columns are gone (0065).
      bookingExpiresAt: deriveBookingExpiresAtSql,
      reminderStatus: folios.reminderStatus,
      reminderSentAt: folios.reminderSentAt,
      reminderSentBy: folios.reminderSentBy,
      // US-A23 — refund tracking. refund_pin is DELIBERATELY not selected: the PIN is
      // portal-only (spec D6) — the admin learns it from the tourist in person, which is
      // exactly what proves the cash changed hands.
      refundStatus: deriveRefundStatusSql,
      creditAmount: folios.creditAmount,
      creditExpiresAt: folios.creditExpiresAt,
      refundAmount: deriveRefundAmountSql,
      refundNote: folios.refundNote,
      refundedAt: folios.refundedAt,
      refundedBy: folios.refundedBy,
      createdAt: folios.createdAt,
    })
    .from(folios)
    .innerJoin(users, eq(folios.agentId, users.id))
    .leftJoin(affiliateOperators, eq(folios.operatorId, affiliateOperators.id))
    .where(
      and(
        eq(folios.id, folioId),
        eq(folios.organizationId, org),
        // The seller surface reads its OWN sales; the id comes from the session, never the request.
        ...(agentId ? [eq(folios.agentId, agentId)] : []),
      ),
    )
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
      // US-AG52 — the review surface must know WHAT it is approving. A reschedule petition
      // presented as a cancellation is a button that lies about the destructive half.
      kind: folioRequests.kind,
      status: folioRequests.status,
      reason: folioRequests.reason,
      resolutionNote: folioRequests.resolutionNote,
      resolvedBy: folioRequests.resolvedBy,
      resolvedAt: folioRequests.resolvedAt,
      createdAt: folioRequests.createdAt,
      folioLineId: folioRequests.folioLineId,
      // The requested destination, resolved to a human date — the seller decides on "quiere
      // moverse al 21 · 09:00", not on a slot UUID.
      toSlotId: folioRequests.toSlotId,
      toSlotDate: slots.date,
      toSlotStartTime: slots.startTime,
    })
    .from(folioRequests)
    .leftJoin(
      slots,
      and(eq(slots.id, folioRequests.toSlotId), eq(slots.organizationId, org)),
    )
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
      // US-A64 — the physical zone (null for an unzoned or lodging line).
      zoneName: folioLines.zoneName,
      qrToken: folioLines.qrToken,
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
      // US-A22 — the line's own life: cancellation (written) + refund debt, and the net money its
      // allocations say it holds (raw outer-column correlation — the displayMethodSql trick).
      cancelledAt: folioLines.cancelledAt,
      cancellationSource: folioLines.cancellationSource,
      lineRefundStatus: folioLines.refundStatus,
      lineRefundAmount: folioLines.refundAmount,
      // US-AG54 (D5) — the line's own hold clock, for the per-line countdown.
      lineBookingExpiresAt: folioLines.bookingExpiresAt,
      allocated: sql<number>`coalesce((select sum(a.amount) from folio_payment_allocations a where a.folio_line_id = folio_lines.id), 0)`,
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

  // US-A93 — one verify per signed line, and only where a secret was supplied. The echo is a
  // convenience for the UI; the token itself stays the authority.
  const qrByLine = new Map<string, ReturnType<typeof qrEcho>>()
  if (qrSecret) {
    const orgKey = await deriveOrgKey(qrSecret, org)
    for (const line of lineRows) {
      if (!line.qrToken) continue
      const payload = await verifyTicket(line.qrToken, orgKey)
      if (payload) qrByLine.set(line.id, qrEcho(payload))
    }
  }

  const lines = lineRows.map((line) => ({
        id: line.id,
        line_type: line.lineType,
        service_id: line.serviceId,
        slot_id: line.slotId,
        service_name: line.serviceName,
        zone_name: line.zoneName,
        slot_date: line.slotDate,
        slot_start_time: line.slotStartTime,
        unit_type_id: line.unitTypeId,
        check_in: line.checkIn,
        check_out: line.checkOut,
        guests: line.guests,
        nights: line.nights,
        quantity: line.quantity,
        // US-A22 — the line's own money state, DERIVED from its allocations (cancellation, being an
        // action, is read from its written stamp). Same three-value vocabulary as the folio field
        // it will eventually replace (D11).
        money_state: line.cancelledAt
          ? ('cancelled' as const)
          : Math.max(0, Number(line.allocated ?? 0)) >= line.lineTotal
            ? ('paid' as const)
            : ('booking' as const),
        allocated: Math.max(0, Number(line.allocated ?? 0)),
        pending_balance: line.cancelledAt
          ? 0
          : Math.max(0, line.lineTotal - Math.max(0, Number(line.allocated ?? 0))),
        cancelled_at: tsOrNull(line.cancelledAt),
        cancellation_source: line.cancellationSource,
        refund_status: line.lineRefundStatus,
        refund_amount: line.lineRefundAmount,
        booking_expires_at: tsOrNull(line.lineBookingExpiresAt),
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
        // US-A93 — the access ticket, echoed on BOTH surfaces: the admin taking the
        // "my QR doesn't scan" call has to see what the customer is holding. `qr` is the
        // signature-free subset, so the client never base64-decodes the token to render a label.
        qr_token: line.qrToken ?? null,
        qr: qrByLine.get(line.id) ?? null,
        extras: (extrasByLine.get(line.id) ?? []).map((ex) => ({
          id: ex.id,
          extra_id: ex.extraId,
          name: ex.name,
          price: ex.price,
          quantity: ex.quantity,
        })),
  }))

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
    booking_expires_at: folio.bookingExpiresAt ?? null, // derived: epoch seconds already
    reminder_status: folio.reminderStatus,
    reminder_sent_at: tsOrNull(folio.reminderSentAt),
    reminder_sent_by: folio.reminderSentBy,
    cancelled_at: tsOrNull(folio.cancelledAt),
    cancelled_by: folio.cancelledBy,
    cancellation_reason: folio.cancellationReason,
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
      kind: r.kind,
      status: r.status,
      reason: r.reason,
      resolution_note: r.resolutionNote,
      resolved_by: r.resolvedBy,
      resolved_at: tsOrNull(r.resolvedAt),
      created_at: Math.floor(r.createdAt.getTime() / 1000),
      folio_line_id: r.folioLineId,
      to_slot_id: r.toSlotId,
      to_slot_date: r.toSlotDate,
      to_slot_start_time: r.toSlotStartTime,
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
    lines,
  }
}
