import { and, eq, inArray, lte } from 'drizzle-orm'
import { getDb, type Db } from '../../db/client'
import { folioLines, folios, organizations } from '../../db/schema'
import { cancelFolioPriced } from '../folios/handler'
import { sendBookingReminderEmail } from '../../services/resend'
import { naiveEpoch } from '../../utils/tz'
import { emitNotification, recordEmailOutcome } from '../../utils/notifications'

// US-AG07 (P3) / US-A77 — the apartado sweep, run every 15 minutes by the scheduled Worker
// (src/index.tsx).
//
// It used to do one thing: cancel every booking past `booking_expires_at`. That made the settle
// deadline an EVENT — a customer who forgot to pay lost their deposit without a single message, and
// found out by finding out. The deadline is now a TRANSITION between two stages, and this sweep
// drives both:
//
//   ① RETENIDO  — until `booking_expires_at`. Nothing happens here.
//   ② GRACIA    — from `booking_expires_at` until `salida − gracia` (default 15 min). Entered
//                 automatically; on entry the customer is emailed that their spots are about to be
//                 released. Sales made close to departure are BORN here (their expiry was already
//                 computed as the grace instant), which is why entry is not a separate event.
//   cancel      — at the grace instant, priced by the cancellation ladder like every other
//                 cancellation. Fifteen minutes before departure the ladder is always in its
//                 terminal tier, which is what makes running the engine here safe by construction
//                 rather than by coincidence of defaults (engine spec D21, superseded).
//
// STAGE IS DERIVED, never stored. `booking_expires_at` is the ①→② boundary and the grace instant is
// computed from the line's own snapshotted departure, so no cron writes a state that the clock then
// contradicts. `reminder_status` is the notification guard, deliberately shared with the agent's
// manual WhatsApp claim: whoever told the customer first, the customer was told.
//
// Every write is filtered by the folio's OWN organization_id, so processing one org's row can never
// touch another's. Returns what happened, for the log.
export interface SweepResult {
  notified: number
  cancelled: number
  failed: number
}

