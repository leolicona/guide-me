import { and, eq, sql } from 'drizzle-orm'
import type { Db } from '../../db/client'
import {
  folioLines,
  folioRequests,
  folios,
  notifications,
  organizations,
  services,
  slots,
} from '../../db/schema'
import { ApiError } from '../../types/errors'
import { naiveEpoch } from '../../utils/tz'
import { emitNotification } from '../../utils/notifications'
import { folioEventRow } from '../../utils/folioEvents'
import { signLineTickets } from './handler'

// US-AG52 — reagendar mientras el lugar es tuyo.
// Spec: docs/bookings/booking-reschedule.spec.md (D1, D2, D11–D17; rules 1–11).
//
// The operation this file exists to make possible is the CHEAP one, and the product never had it.
// In ① and ② the seats are already the customer's: moving a hold you own takes nothing from anybody,
// no ladder runs, no retention is taken, and no money is re-decided. Cancelling was the only tool,
// and cancelling prices the customer.
//
// Two things it is NOT:
//   · not automatic (D2) — a machine choosing a date for an absent customer takes a seat from the
//     pool and gives it to somebody who has just demonstrated they do not arrive;
//   · not a different service (D11) — that needs re-quoting, and a deposit silently over- or
//     under-covering a new price is exactly the quiet money bug the scope boundary forbids.

export interface RescheduleMove {
  folio_line_id: string
  to_slot_id: string
}

interface Ctx {
  db: Db
  org: string
  /** The seller or admin who agreed it with the customer — D13's signature. */
  actorId: string
  folioId: string
  moves: RescheduleMove[]
  nowSec: number
  /** US-A24 — how the move was agreed: at the counter, or a portal petition the admin approved. */
  origin: 'counter' | 'tourist_request'
}

/**
 * Move one or more lines of a live folio to other departures of the same service.
 *
 * The guards run in an order chosen deliberately: everything that can refuse is checked BEFORE any
 * seat moves, and the destination is secured before the source is released (rule 3). A failed
 * reschedule must never leave the customer with no seat at all — which is the one outcome worse
 * than refusing.
 */
