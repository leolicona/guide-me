import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import { folios, notifications } from '../db/schema'

// The notification outbox — one producer, two drains.
// Spec: docs/folios/folio-state-machine.spec.md (US-A86 / US-AG51; D8, D12, D14, D16, D19–D21, D26).
//
// Two things to hold in mind reading this file.
//
// 1. **Only one of the two kinds is really a queue** (D12). An *action-tail* — a message a human
//    caused — leaves as the last step of that same tap and can never accumulate. A *clock-produced*
//    one has no gesture behind it, so it needs a surface. Six of the eight below are action-tails,
//    which is why the outbox is smaller than a "notification engine" sounds (D19).
//
// 2. **Every event is written to the customer by WhatsApp** (D20). Email is emitted ADDITIONALLY
//    when there is an address — a durable second copy, never a substitute. A channel chosen by how
//    much it costs us is a channel chosen against the customer.

/** The whitelist (D16). Never free text: an event outside this union cannot be emitted. */
export type NotificationEvent =
  | 'booking_created'
  | 'tickets_delivered'
  | 'payment_verified'
  | 'cancellation_approved'
  | 'payment_rejected'
  | 'booking_grace_entered'
  | 'departure_reminder'
  | 'refund_completed'

export type NotificationChannel = 'email' | 'whatsapp'

interface EventDef {
  /** Where it comes from — the only thing that varies between the eight (D19). */
  origin: 'action-tail' | 'clock'
  /** The shipped default message. D25: all eight have one; only two are editable. */
  template: string
  /** Which org template overrides it, when the admin has edited one. */
  editableAs?: 'ticket' | 'reminder'
}

// D25 — a shipped default for all eight, and only `tickets_delivered` / `booking_grace_entered`
// editable, because those are the two that already are. The other six are transactional statements
// of fact (*your transfer cleared*, *your sale was cancelled*, *here is your refund receipt*) where
// wording is not where an operator differentiates, and eight editable templates is a settings screen
// nobody finishes.
export const EVENTS: Record<NotificationEvent, EventDef> = {
  booking_created: {
    origin: 'action-tail',
    template:
      'Hola {customer_name}, tu apartado en {org_name} quedó registrado. ' +
      'Debes {pending_balance} de {total} y tienes hasta el {booking_expires_at} para liquidarlo. ' +
      'Cualquier duda, aquí estoy. — {agent_name}',
  },
  tickets_delivered: {
    origin: 'action-tail',
    editableAs: 'ticket',
    template:
      'Hola {customer_name}, aquí están tus boletos de {org_name}:\n{itinerary}\n{portal_link}',
  },
  payment_verified: {
    origin: 'action-tail',
    template:
      'Hola {customer_name}, confirmamos tu transferencia de {total}. ' +
      'Tu compra en {org_name} está lista. — {agent_name}',
  },
  cancellation_approved: {
    origin: 'action-tail',
    template:
      'Hola {customer_name}, aprobamos la cancelación de tu folio {folio_ref} en {org_name}. ' +
      'Te contamos enseguida cómo queda.',
  },
  payment_rejected: {
    origin: 'action-tail',
    template:
      'Hola {customer_name}, no pudimos confirmar el pago de tu folio {folio_ref}, ' +
      'así que tuvimos que cancelarlo. Si crees que es un error, escríbeme. — {agent_name}',
  },
  booking_grace_entered: {
    origin: 'clock',
    editableAs: 'reminder',
    template:
      'Hola {customer_name}, tu apartado en {org_name} vence pronto. ' +
      'Quedan {pending_balance} por liquidar; después de esa hora liberamos los lugares.',
  },
  departure_reminder: {
    origin: 'clock',
    template:
      'Hola {customer_name}, mañana es tu {itinerary}. ' +
      'Te esperamos — cualquier cosa, aquí estoy. — {agent_name}',
  },
  // D18 (withdrawn) tried to send this by email alone, to save a tap. It is an ACTION-TAIL — the
  // agent has just confirmed the PIN — so it chains onto that same gesture; and it is the single
  // most litigable moment in the product: cash, in person, no receipt, and a retention the customer
  // does not understand. "Pagué 3,000 y recibí 1,800, ¿dónde quedaron 1,200?" is answered nowhere
  // else, which is why the amounts are spelled out (business rule 13).
  refund_completed: {
    origin: 'action-tail',
    template:
      'Hola {customer_name}, confirmamos tu reembolso del folio {folio_ref} en {org_name}. ' +
      'Pagaste {amount_paid}, te devolvimos {refund_amount} y se retuvo {retained_amount} ' +
      'según la política de cancelación.',
  },
}

/**
 * Write the outbox rows for one event.
 *
 * D20 — a `whatsapp` row is written ALWAYS; the `email` row is written too, and marked `skipped`
 * (never `failed`) when there is no address. `skipped` means *this channel does not apply*, which is
 * a different fact from *the provider refused*, and the two must not be counted together.
 *
 * The insert is INSERT OR IGNORE against `uq_notifications_folio_event_channel` (business rule 9),
 * so a re-run of a sweep, a retried request or a double-tapped button cannot duplicate a message.
 *
 * Never throws: a failing outbox write must not fail the folio operation that caused it
 * (business rule 8, and the lesson of `apartado-stages.spec.md` S8 — counting a provider's bad
 * afternoon as apartados breaking).
 */
