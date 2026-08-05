import { and, eq, gte, lte, ne, sql } from 'drizzle-orm'
import { getDb, type Db } from '../../db/client'
import { folioLines, folios, organizations } from '../../db/schema'
import { emitNotification } from '../../utils/notifications'
import { naiveEpoch } from '../../utils/tz'

// US-T08 — the departure reminder, and the review request.
// Spec: docs/folios/folio-state-machine.spec.md (Phase 4; D19, D20, D24).
//
// These are the only two notifications the CLOCK produces besides the apartado's stage-② notice
// (D19) — everything else in the whitelist rides a tap somebody was already making. The reminder is
// also the one event that SCALES: an operator with forty departures a day pays forty taps for it,
// which is the single place `customer_email` changes the economics.
//
// Both emit into the outbox and send nothing themselves. That is deliberate: emitting is idempotent
// through `uq_notifications_folio_event_channel`, so this sweep can run every fifteen minutes, be
// retried, or overlap itself without a customer ever getting the same message twice.

export interface ReminderSweepResult {
  reminded: number
  reviews: number
  failed: number
}

/** Hours before a departure at which the reminder fires. Fixed, not configurable — see below. */
const REMINDER_LEAD_HOURS = 24
/** Hours AFTER a departure at which the review request fires. */
const REVIEW_LAG_HOURS = 2
/**
 * How far either window may look back before giving up. A folio whose moment passed while the
 * Worker was down is reminded late rather than never — but a reminder for a tour that left three
 * days ago is noise, so the catch-up is bounded rather than open.
 */
const CATCH_UP_HOURS = 6

/**
 * Departure reminders (US-T08) and review requests, in one pass over the same rows.
 *
 * Anchored on the EARLIEST departure of a paid folio, resolved in the organization's own zone —
 * never UTC. Reading a naive `'2026-08-20 09:00'` against a UTC clock is what made a three-hours-away
 * slot look like tomorrow (migration 0052), and a reminder that fires on the wrong day is worse than
 * none: it teaches the customer to ignore the next one.
 *
 * Fail-soft per organization, like the apartado sweep: one org that throws must not abort the run.
 */
export async function sweepDepartureReminders(
  env: CloudflareBindings,
  now = new Date(),
): Promise<ReminderSweepResult> {
  const db: Db = getDb(env)
  const nowEpoch = Math.floor(now.getTime() / 1000)
  const result: ReminderSweepResult = { reminded: 0, reviews: 0, failed: 0 }

  const orgs = await db
    .select({ id: organizations.id, tz: organizations.timezone })
    .from(organizations)

  for (const org of orgs) {
    try {
      // A generous SQL pre-filter on the naive date, narrowed exactly in JS once the zone is known.
      // The wall-clock string cannot be compared to an instant in SQL, so the day window is the
      // widest thing the query can honestly do.
      const from = new Date((nowEpoch - CATCH_UP_HOURS * 3600) * 1000).toISOString().slice(0, 10)
      const to = new Date((nowEpoch + (REMINDER_LEAD_HOURS + 24) * 3600) * 1000)
        .toISOString()
        .slice(0, 10)

      const rows = await db
        .select({
          folioId: folios.id,
          slotDate: folioLines.slotDate,
          slotStartTime: folioLines.slotStartTime,
          checkIn: folioLines.checkIn,
          lineType: folioLines.lineType,
          customerEmail: folios.customerEmail,
          redeemedCount: folioLines.redeemedCount,
          quantity: folioLines.quantity,
        })
        .from(folioLines)
        .innerJoin(folios, eq(folioLines.folioId, folios.id))
        .where(
          and(
            eq(folioLines.organizationId, org.id),
            eq(folios.organizationId, org.id),
            // Only a PAID folio is reminded. An apartado has its own notice — the stage-② one —
            // and reminding somebody about a tour they have not finished paying for, without
            // mentioning the balance, would be the wrong message entirely.
            eq(folios.status, 'paid'),
            ne(folios.paymentVerification, 'pending'),
            gte(sql`COALESCE(${folioLines.slotDate}, ${folioLines.checkIn})`, from),
            lte(sql`COALESCE(${folioLines.slotDate}, ${folioLines.checkIn})`, to),
          ),
        )

      // One notification per FOLIO, not per line: a folio with three tours is one customer, and
      // three messages about the same trip is the kind of thing that gets a number blocked.
      // The earliest departure is the one worth reminding about.
      const earliest = new Map<string, { at: number; hasEmail: boolean }>()
      const latestPast = new Map<string, { at: number; hasEmail: boolean; used: boolean }>()

      for (const r of rows) {
        const day = r.lineType === 'stay' ? r.checkIn : r.slotDate
        if (!day) continue
        const at = naiveEpoch(day, r.lineType === 'stay' ? '00:00' : (r.slotStartTime ?? '00:00'), org.tz)

        const prev = earliest.get(r.folioId)
        if (!prev || at < prev.at) earliest.set(r.folioId, { at, hasEmail: !!r.customerEmail })

        if (at <= nowEpoch) {
          const p = latestPast.get(r.folioId)
          const used = r.redeemedCount > 0
          if (!p || at > p.at) {
            latestPast.set(r.folioId, { at, hasEmail: !!r.customerEmail, used: used })
          } else if (used) {
            latestPast.set(r.folioId, { ...p, used: true })
          }
        }
      }

      for (const [folioId, d] of earliest) {
        const dueAt = d.at - REMINDER_LEAD_HOURS * 3600
        // The window opens at T−24h and closes CATCH_UP_HOURS later, so a Worker that was down
        // still reminds — late — rather than skipping the customer entirely.
        if (nowEpoch < dueAt || nowEpoch > dueAt + CATCH_UP_HOURS * 3600) continue
        await emitNotification(db, {
          organizationId: org.id,
          folioId,
          event: 'departure_reminder',
          hasEmail: d.hasEmail,
        })
        result.reminded++
      }

      for (const [folioId, d] of latestPast) {
        // Only somebody who actually came is asked how it went. Sending "¿cómo te fue?" to a
        // customer who never boarded is the worst message in the whitelist, and the fulfilment
        // axis (US-A85) is exactly what makes it avoidable.
        if (!d.used) continue
        const dueAt = d.at + REVIEW_LAG_HOURS * 3600
        if (nowEpoch < dueAt || nowEpoch > dueAt + CATCH_UP_HOURS * 3600) continue
        await emitNotification(db, {
          organizationId: org.id,
          folioId,
          event: 'review_requested',
          hasEmail: d.hasEmail,
        })
        result.reviews++
      }
    } catch (err) {
      console.error('[reminders] org sweep failed', org.id, err)
      result.failed++
    }
  }

  return result
}
