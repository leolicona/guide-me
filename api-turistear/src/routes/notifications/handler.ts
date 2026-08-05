import type { Context } from 'hono'
import { and, eq } from 'drizzle-orm'
import { getDb } from '../../db/client'
import { folios, notifications } from '../../db/schema'
import { ApiError } from '../../types/errors'
import type { AppVariables } from '../../types/context'
import { EVENTS, readOutbox, type NotificationEvent } from '../../utils/notifications'

type NotificationsContext = Context<{
  Bindings: CloudflareBindings
  Variables: AppVariables
}>

const tsOrNull = (d: Date | null) => (d ? Math.floor(d.getTime() / 1000) : null)

/**
 * The admin's outbox (US-A86). Read-only oversight over the whole organization.
 *
 * There is no seller equivalent, on purpose (D13): US-AG50 decided the seller sees "the card, not
 * the admin's work queue". An action-tail leaves with the tap that produced it, and clock-produced
 * work reaches a seller as a rung on their card's single suggested action — so an inbox would be a
 * surface with nothing on it that the card does not already say.
 */
export const listNotifications = async (c: NotificationsContext) => {
  const admin = c.get('user')
  const db = getDb(c.env)

  const statusQ = c.req.query('status')
  const channelQ = c.req.query('channel')

  const rows = await readOutbox(db, admin.organizationId, {
    status:
      statusQ === 'pending' || statusQ === 'sent' || statusQ === 'failed' || statusQ === 'skipped'
        ? statusQ
        : undefined,
    channel: channelQ === 'email' || channelQ === 'whatsapp' ? channelQ : undefined,
  })

  return c.json({
    notifications: rows.map((r) => ({
      id: r.id,
      folio_id: r.folioId,
      event: r.event,
      channel: r.channel,
      status: r.status,
      attempts: r.attempts,
      last_error: r.lastError,
      sent_at: tsOrNull(r.sentAt),
      sent_by: r.sentBy,
      created_at: tsOrNull(r.createdAt),
      customer_name: r.customerName,
      customer_phone: r.customerPhone,
      // The message itself, so the drain screen can open the composer without a second read.
      template: EVENTS[r.event as NotificationEvent]?.template ?? null,
    })),
  })
}

/**
 * Drain one WhatsApp row: a human confirms they sent it (D21).
 *
 * What this records is that someone SENT it, never that the customer received it — `tickets_viewed_at`
 * is the only beacon in the product that means the second thing, and no row here may set it.
 *
 * D26 — the `tickets_delivered` drain is the ONLY writer of `folios.tickets_sent_at`. Re-homing the
 * sends onto the outbox created two records of one tap; making one write produce both is what stops
 * them drifting.
 */
export const markNotificationSent = async (c: NotificationsContext) => {
  const user = c.get('user')
  const org = user.organizationId
  const db = getDb(c.env)
  const id = c.req.param('id')

  const [row] = await db
    .select({
      id: notifications.id,
      folioId: notifications.folioId,
      event: notifications.event,
      channel: notifications.channel,
      status: notifications.status,
      agentId: folios.agentId,
    })
    .from(notifications)
    .innerJoin(folios, eq(notifications.folioId, folios.id))
    .where(and(eq(notifications.id, id), eq(notifications.organizationId, org)))
    .limit(1)

  // 404 for a row that belongs to another organization — never 403, which would confirm it exists.
  if (!row) {
    throw new ApiError('NOTIFICATION_NOT_FOUND', 404, 'Notification not found')
  }
  // An email row drains itself. A human marking one `sent` would be asserting something they did
  // not do, which is exactly what D21 says this column must never contain.
  if (row.channel !== 'whatsapp') {
    throw new ApiError(
      'NOTIFICATION_NOT_DRAINABLE',
      422,
      'Solo un mensaje de WhatsApp se marca como enviado a mano; el correo se envía solo.',
    )
  }
  if (row.status !== 'pending') {
    throw new ApiError('NOTIFICATION_ALREADY_SENT', 409, 'Ese mensaje ya fue atendido')
  }
  // The folio's own seller, or an admin. An agent may not drain someone else's sale.
  if (user.role !== 'admin' && row.agentId !== user.userId) {
    throw new ApiError('NOTIFICATION_NOT_FOUND', 404, 'Notification not found')
  }

  const now = new Date()
  const writes = [
    db
      .update(notifications)
      .set({ status: 'sent', sentAt: now, sentBy: user.userId })
      .where(and(eq(notifications.id, id), eq(notifications.organizationId, org))),
  ]

  // D26 — one write produces both records, so the folio's delivery axis and this row cannot
  // disagree about whether the tickets went out.
  if (row.event === 'tickets_delivered') {
    writes.push(
      db
        .update(folios)
        .set({ ticketsSentAt: now, ticketsSentBy: user.userId, updatedAt: now })
        .where(and(eq(folios.id, row.folioId), eq(folios.organizationId, org))),
    )
  }

  await db.batch(writes as [(typeof writes)[number], ...(typeof writes)[number][]])

  return c.json({ notification: { id, status: 'sent', sent_at: Math.floor(now.getTime() / 1000) } })
}
