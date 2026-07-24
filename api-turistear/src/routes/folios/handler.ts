import type { Context } from 'hono'
import type { BatchItem } from 'drizzle-orm/batch'
import { and, asc, desc, eq, ne, sql } from 'drizzle-orm'
import { getDb, type Db } from '../../db/client'
import {
  accommodationReservations,
  affiliateOperators,
  cancellationRequests,
  folioAccessTokens,
  folioLineExtras,
  folioLines,
  folios,
  organizations,
  slots,
  users,
} from '../../db/schema'
import { nightsBetween } from '../../utils/lodging'
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
      paymentMethod: folios.paymentMethod,
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
export const listFolios = async (c: FoliosContext) => {
  const admin = c.get('user')
  const org = admin.organizationId
  const db = getDb(c.env)

  const statusQ = c.req.query('status')
  const dateQ = c.req.query('date')
  const agentQ = c.req.query('agent_id')
  // US-A67 — the "Por verificar" queue filters to electronic payments awaiting an admin.
  const verificationQ = c.req.query('verification')

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
  if (dateQ) {
    filters.push(
      sql`strftime('%Y-%m-%d', ${folios.createdAt}, 'unixepoch') = ${dateQ}`,
    )
  }
  if (agentQ) filters.push(eq(folios.agentId, agentQ))

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
      paymentMethod: folios.paymentMethod,
      paymentReference: folios.paymentReference,
      paymentVerification: folios.paymentVerification,
      operatorName: affiliateOperators.name,
    })
    .from(folios)
    .innerJoin(users, eq(folios.agentId, users.id))
    .leftJoin(affiliateOperators, eq(folios.operatorId, affiliateOperators.id))
    .where(and(...filters))
    .orderBy(desc(folios.createdAt))

  return c.json({
    folios: rows.map((r) => ({
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
    })),
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

  return c.json({ folio })
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
//   2. Only the winner releases the seats, per line `slots.booked = MAX(0, booked −
//      quantity)` (clamped so a manually edited slot can never go negative), in one batch.
// The reversed order (seats in the same batch as the guarded flip) double-released seats
// when two cancellations raced: a 0-row guarded UPDATE does not abort a D1 batch, so the
// loser's seat decrements still applied. Residual: a crash between 1 and 2 leaves seats
// booked on a cancelled folio — conservative (no oversell), same compensate-style
// trade-off as POS confirm.
const applyCancellation = async (
  db: Db,
  org: string,
  folioId: string,
  lines: Array<{ slotId: string | null; quantity: number }>,
  now: Date,
  folioUpdate: Partial<typeof folios.$inferInsert>,
): Promise<boolean> => {
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

  const statements: BatchItem<'sqlite'>[] = lines
    .filter((line) => line.slotId)
    .map((line) =>
      db
        .update(slots)
        .set({
          booked: sql`MAX(0, ${slots.booked} - ${line.quantity})`,
          updatedAt: now,
        })
        .where(and(eq(slots.id, line.slotId!), eq(slots.organizationId, org))),
    )
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

// Fire-and-forget cancellation email — a Resend failure must never fail a committed
// cancellation. waitUntil guarantees the send completes after the response returns (a bare
// floating promise can be cancelled when the Worker returns, silently dropping the email).
const queueCancellationEmail = async (
  c: FoliosContext,
  db: Db,
  org: string,
  folioId: string,
  folioOut: NonNullable<Awaited<ReturnType<typeof readFolio>>>,
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
    cancellationReason: folioOut.cancellation_reason,
    lines: folioOut.lines.map((l) => ({
      serviceName: l.service_name,
      slotDate: l.slot_date,
      slotStartTime: l.slot_start_time,
      quantity: l.quantity,
    })),
  }

  c.executionCtx.waitUntil(
    sendCancellationEmail(c.env, emailData).catch((err) =>
      console.error('[email] cancellation send failed', folioId, err),
    ),
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
      lineType: folioLines.lineType,
      lineTotal: folioLines.lineTotal,
      checkIn: folioLines.checkIn,
    })
    .from(folioLines)
    .where(and(eq(folioLines.folioId, id), eq(folioLines.organizationId, org)))

  const now = new Date()

  // D9 — a PAID stay cancellation computes a structured refund (free-window then penalty %) on the
  // stay portion; a booking-status deposit stays non-refundable (handled on the POS cancel path,
  // US-AG07.4). Org settings drive the policy; tour-only or booking folios keep the default (none).
  const refundUpdate: Partial<typeof folios.$inferInsert> = {}
  const stayLines = lines.filter((l) => l.lineType === 'stay')
  if (folio.status === 'paid' && stayLines.length > 0) {
    const orgRows = await db
      .select({
        freeCancelDays: organizations.lodgingFreeCancelDays,
        penaltyPct: organizations.lodgingCancelPenaltyPct,
      })
      .from(organizations)
      .where(eq(organizations.id, org))
      .limit(1)
    const freeCancelDays = orgRows[0]?.freeCancelDays ?? 0
    const penaltyPct = orgRows[0]?.penaltyPct ?? 0
    const stayTotal = stayLines.reduce((sum, l) => sum + l.lineTotal, 0)
    const today = new Date().toISOString().slice(0, 10)
    const earliestCheckIn = stayLines
      .map((l) => l.checkIn)
      .filter((d): d is string => !!d)
      .sort()[0]
    const daysBefore = earliestCheckIn ? nightsBetween(today, earliestCheckIn) : 0
    const refund =
      daysBefore >= freeCancelDays
        ? stayTotal
        : Math.floor((stayTotal * (100 - penaltyPct)) / 100)
    refundUpdate.refundStatus = 'pending'
    refundUpdate.refundAmount = refund
  }

  const won = await applyCancellation(db, org, id, lines, now, {
    status: 'cancelled',
    cancelledAt: now,
    cancelledBy: admin.userId,
    cancellationReason: input.reason ?? null,
    cancellationClawback: input.clawback ?? false,
    ...refundUpdate,
  })
  if (!won) {
    // A concurrent cancellation won the guarded flip after our pre-check.
    throw new ApiError('CONFLICT', 409, 'This folio is already cancelled')
  }

  const folioOut = await readFolio(db, org, id)
  if (folioOut) await queueCancellationEmail(c, db, org, id, folioOut)

  return c.json({ folio: folioOut })
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
  const filters = [eq(cancellationRequests.organizationId, org)]
  if (statusQ === 'approved' || statusQ === 'rejected' || statusQ === 'pending') {
    filters.push(eq(cancellationRequests.status, statusQ))
  } else if (statusQ !== 'all') {
    filters.push(eq(cancellationRequests.status, 'pending'))
  }

  const rows = await db
    .select({
      id: cancellationRequests.id,
      folioId: cancellationRequests.folioId,
      status: cancellationRequests.status,
      reason: cancellationRequests.reason,
      resolutionNote: cancellationRequests.resolutionNote,
      resolvedBy: cancellationRequests.resolvedBy,
      resolvedAt: cancellationRequests.resolvedAt,
      createdAt: cancellationRequests.createdAt,
      customerName: folios.customerName,
      folioStatus: folios.status,
      total: folios.total,
      amountPaid: folios.amountPaid,
    })
    .from(cancellationRequests)
    .innerJoin(folios, eq(cancellationRequests.folioId, folios.id))
    .where(and(...filters))
    .orderBy(desc(cancellationRequests.createdAt))

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
      id: cancellationRequests.id,
      folioId: cancellationRequests.folioId,
      status: cancellationRequests.status,
      reason: cancellationRequests.reason,
    })
    .from(cancellationRequests)
    .where(
      and(
        eq(cancellationRequests.id, requestId),
        eq(cancellationRequests.organizationId, org),
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
  // Optional body: { clawback } — the US-A26 choice applies to tourist-initiated
  // cancellations too. Lenient parse: an empty body means "company absorbs".
  const input = (await c.req.json().catch(() => ({}))) as { clawback?: boolean }
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
    .select({ slotId: folioLines.slotId, quantity: folioLines.quantity })
    .from(folioLines)
    .where(
      and(eq(folioLines.folioId, folio.id), eq(folioLines.organizationId, org)),
    )

  const now = new Date()
  // Refund obligation only when money actually changed hands (S9: unpaid → no PIN).
  const owesRefund = folio.amountPaid > 0
  const won = await applyCancellation(db, org, folio.id, lines, now, {
    status: 'cancelled',
    cancelledAt: now,
    cancelledBy: admin.userId,
    cancellationReason: request.reason ?? 'Solicitud de cancelación del cliente',
    cancellationClawback: input.clawback === true,
    ...(owesRefund
      ? {
          refundStatus: 'pending' as const,
          refundAmount: folio.amountPaid,
          refundPin: generateRefundPin(),
        }
      : {}),
  })
  if (!won) {
    // A concurrent cancellation won the guarded flip after our pre-check. The request
    // stays pending — the admin resolves it explicitly (same recovery as approving a
    // request whose folio was already cancelled directly).
    throw new ApiError('CONFLICT', 409, 'This folio is already cancelled')
  }

  await db
    .update(cancellationRequests)
    .set({
      status: 'approved',
      resolvedBy: admin.userId,
      resolvedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(cancellationRequests.id, requestId),
        eq(cancellationRequests.organizationId, org),
        eq(cancellationRequests.status, 'pending'),
      ),
    )

  const folioOut = await readFolio(db, org, folio.id)
  if (folioOut) await queueCancellationEmail(c, db, org, folio.id, folioOut)

  const [updated] = await db
    .select()
    .from(cancellationRequests)
    .where(eq(cancellationRequests.id, requestId))
    .limit(1)

  return c.json({ request: updated ? serializeRequest(updated) : null, folio: folioOut })
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
    .update(cancellationRequests)
    .set({
      status: 'rejected',
      resolutionNote: input.note,
      resolvedBy: admin.userId,
      resolvedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(cancellationRequests.id, requestId),
        eq(cancellationRequests.organizationId, org),
        eq(cancellationRequests.status, 'pending'),
      ),
    )

  const [updated] = await db
    .select()
    .from(cancellationRequests)
    .where(eq(cancellationRequests.id, requestId))
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
  return c.json({ folio: folioOut })
}
