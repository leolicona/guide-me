// US-A84 (docs/oversight/folio-lifecycle-unification.spec.md) — the five predicates that define
// "pending work" on a folio, in ONE place.
//
// Three consumers read them and must never disagree: the union half of the list read (rule 1), the
// counts endpoint (rule 5), and the facets the card renders. Each predicate is the SAME `WHERE` its
// former tab used — a tab becoming a facet must not quietly change what it matches, or the count
// and its destination stop agreeing, which is the one thing this feature promises (S-4).
//
// The window (rule 2) lives beside them because it is the other half of the same union.

import {
  and,
  eq,
  exists,
  gte,
  isNotNull,
  isNull,
  lt,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm'
import type { Db } from '../db/client'
import { cancellationRequests, folios } from '../db/schema'
import { naiveEpoch, orgToday } from './tz'

/** How many days of ordinary sales the list carries by default (D9). A parameter, not a law: the
 *  right value comes from measuring folios/day per org. Nothing breaks if it is wrong — the
 *  pending-work half of the union is complete regardless of it. */
export const DEFAULT_WINDOW_DAYS = 30

/**
 * An electronic payment awaiting an admin (US-A67).
 *
 * Cancelled folios are excluded because rejecting a payment cancels the folio and leaves its stale
 * `'pending'` flag behind — the same exclusion `?verification=pending` has always applied.
 */
export const verificationPendingFilter = (): SQL =>
  and(eq(folios.paymentVerification, 'pending'), ne(folios.status, 'cancelled'))!

/** Cash the company owes back and nobody has confirmed handing over (US-A78). */
export const refundPendingFilter = (): SQL => eq(folios.refundStatus, 'pending')

/** A hold past its settle deadline (US-A79). Derived from the clock at query time, NEVER stored —
 *  a stored stage needs a writer, and a cron that writes state drifts from the clock that defines
 *  it (`apartado-stages.spec.md` S7). */
export const overdueFilter = (now: Date): SQL =>
  and(
    eq(folios.status, 'booking'),
    isNotNull(folios.bookingExpiresAt),
    lt(folios.bookingExpiresAt, now),
  )!

/**
 * Tickets that never reached the customer (US-A80).
 *
 * This is `deliveryState() === 'pending'` expressed in SQL: on the delivery axis (paid AND the
 * money cleared, which is what `deliverable` means) with neither timestamp set. Both columns are
 * `NOT NULL` with defaults, so no null-safe comparison is needed.
 */
export const undeliveredFilter = (): SQL =>
  and(
    eq(folios.status, 'paid'),
    ne(folios.paymentVerification, 'pending'),
    isNull(folios.ticketsSentAt),
    isNull(folios.ticketsViewedAt),
  )!

/** A tourist is waiting on an answer (US-T04). `EXISTS` rather than a join, so a folio with two
 *  requests cannot appear twice in the list it decorates. */
export const requestPendingFilter = (db: Db, org: string): SQL =>
  exists(
    db
      .select({ one: sql`1` })
      .from(cancellationRequests)
      .where(
        and(
          eq(cancellationRequests.folioId, folios.id),
          eq(cancellationRequests.organizationId, org),
          eq(cancellationRequests.status, 'pending'),
        ),
      ),
  )

/** The union's set (a): every folio someone still has to act on, at any age (rule 3). */
export const pendingWorkFilter = (db: Db, org: string, now: Date): SQL =>
  or(
    verificationPendingFilter(),
    refundPendingFilter(),
    overdueFilter(now),
    undeliveredFilter(),
    requestPendingFilter(db, org),
  )!

/**
 * The union's set (b): folios created within the last `days` **org-local** calendar days (rule 2).
 *
 * The day arithmetic runs on the `YYYY-MM-DD` string and only then resolves to an instant, so a DST
 * transition inside the window cannot shift the boundary by an hour — the same reason the card's
 * "ayer" is computed from calendar days rather than `now − 86400`.
 */
export const windowStart = (tz: string, days: number, now = Date.now()): Date => {
  const today = orgToday(tz, now)
  const d = new Date(`${today}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - (days - 1))
  return new Date(naiveEpoch(d.toISOString().slice(0, 10), '00:00', tz) * 1000)
}

/**
 * The whole union (rule 1): pending work at any age, OR anything recent enough.
 *
 * Written as ONE `OR` rather than two queries because the caller's other filters must apply to both
 * halves — `?status=booking` inside the union is still only bookings, whichever half matched.
 */
export const listWindowFilter = (
  db: Db,
  org: string,
  tz: string,
  days: number,
  now: Date,
): SQL =>
  or(pendingWorkFilter(db, org, now), gte(folios.createdAt, windowStart(tz, days, now.getTime())))!