export const rescheduleFolio = async (ctx: Ctx) => {
  const { db, org, folioId, moves, nowSec, actorId, origin } = ctx

  // One move per line per call. Two moves naming the same line would both resolve against the
  // line's ORIGINAL slot: capacity taken in two destinations, the source released twice, and the
  // first destination left carrying booked seats no line points at — phantom inventory.
  const lineIds = moves.map((m) => m.folio_line_id)
  if (new Set(lineIds).size !== lineIds.length) {
    throw new ApiError(
      'VALIDATION_ERROR',
      400,
      'Cada línea solo puede moverse una vez por operación.',
    )
  }

  const [folio] = await db
    .select({
      id: folios.id,
      status: folios.status,
      agentId: folios.agentId,
      customerEmail: folios.customerEmail,
      paymentVerification: folios.paymentVerification,
    })
    .from(folios)
    .where(and(eq(folios.id, folioId), eq(folios.organizationId, org)))
    .limit(1)

  if (!folio) throw new ApiError('NOT_FOUND', 404, 'Folio not found')

  // Rule 1 — a live apartado OR a paid sale (D16). A cancelled folio has nothing to move: its seats
  // went back to the pool and the ladder already priced it.
  if (folio.status !== 'booking' && folio.status !== 'paid') {
    throw new ApiError(
      'NOT_RESCHEDULABLE',
      409,
      'Solo se puede reagendar un apartado vigente o una venta pagada.',
    )
  }

  const [org_] = await db
    .select({
      tz: organizations.timezone,
      salesCutoff: organizations.salesCutoffOffsetMinutes,
      grace: organizations.bookingGraceOffsetMinutes,
      buffer: organizations.bookingPreDepartureBufferHours,
      creationCutoff: organizations.bookingCreationCutoffHours,
      noShowMargin: organizations.noShowMarginMinutes,
    })
    .from(organizations)
    .where(eq(organizations.id, org))
    .limit(1)
  const tz = org_?.tz ?? 'America/Mexico_City'
  const salesCutoff = org_?.salesCutoff ?? 0
  const grace = org_?.grace ?? 15
  const buffer = org_?.buffer ?? 24
  const creationCutoff = org_?.creationCutoff ?? 0
  const noShowMargin = org_?.noShowMargin ?? 0

  // Rule 1's second half — "only before the line's release instant". `status` alone is not enough:
  // the sweep runs every 15 minutes, so an apartado past its grace instant can sit un-cancelled for
  // up to one cron interval. Rescheduling it there would extend stage ② by cron jitter — the hold
  // ended at the instant the CLOCK says, not the instant the sweep gets around to it (the same
  // stage-is-derived principle as apartado-stages S7).
  if (folio.status === 'booking') {
    const currentLines = await db
      .select({ slotDate: folioLines.slotDate, slotStartTime: folioLines.slotStartTime })
      .from(folioLines)
      .where(and(eq(folioLines.folioId, folioId), eq(folioLines.organizationId, org)))
    const currentDepartures = currentLines
      .map((l) => (l.slotDate ? naiveEpoch(l.slotDate, l.slotStartTime ?? '00:00', tz) : null))
      .filter((e): e is number => e !== null)
    if (
      currentDepartures.length > 0 &&
      nowSec >= Math.min(...currentDepartures) - grace * 60
    ) {
      throw new ApiError(
        'NOT_RESCHEDULABLE',
        409,
        'El apartado ya llegó a su instante de liberación; los lugares vuelven al inventario.',
      )
    }
  }

  // --- Resolve every move before touching a single seat -----------------------------------------

  const resolved: {
    lineId: string
    fromSlotId: string
    fromDate: string | null
    fromTime: string | null
    toSlotId: string
    quantity: number
    zoneId: string | null
    toDate: string
    toTime: string
    toEpoch: number
    isFlexible: boolean
    flexPct: number
  }[] = []

  for (const move of moves) {
    const [line] = await db
      .select({
        id: folioLines.id,
        slotId: folioLines.slotId,
        serviceId: folioLines.serviceId,
        quantity: folioLines.quantity,
        zoneId: folioLines.zoneId,
        lineType: folioLines.lineType,
        slotDate: folioLines.slotDate,
        slotStartTime: folioLines.slotStartTime,
        redeemedCount: folioLines.redeemedCount,
      })
      .from(folioLines)
      .where(
        and(
          eq(folioLines.id, move.folio_line_id),
          eq(folioLines.folioId, folioId),
          eq(folioLines.organizationId, org),
        ),
      )
      .limit(1)
    if (!line) throw new ApiError('NOT_FOUND', 404, 'Folio line not found')

    // A stay is nights under a per-night guard, not a slot. Deferred with its own scenarios rather
    // than smuggled in behind an `if`.
    if (line.lineType !== 'slot' || !line.slotId) {
      throw new ApiError(
        'NOT_RESCHEDULABLE',
        409,
        'Por ahora solo se reagendan líneas de tour, no estancias.',
      )
    }

    // D19 — on a PAID folio the door closes per line, at the same instant the seat starts reading
    // wasted (the no-show margin, one clock with the fulfilment axis). Rescheduling a departed
    // line would erase the no-show reading retroactively — the wasted-seat count would be
    // rewritable by whoever insists hardest at a counter, and the no-show policy would be
    // optional. The courtesy path for a customer the seller wants to keep is a negotiated manual
    // discount on a NEW sale: bounded by the minimum price, recorded, auditable. A line with
    // redeemed passes is refused for the stronger reason: it was (partly) consumed.
    if (folio.status === 'paid') {
      if (line.redeemedCount > 0) {
        throw new ApiError(
          'NOT_RESCHEDULABLE',
          409,
          'Esa línea ya tiene pases usados; un servicio consumido no se mueve.',
        )
      }
      const departed = line.slotDate
        ? naiveEpoch(line.slotDate, line.slotStartTime ?? '00:00', tz)
        : null
      if (departed !== null && nowSec > departed - noShowMargin * 60) {
        throw new ApiError(
          'NOT_RESCHEDULABLE',
          409,
          'La salida ya pasó: un no-show no se reagenda. La cortesía, si se acuerda, es un descuento en una venta nueva.',
        )
      }
    }

    const [dest] = await db
      .select({
        id: slots.id,
        serviceId: slots.serviceId,
        date: slots.date,
        startTime: slots.startTime,
        status: slots.status,
        isFlexible: services.isFlexible,
        flexPct: services.flexCapacityPct,
        serviceStatus: services.status,
      })
      .from(slots)
      .innerJoin(services, eq(slots.serviceId, services.id))
      .where(and(eq(slots.id, move.to_slot_id), eq(slots.organizationId, org)))
      .limit(1)
    // A destination in another organization is simply not found — never 403, which would confirm
    // that somebody else's slot exists.
    if (!dest || dest.status !== 'active' || dest.serviceStatus !== 'active') {
      throw new ApiError('NOT_FOUND', 404, 'Slot not found')
    }

    // Rule 2 (D11) — same service. A different one is a different sale: it needs re-quoting, and
    // the line's snapshotted `unit_price` would no longer be the price anybody agreed to.
    if (dest.serviceId !== line.serviceId) {
      throw new ApiError(
        'DIFFERENT_SERVICE',
        422,
        'Solo se puede mover a otro horario del mismo servicio.',
      )
    }

    const toEpoch = naiveEpoch(dest.date, dest.startTime, tz)

    // Rule 4 — the destination must still be sellable. Moving onto a departed slot would recreate
    // the thing the sales cutoff exists to prevent.
    if (toEpoch <= nowSec + salesCutoff * 60) {
      throw new ApiError('SLOT_CLOSED', 409, 'Ese horario ya cerró sus ventas.')
    }

    // Rules 5 and 5b apply to an APARTADO only: a paid sale has no settle deadline to be born
    // inside of, and no expiry to land in the past.
    if (folio.status === 'booking') {
      // Rule 5 — the destination must satisfy the apartado creation cutoff, or a reschedule becomes
      // a back door onto the one-minute apartado that cutoff exists to forbid.
      if (creationCutoff > 0 && (toEpoch - nowSec) / 3600 < creationCutoff) {
        throw new ApiError(
          'BOOKING_TOO_LATE',
          422,
          'Ese horario está demasiado cerca para sostener un apartado.',
        )
      }
      // Rule 5b (BUG-029) — the recomputed expiry must be in the future. With `creationCutoff = 0`
      // the guard above does not run at all, so without this a reschedule could write a hold that
      // was already over and the sweep would cancel the folio on its next run.
      const nearDeparture = toEpoch - nowSec < buffer * 3_600
      const expiry = toEpoch - (nearDeparture ? grace * 60 : buffer * 3_600)
      if (expiry <= nowSec) {
        throw new ApiError(
          'BOOKING_TOO_LATE',
          422,
          'Ese horario dejaría el apartado vencido en el momento de moverlo.',
        )
      }
    }

    resolved.push({
      lineId: line.id,
      fromSlotId: line.slotId,
      fromDate: line.slotDate,
      fromTime: line.slotStartTime,
      toSlotId: dest.id,
      quantity: line.quantity,
      zoneId: line.zoneId,
      toDate: dest.date,
      toTime: dest.startTime,
      toEpoch,
      isFlexible: dest.isFlexible,
      flexPct: dest.flexPct,
    })
  }

  // --- Secure the destinations, THEN release the sources -----------------------------------------

  const taken: { slotId: string; qty: number }[] = []
  const releaseTaken = async () => {
    for (const t of taken) {
      await db
        .update(slots)
        .set({ booked: sql`${slots.booked} - ${t.qty}`, updatedAt: new Date() })
        .where(and(eq(slots.id, t.slotId), eq(slots.organizationId, org)))
    }
  }

  for (const r of resolved) {
    // Rule 3 — the SAME atomic effective-capacity guard `confirmSale` applies. Reused rather than
    // re-implemented: a second copy of this arithmetic is a second thing that can drift.
    const flexMargin =
      r.isFlexible && r.flexPct > 0
        ? sql`((${slots.capacity} * ${r.flexPct}) / 100)`
        : sql`0`
    const won = await db
      .update(slots)
      .set({ booked: sql`${slots.booked} + ${r.quantity}`, updatedAt: new Date() })
      .where(
        and(
          eq(slots.id, r.toSlotId),
          eq(slots.organizationId, org),
          sql`${slots.capacity} + ${flexMargin} - ${slots.booked} >= ${r.quantity}`,
        ),
      )
      .returning({ id: slots.id })

    if (won.length === 0) {
      // Give back whatever this call had already taken. The source is untouched at this point, so
      // the customer still has the seat they started with — which is the property S-3 pins.
      await releaseTaken()
      throw new ApiError(
        'NO_CAPACITY_AVAILABLE',
        409,
        'Ese horario ya no tiene lugar para todo el grupo.',
      )
    }
    taken.push({ slotId: r.toSlotId, qty: r.quantity })
  }

  // Every destination is secured. Now the sources can go back to the pool.
  const now = new Date()
  for (const r of resolved) {
    await db
      .update(slots)
      .set({ booked: sql`MAX(0, ${slots.booked} - ${r.quantity})`, updatedAt: now })
      .where(and(eq(slots.id, r.fromSlotId), eq(slots.organizationId, org)))

    await db
      .update(folioLines)
      .set({ slotId: r.toSlotId, slotDate: r.toDate, slotStartTime: r.toTime })
      .where(and(eq(folioLines.id, r.lineId), eq(folioLines.organizationId, org)))

    // D13 — the record that makes "agreed with the customer" checkable. A counter reschedule is
    // written already resolved (D13b): a row that is never `pending` never touches the partial
    // index, so it cannot collide with a tourist's open petition.
    await db.insert(folioRequests).values({
      id: crypto.randomUUID(),
      organizationId: org,
      folioId,
      kind: 'reschedule',
      status: 'approved',
      folioLineId: r.lineId,
      fromSlotId: r.fromSlotId,
      toSlotId: r.toSlotId,
      resolvedBy: actorId,
      resolvedAt: now,
    })

    // US-A24 — the narrative row, one per moved line (mirrors D13's per-line record). This is the
    // trace a counter reschedule never left on the folio itself: the line now asserts it was
    // always on the new date, and only this row says otherwise.
    await folioEventRow(db, {
      organizationId: org,
      folioId,
      type: 'rescheduled',
      actorId,
      payload: {
        origin,
        from_date: r.fromDate,
        from_time: r.fromTime,
        to_date: r.toDate,
        to_time: r.toTime,
      },
      at: now,
    })
  }

  // --- What the move implies for the rest of the folio -------------------------------------------

  if (folio.status === 'booking') {
    // Rule 6 / D17 — recompute from the NEW earliest departure across the whole folio. Under this
    // rule the sentence "pagas 24 h antes de tu primer tour" stays TRUE; freezing the old deadline
    // or ratcheting it would make it false, and neither can be explained at a counter.
    const lineRows = await db
      .select({ slotDate: folioLines.slotDate, slotStartTime: folioLines.slotStartTime })
      .from(folioLines)
      .where(and(eq(folioLines.folioId, folioId), eq(folioLines.organizationId, org)))

    const departures = lineRows
      .map((l) => (l.slotDate ? naiveEpoch(l.slotDate, l.slotStartTime ?? '00:00', tz) : null))
      .filter((e): e is number => e !== null)
    const earliest = Math.min(...departures)
    const nearDeparture = earliest - nowSec < buffer * 3_600
    const expiresAt = earliest - (nearDeparture ? grace * 60 : buffer * 3_600)

    await db
      .update(folios)
      .set({
        bookingExpiresAt: new Date(expiresAt * 1000),
        // D14 — the deadline moved, so the customer is owed a fresh warning for the new one. Today
        // neither would fire: the flag skips the sweep, and the unique index blocks a second
        // `booking_grace_entered`. The rows for the closed cycle go with it. Cost, accepted: the
        // audit of the first warning is lost — D13's record keeps the history from being blank, and
        // says the more useful thing anyway (the date moved).
        reminderStatus: 'none',
        reminderSentAt: null,
        reminderSentBy: null,
        updatedAt: now,
      })
      .where(and(eq(folios.id, folioId), eq(folios.organizationId, org)))

    await db
      .delete(notifications)
      .where(
        and(
          eq(notifications.organizationId, org),
          eq(notifications.folioId, folioId),
          eq(notifications.event, 'booking_grace_entered'),
        ),
      )
  }

  return { folio, resolved, tz }
}

