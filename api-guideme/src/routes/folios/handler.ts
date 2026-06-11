import type { Context } from 'hono'
import type { BatchItem } from 'drizzle-orm/batch'
import { and, asc, desc, eq, ne, sql } from 'drizzle-orm'
import { getDb, type Db } from '../../db/client'
import {
  cancellationRequests,
  folioLineExtras,
  folioLines,
  folios,
  organizations,
  slots,
  users,
} from '../../db/schema'
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
const readFolio = async (db: Db, org: string, folioId: string) => {
  const folioRows = await db
    .select({
      id: folios.id,
      agentId: folios.agentId,
      agentName: users.name,
      status: folios.status,
      paymentMethod: folios.paymentMethod,
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
    .where(and(eq(folios.id, folioId), eq(folios.organizationId, org)))
    .limit(1)

  const folio = folioRows[0]
  if (!folio) return null

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
    status: folio.status,
    payment_method: folio.paymentMethod,
    customer_name: folio.customerName,
    customer_email: folio.customerEmail,
    customer_phone: folio.customerPhone,
    subtotal: folio.subtotal,
    discount_total: folio.discountTotal,
    total: folio.total,
    amount_paid: folio.amountPaid,
    commission_amount: folio.commissionAmount,
    cancelled_at: tsOrNull(folio.cancelledAt),
    cancelled_by: folio.cancelledBy,
    cancellation_reason: folio.cancellationReason,
    cancellation_clawback: folio.cancellationClawback,
    refund_status: folio.refundStatus,
    refund_amount: folio.refundAmount,
    refund_note: folio.refundNote,
    refunded_at: tsOrNull(folio.refundedAt),
    refunded_by: folio.refundedBy,
    created_at: Math.floor(folio.createdAt.getTime() / 1000),
    lines: lineRows.map((line) => ({
      id: line.id,
      service_id: line.serviceId,
      slot_id: line.slotId,
      service_name: line.serviceName,
      slot_date: line.slotDate,
      slot_start_time: line.slotStartTime,
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

  const filters = [eq(folios.organizationId, org)]
  if (statusQ === 'paid' || statusQ === 'booking' || statusQ === 'cancelled') {
    filters.push(eq(folios.status, statusQ))
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
      status: folios.status,
      total: folios.total,
      amountPaid: folios.amountPaid,
      createdAt: folios.createdAt,
      cancelledAt: folios.cancelledAt,
    })
    .from(folios)
    .innerJoin(users, eq(folios.agentId, users.id))
    .where(and(...filters))
    .orderBy(desc(folios.createdAt))

  return c.json({
    folios: rows.map((r) => ({
      id: r.id,
      agent: { id: r.agentId, name: r.agentName },
      customer_name: r.customerName,
      status: r.status,
      total: r.total,
      amount_paid: r.amountPaid,
      created_at: Math.floor(r.createdAt.getTime() / 1000),
      cancelled_at: tsOrNull(r.cancelledAt),
    })),
  })
}

// US-A21 — one folio's detail (confirm before cancelling). 404 cross-org/unknown.
export const getFolioDetail = async (c: FoliosContext) => {
  const admin = c.get('user')
  const id = c.req.param('id')
  const db = getDb(c.env)

  const folio = await readFolio(db, admin.organizationId, id)
  if (!folio) {
    throw new ApiError('NOT_FOUND', 404, 'Folio not found')
  }

  return c.json({ folio })
}

// The atomic cancellation statements (US-A21): per line `slots.booked = MAX(0, booked −
// quantity)` (clamped so a manually edited slot can never go negative), then the folio
// UPDATE guarded `status != 'cancelled'` as a race backstop. Shared by the direct admin
// cancel and the tourist-request approval — ONE cancellation path, two entrances.
const buildCancellationBatch = (
  db: Db,
  org: string,
  folioId: string,
  lines: Array<{ slotId: string; quantity: number }>,
  now: Date,
  folioUpdate: Partial<typeof folios.$inferInsert>,
): BatchItem<'sqlite'>[] => {
  const statements: BatchItem<'sqlite'>[] = lines.map((line) =>
    db
      .update(slots)
      .set({
        booked: sql`MAX(0, ${slots.booked} - ${line.quantity})`,
        updatedAt: now,
      })
      .where(and(eq(slots.id, line.slotId), eq(slots.organizationId, org))),
  )
  statements.push(
    db
      .update(folios)
      .set({ ...folioUpdate, updatedAt: now })
      .where(
        and(
          eq(folios.id, folioId),
          eq(folios.organizationId, org),
          ne(folios.status, 'cancelled'),
        ),
      ),
  )
  return statements
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
  const orgName = orgRows[0]?.name ?? 'GuideMe'

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
    .select({ slotId: folioLines.slotId, quantity: folioLines.quantity })
    .from(folioLines)
    .where(and(eq(folioLines.folioId, id), eq(folioLines.organizationId, org)))

  const now = new Date()
  const statements = buildCancellationBatch(db, org, id, lines, now, {
    status: 'cancelled',
    cancelledAt: now,
    cancelledBy: admin.userId,
    cancellationReason: input.reason ?? null,
    cancellationClawback: input.clawback ?? false,
  })

  await db.batch(statements as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]])

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

// US-T04 → US-A21 — APPROVE a tourist's cancellation request: runs the same atomic
// cancellation as the direct admin cancel (seats released, status flipped, email sent),
// marks the request approved, and — when the folio was PAID — opens the refund obligation
// (US-A23): refund_status='pending', refund_amount = amount_paid, and a freshly generated
// Refund PIN the tourist will read in their portal (D5/D6). Cancellation + request flip +
// refund fields commit in ONE batch so a failure can never wedge the request.
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
  const statements = buildCancellationBatch(db, org, folio.id, lines, now, {
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
  statements.push(
    db
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
      ),
  )

  await db.batch(statements as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]])

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