export async function sweepExpiredBookings(env: CloudflareBindings): Promise<SweepResult> {
  const db = getDb(env)
  const now = new Date()
  const nowSec = Math.floor(now.getTime() / 1000)
  const result: SweepResult = { notified: 0, cancelled: 0, failed: 0 }

  // Everything past its stage-① boundary: candidates for BOTH a notification and a cancellation.
  // Which one each gets is decided per folio, below, by where the grace instant falls.
  const due = await db
    .select({
      id: folios.id,
      organizationId: folios.organizationId,
      customerEmail: folios.customerEmail,
      customerName: folios.customerName,
      total: folios.total,
      amountPaid: folios.amountPaid,
      reminderStatus: folios.reminderStatus,
    })
    .from(folios)
    .where(and(eq(folios.status, 'booking'), lte(folios.bookingExpiresAt, now)))

  if (due.length === 0) return result

  const orgIds = [...new Set(due.map((f) => f.organizationId))]
  const orgRows = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      timezone: organizations.timezone,
      graceOffsetMinutes: organizations.bookingGraceOffsetMinutes,
    })
    .from(organizations)
    .where(inArray(organizations.id, orgIds))
  const orgById = new Map(orgRows.map((o) => [o.id, o]))

  for (const folio of due) {
    // FAIL-SOFT PER FOLIO. The spec has claimed this since the engine landed; the code did not do
    // it — there was a single `.catch` on the scheduled handler, so one folio that threw aborted
    // the whole run and every apartado behind it silently kept its seats.
    try {
      const org = orgById.get(folio.organizationId)
      if (!org) {
        result.failed++
        continue
      }

      const lineRows = await db
        .select({
          slotId: folioLines.slotId,
          quantity: folioLines.quantity,
          zoneId: folioLines.zoneId,
          serviceName: folioLines.serviceName,
          slotDate: folioLines.slotDate,
          slotStartTime: folioLines.slotStartTime,
          checkIn: folioLines.checkIn,
        })
        .from(folioLines)
        .where(
          and(
            eq(folioLines.folioId, folio.id),
            eq(folioLines.organizationId, folio.organizationId),
          ),
        )

      // The protected instant: the earliest departure across the cart, in the ORG's zone. A stay
      // line departs at its check-in, 00:00 org-local (engine D11).
      const departures = lineRows
        .map((l) =>
          l.slotDate
            ? naiveEpoch(l.slotDate, l.slotStartTime ?? '00:00', org.timezone)
            : l.checkIn
              ? naiveEpoch(l.checkIn, '00:00', org.timezone)
              : null,
        )
        .filter((e): e is number => e !== null)

      // No readable departure means we cannot compute a grace instant. Cancel rather than hold
      // seats forever — the folio is already past its deadline and there is nothing to wait for.
      const graceInstant =
        departures.length > 0
          ? Math.min(...departures) - org.graceOffsetMinutes * 60
          : nowSec

      if (nowSec >= graceInstant) {
        const { won } = await cancelFolioPriced(
          db,
          folio.organizationId,
          folio.id,
          lineRows,
          now,
          {
            cancelledBy: null, // the system; there is no user
            reason: 'Apartado vencido',
            source: 'system_expiry',
          },
        )
        if (won) result.cancelled++
        continue
      }

      // Still inside the grace window: this folio has just entered stage ②. Tell the customer their
      // spots are about to go, once.
      if (folio.reminderStatus !== 'none') continue

      // US-A86 (D20) — the outbox row is written for EVERY folio entering ②, whether or not there
      // is an address: this is one of only two clock-produced events (D19), and the customer who
      // left no email is precisely the one who most needs the WhatsApp a seller will tap. Written
      // BEFORE the email is attempted, so an outage cannot make the event disappear.
      await emitNotification(db, {
        organizationId: folio.organizationId,
        folioId: folio.id,
        event: 'booking_grace_entered',
        hasEmail: !!folio.customerEmail,
      })

      if (!folio.customerEmail || !env.RESEND_API_KEY) continue

      // The send has its OWN guard, separate from the per-folio one. A Resend outage is not a
      // failed folio: the apartado is fine, it advanced to ② by the clock alone, and nothing about
      // it is stuck. Counting it under `failed` would make an email provider's bad afternoon read
      // as apartados breaking. It retries on the next run because the flag is written only after
      // the send succeeds — the one notification this customer gets is never silently consumed.
      try {
        await sendBookingReminderEmail(env, {
          to: folio.customerEmail,
          customerName: folio.customerName,
          orgName: org.name,
          folioId: folio.id,
          pendingBalance: folio.total - folio.amountPaid,
          releasesAt: new Date(graceInstant * 1000),
          lines: lineRows.map((l) => ({
            serviceName: l.serviceName,
            slotDate: l.slotDate,
            slotStartTime: l.slotStartTime,
            quantity: l.quantity,
          })),
        })
      } catch (err) {
        console.error('[sweep] reminder email failed', folio.id, err)
        // Recorded rather than only logged (US-A86): the row keeps the error and stays visible in
        // the admin's outbox, so a provider's bad afternoon is a fact somebody can see.
        await recordEmailOutcome(db, folio.organizationId, folio.id, 'booking_grace_entered', {
          ok: false,
          error: String(err),
        })
        continue
      }
      await recordEmailOutcome(db, folio.organizationId, folio.id, 'booking_grace_entered', {
        ok: true,
      })

      await db
        .update(folios)
        .set({ reminderStatus: 'sent', reminderSentBy: null, updatedAt: now })
        .where(
          and(eq(folios.id, folio.id), eq(folios.organizationId, folio.organizationId)),
        )
      result.notified++
    } catch (err) {
      result.failed++
      console.error('[sweep] folio failed', folio.id, err)
    }
  }

  return result
}