export const emitNotification = async (
  db: Db,
  input: {
    organizationId: string
    folioId: string
    event: NotificationEvent
    /** Whether the folio has an address on file. Decides `pending` vs `skipped` for the email row. */
    hasEmail: boolean
  },
): Promise<void> => {
  const rows = [
    { channel: 'whatsapp' as const, status: 'pending' as const },
    { channel: 'email' as const, status: input.hasEmail ? ('pending' as const) : ('skipped' as const) },
  ]
  try {
    await db
      .insert(notifications)
      .values(
        rows.map((r) => ({
          id: crypto.randomUUID(),
          organizationId: input.organizationId,
          folioId: input.folioId,
          event: input.event,
          channel: r.channel,
          status: r.status,
        })),
      )
      .onConflictDoNothing()
  } catch (err) {
    console.error('[outbox] emit failed', input.event, input.folioId, err)
  }
}

/**
 * Record the outcome of an email send that happened at its ORIGINAL call site.
 *
 * SCOPE DECISION, stated rather than hidden. The spec says the inline sends are "re-homed onto the
 * outbox". They are re-homed for *recording* — every send now stamps `sent` or `failed` here — but
 * the sends themselves stay where they are, and the email drain does NOT yet rebuild their payloads
 * to retry them.
 *
 * Why: each of the six emails assembles a different payload (ticket lines + QR + portal link, the
 * apartado's expiry, the cancellation outcome). Every one of those IS reconstructible from the
 * folio, so a generic retry is possible — it is simply a second feature's worth of code, and doing
 * it badly would put six working, tested email paths at risk to buy a retry for an outage that has
 * happened once.
 *
 * What this DOES deliver today, which is the whole reason the outbox exists:
 *   · an outage is RECORDED as `failed` with its error instead of vanishing into a `console.error`
 *   · the WhatsApp half becomes a real, drainable queue
 *   · `uq_notifications_folio_event_channel` makes a re-run unable to duplicate a message
 *
 * What it does not: automatically resend a failed email. That is listed under *Deferred* in the
 * spec, with this reason.
 */
export const recordEmailOutcome = async (
  db: Db,
  org: string,
  folioId: string,
  event: NotificationEvent,
  outcome: { ok: true } | { ok: false; error: string },
): Promise<void> => {
  try {
    await db
      .update(notifications)
      .set(
        outcome.ok
          ? { status: 'sent', sentAt: new Date(), sentBy: null }
          : {
              status: 'failed',
              attempts: sql`${notifications.attempts} + 1`,
              lastError: outcome.error.slice(0, 500),
            },
      )
      .where(
        and(
          eq(notifications.organizationId, org),
          eq(notifications.folioId, folioId),
          eq(notifications.event, event),
          eq(notifications.channel, 'email'),
        ),
      )
  } catch (err) {
    console.error('[outbox] recording an email outcome failed', event, folioId, err)
  }
}

/** Pending rows for one org, oldest first — the admin's outbox view and the drains share it. */
export const readOutbox = async (
  db: Db,
  org: string,
  filter: { status?: 'pending' | 'sent' | 'failed' | 'skipped'; channel?: NotificationChannel },
) => {
  const where = [eq(notifications.organizationId, org)]
  if (filter.status) where.push(eq(notifications.status, filter.status))
  if (filter.channel) where.push(eq(notifications.channel, filter.channel))

  return db
    .select({
      id: notifications.id,
      folioId: notifications.folioId,
      event: notifications.event,
      channel: notifications.channel,
      status: notifications.status,
      attempts: notifications.attempts,
      lastError: notifications.lastError,
      sentAt: notifications.sentAt,
      sentBy: notifications.sentBy,
      createdAt: notifications.createdAt,
      customerName: folios.customerName,
      customerPhone: folios.customerPhone,
    })
    .from(notifications)
    .innerJoin(folios, eq(notifications.folioId, folios.id))
    .where(and(...where))
    .orderBy(asc(notifications.createdAt))
    .limit(200)
}

/** Mark rows sent. Used by the email drain (`sentBy: null`) and the WhatsApp tap alike. */
export const markSent = (db: Db, org: string, ids: string[], sentBy: string | null) =>
  db
    .update(notifications)
    .set({ status: 'sent', sentAt: new Date(), sentBy })
    .where(and(eq(notifications.organizationId, org), inArray(notifications.id, ids)))

/** Record a provider refusal. The row stays `failed` and the next drain retries it — never dropped. */
export const markFailed = (db: Db, org: string, id: string, error: string) =>
  db
    .update(notifications)
    .set({
      status: 'failed',
      attempts: sql`${notifications.attempts} + 1`,
      lastError: error.slice(0, 500),
    })
    .where(and(eq(notifications.organizationId, org), eq(notifications.id, id)))