/**
 * D16 — a `paid` folio's ticket carries the slot inside its signed payload, so a moved line
 * invalidates it. The old `/t/<token>` link stops resolving; the replacement travels in the
 * re-emitted message, which is tolerable precisely because D2 makes the change agreed — nobody's
 * ticket dies without them asking.
 *
 * The outbox rows are cleared first for the same reason D14 clears the stage-② ones: the unique
 * index guards duplicates WITHIN a cycle, and a reschedule opens a new one.
 */
export const reissueTicketsAfterReschedule = async (
  db: Db,
  env: CloudflareBindings,
  org: string,
  folioId: string,
  agentId: string,
  hasEmail: boolean,
  tz: string,
) => {
  // RE-SIGN, not just re-announce. The signed payload carries `expires_at`, derived from the line's
  // departure — a ticket moved to a LATER date would otherwise die before the tour it is for. (The
  // scanner reads the line's live row for everything else, so the stale `slot_id` inside the
  // payload is not what breaks; the expiry is.)
  const lineRows = await db
    .select({
      id: folioLines.id,
      serviceId: folioLines.serviceId,
      slotId: folioLines.slotId,
      quantity: folioLines.quantity,
      slotDate: folioLines.slotDate,
    })
    .from(folioLines)
    .where(and(eq(folioLines.folioId, folioId), eq(folioLines.organizationId, org)))

  const signable = lineRows.filter(
    (l): l is typeof l & { slotId: string; slotDate: string } => !!l.slotId && !!l.slotDate,
  )
  if (signable.length > 0) {
    const signed = await signLineTickets(env, org, folioId, agentId, signable, tz)
    for (const [lineId, { token }] of signed) {
      await db
        .update(folioLines)
        .set({ qrToken: token })
        .where(and(eq(folioLines.id, lineId), eq(folioLines.organizationId, org)))
    }
  }

  await db
    .delete(notifications)
    .where(
      and(
        eq(notifications.organizationId, org),
        eq(notifications.folioId, folioId),
        eq(notifications.event, 'tickets_delivered'),
      ),
    )
  await emitNotification(db, {
    organizationId: org,
    folioId,
    event: 'tickets_delivered',
    hasEmail,
  })
}


