import type { Context } from 'hono'
import type { BatchItem } from 'drizzle-orm/batch'
import { and, asc, desc, eq, ne, sql } from 'drizzle-orm'
import { getDb, type Db } from '../../db/client'
import { folioLineExtras, folioLines, folios, slots, users } from '../../db/schema'
import { ApiError } from '../../types/errors'
import type { AppVariables } from '../../types/context'
import type { CancelFolioInput } from './schema'

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
      customerName: folios.customerName,
      customerEmail: folios.customerEmail,
      customerPhone: folios.customerPhone,
      subtotal: folios.subtotal,
      discountTotal: folios.discountTotal,
      total: folios.total,
      amountPaid: folios.amountPaid,
      cancelledAt: folios.cancelledAt,
      cancelledBy: folios.cancelledBy,
      cancellationReason: folios.cancellationReason,
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
    customer_name: folio.customerName,
    customer_email: folio.customerEmail,
    customer_phone: folio.customerPhone,
    subtotal: folio.subtotal,
    discount_total: folio.discountTotal,
    total: folio.total,
    amount_paid: folio.amountPaid,
    cancelled_at: tsOrNull(folio.cancelledAt),
    cancelled_by: folio.cancelledBy,
    cancellation_reason: folio.cancellationReason,
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

// US-A21 — cancel the whole folio: release every line's spots and record the cancellation.
//
// D1 has no interactive transactions, so the release + flip is one atomic batch (rolls back
// as a unit): per line `slots.booked = MAX(0, booked − quantity)` (clamped so a manually
// edited slot can never go negative), then the folio UPDATE guarded `status != 'cancelled'`
// as a race backstop. A pre-check returns 409 for an already-cancelled folio so spots are
// never released twice. Tickets follow status — the scanner's CANCELLED gate handles them.
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
      .set({
        status: 'cancelled',
        cancelledAt: now,
        cancelledBy: admin.userId,
        cancellationReason: input.reason ?? null,
        updatedAt: now,
      })
      .where(
        and(
          eq(folios.id, id),
          eq(folios.organizationId, org),
          ne(folios.status, 'cancelled'),
        ),
      ),
  )

  await db.batch(statements as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]])

  const folioOut = await readFolio(db, org, id)
  return c.json({ folio: folioOut })
}