/**
 * Departures of the same service that could take this party, right now.
 *
 * A SNAPSHOT, never a hold. Nothing here is reserved: a suggested slot can fill up between the
 * moment this runs and the moment the customer answers, which is exactly why the copy that carries
 * these must say *"tenían lugar cuando te escribimos"* rather than *"elige uno"*. A suggestion read
 * as a promise makes the second disappointment worse than the first.
 *
 * Same query shape as the guard that refused, so the alternatives cost one read rather than two.
 */
export const viableAlternatives = async (
  db: Db,
  org: string,
  serviceId: string,
  quantity: number,
  nowSec: number,
  tz: string,
  salesCutoffMinutes: number,
  /**
   * Present when the folio is a live APARTADO: rules 5 and 5b apply to it, so a slot the
   * reschedule itself would refuse with BOOKING_TOO_LATE must not be suggested. A stale
   * suggestion is a snapshot; a slot that was NEVER takeable is a false promise.
   */
  hold?: { creationCutoffHours: number; bufferHours: number; graceMinutes: number },
  limit = 3,
): Promise<{ id: string; date: string; startTime: string; remaining: number }[]> => {
  const rows = await db
    .select({
      id: slots.id,
      date: slots.date,
      startTime: slots.startTime,
      capacity: slots.capacity,
      booked: slots.booked,
      isFlexible: services.isFlexible,
      flexPct: services.flexCapacityPct,
    })
    .from(slots)
    .innerJoin(services, eq(slots.serviceId, services.id))
    .where(
      and(
        eq(slots.organizationId, org),
        eq(slots.serviceId, serviceId),
        eq(slots.status, 'active'),
        eq(services.status, 'active'),
      ),
    )

  return rows
    .map((r) => {
      const margin = r.isFlexible && r.flexPct > 0 ? Math.floor((r.capacity * r.flexPct) / 100) : 0
      return {
        id: r.id,
        date: r.date,
        startTime: r.startTime,
        remaining: r.capacity + margin - r.booked,
        epoch: naiveEpoch(r.date, r.startTime, tz),
      }
    })
    // The same conditions the reschedule itself would apply: room for the whole party, still
    // sellable — and, for an apartado, a hold that would be born alive (rules 5/5b). Offering a
    // slot the move would refuse is a suggestion that cannot be taken.
    .filter((r) => {
      if (r.remaining < quantity || r.epoch <= nowSec + salesCutoffMinutes * 60) return false
      if (!hold) return true
      const { creationCutoffHours, bufferHours, graceMinutes } = hold
      if (creationCutoffHours > 0 && (r.epoch - nowSec) / 3600 < creationCutoffHours) return false
      const nearDeparture = r.epoch - nowSec < bufferHours * 3_600
      const expiry = r.epoch - (nearDeparture ? graceMinutes * 60 : bufferHours * 3_600)
      return expiry > nowSec
    })
    .sort((a, b) => a.epoch - b.epoch)
    .slice(0, limit)
    .map(({ id, date, startTime, remaining }) => ({ id, date, startTime, remaining }))
}
