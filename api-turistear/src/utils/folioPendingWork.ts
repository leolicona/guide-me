// US-A84 (docs/oversight/folio-lifecycle-unification.spec.md) — the five predicates that define
// "pending work" on a folio, in ONE place.
//
// Three consumers read them and must never disagree: the union half of the list read (rule 1), the
// counts endpoint (rule 5), and the facets the card renders. Each predicate is the SAME `WHERE` its
// former tab used — a tab becoming a facet must not quietly change what it matches, or the count
// and its destination stop agreeing, which is the one thing this feature promises (S-4).
//
// The window (rule 2) lives beside them because it is the other half of the same union.
//
// bug: folio-counts-full-scan — every predicate OPENS with its candidate set,
// `folios.id IN (<an org-scoped subquery one index serves>)`, and only then applies the checks that
// need the folio's other rows. Written as a correlated EXISTS, a predicate could only be tested folio
// by folio, so a count over it visited every folio the organization ever sold: /folios/counts read
// 10,346 rows per call on 1,011 folios (measured 2026-10-15) to find a handful. The candidate set is
// evaluated once (migration 0074 indexes each one). The org scope inside each subquery is
// constitution III — no read of another tenant's rows, not even their ids — and it is why every
// predicate now takes `org`. `IN` and `EXISTS` agree here: `folio_id` is NOT NULL, and an `IN` in a
// WHERE is only ever asked "is it there".

import { and, eq, gte, inArray, ne, or, sql, type SQL } from 'drizzle-orm'
import type { Db } from '../db/client'
import { folioRequests, folios } from '../db/schema'
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
export const verificationPendingFilter = (org: string): SQL =>
  and(
    // bug: folio-counts-full-scan — the candidates, through folios_org_verification_idx.
    sql`folios.id in (
      select f2.id from folios f2
      where f2.organization_id = ${org} and f2.payment_verification = 'pending'
    )`,
    // TECH_DEBT #25 — "not cancelled" reads the lines (any live line), the column is gone.
    sql`exists (select 1 from folio_lines fl where fl.folio_id = folios.id and fl.cancelled_at is null)`,
  )!

/**
 * devolada-transfer-verification D14 (data-model § Attention) — the sale has a Devolada payment
 * that needs the admin, unresolved. Derived, never stored (constitution II). A payment needs the
 * admin when it is:
 * - `partial` or `invalid` on a settlement link: the admin accepts or dismisses it (D15). On a sale
 *   or deposit link the sale stays pending, and today's Verificar or Rechazar decide it (FR-018);
 * - `unapplied`, or `confirmed` on a cancelled sale: money to return (D9), until marked returned;
 * - in flight and stalled — `validating` awaiting the payer's tracking key, `queued_for_credit` —
 *   or last seen in flight on a link no credential can read (`failed`, D21), while nobody decided
 *   it by hand: no resolution, the sale not cancelled, and a sale or deposit link's row still
 *   pending (once the admin's Verificar flips it, the payment is decided).
 *
 * It opens with its candidate set — the organization's payments in one of those statuses, through
 * devolada_payments (organization_id, status) — then each candidate's link by primary key (bug:
 * folio-counts-full-scan, BUG-042). Cancelled sales are included: unapplied money outlives its sale.
 */
export const devoladaAttentionFilter = (org: string): SQL =>
  sql`folios.id in (
    select dp.folio_id from devolada_payments dp
    join devolada_links l on l.id = dp.link_id and l.organization_id = dp.organization_id
    where dp.organization_id = ${org}
      and dp.status in ('partial', 'invalid', 'unapplied', 'confirmed', 'validating', 'queued_for_credit')
      and dp.resolution is null
      and (
        (dp.status in ('partial', 'invalid') and l.kind = 'settlement')
        or dp.status = 'unapplied'
        or (dp.status = 'confirmed' and exists (
          select 1 from folios fc where fc.id = dp.folio_id and fc.cancelled_at is not null
        ))
        or (
          ((dp.status = 'validating' and dp.awaiting is not null)
            or dp.status = 'queued_for_credit'
            or (dp.status = 'validating' and l.state = 'failed'))
          and not exists (select 1 from folios fc where fc.id = dp.folio_id and fc.cancelled_at is not null)
          and (l.kind = 'settlement' or exists (
            select 1 from folio_payments fp where fp.id = l.folio_payment_id and fp.verification = 'pending'
          ))
        )
      )
  )`

/**
 * devolada-transfer-verification D14 — a sale Devolada is resolving with nothing for the admin to
 * do, so it stays out of «Por verificar» and out of its count (spec clarification of 2026-10-15).
 * Pending verification with a live line, and EVERY pending payment row is collected by an `open`
 * link that either waits for its first payment before `expires_at`, or whose current payment is
 * `validating` without `awaiting` — even past `expires_at`: the customer paid in time and Banxico
 * has not answered yet. None of those links may use the current credential of a `broken`
 * connection: Devolada cannot be asked about it until the admin fixes the key, so the sale waits in
 * «Por verificar» meanwhile (spec clarification of 2026-10-16).
 *
 * The sale also has no attention item (`devoladaAttentionFilter`), on any of its links.
 *
 * One predicate for the row flag, the detail and the count, so they cannot disagree. It opens with
 * the candidate set of `verificationPendingFilter` (bug: folio-counts-full-scan), and every
 * correlation after it goes through an index led by the correlated key (BUG-042): folio_payments
 * (organization_id, folio_id), devolada_links (organization_id, folio_id), devolada_payments
 * (link_id) and devolada_connections (organization_id), one row per organization.
 */
export const verificationAutoFilter = (org: string, now: Date): SQL => {
  const nowSec = Math.floor(now.getTime() / 1000)
  return and(
    verificationPendingFilter(org),
    sql`exists (
      select 1 from folio_payments p
      where p.organization_id = folios.organization_id and p.folio_id = folios.id
        and p.verification = 'pending'
    )`,
    sql`not exists (
      select 1 from folio_payments p
      where p.organization_id = folios.organization_id and p.folio_id = folios.id
        and p.verification = 'pending'
        and not exists (
          select 1 from devolada_links l
          where l.organization_id = p.organization_id and l.folio_id = p.folio_id
            and l.folio_payment_id = p.id and l.state = 'open'
            and not exists (
              select 1 from devolada_connections dc
              where dc.organization_id = l.organization_id and dc.status = 'broken'
                and dc.current_credential_id = l.credential_id
            )
            and coalesce((
              select case
                when dp.status = 'validating' and dp.awaiting is null then 1
                else 0
              end
              from devolada_payments dp
              where dp.link_id = l.id and dp.status <> 'superseded'
              order by dp.devolada_created_at desc, dp.rowid desc limit 1
            ), case when l.expires_at > ${nowSec} then 1 else 0 end) = 1
        )
    )`,
    sql`not (${devoladaAttentionFilter(org)})`,
  )!
}

/** Cash the company owes back and nobody has confirmed handing over (US-A78). */
// TECH_DEBT #25 — the debt lives on the lines (D6); pending = any line still owed.
// bug: folio-counts-full-scan — the candidates, through folio_lines_org_refund_idx.
export const refundPendingFilter = (org: string): SQL =>
  sql`folios.id in (
    select fl.folio_id from folio_lines fl
    where fl.organization_id = ${org} and fl.refund_status = 'pending'
  )`

/** A hold past its settle deadline (US-A79). Derived from the clock at query time, NEVER stored —
 *  a stored stage needs a writer, and a cron that writes state drifts from the clock that defines
 *  it (`apartado-stages.spec.md` S7). */
export const overdueFilter = (org: string, now: Date): SQL =>
  // TECH_DEBT #25 — overdue = any LIVE line still owing whose OWN clock passed (D5).
  // bug: folio-counts-full-scan — the candidates, through folio_lines_org_live_clock_idx.
  sql`folios.id in (
    select fl.folio_id from folio_lines fl
    where fl.organization_id = ${org} and fl.cancelled_at is null
      and fl.booking_expires_at is not null and fl.booking_expires_at < ${Math.floor(now.getTime() / 1000)}
      and coalesce((select sum(a.amount) from folio_payment_allocations a where a.folio_line_id = fl.id), 0) < fl.line_total
  )`

/**
 * Tickets that never reached the customer (US-A80).
 *
 * This is `deliveryState() === 'pending'` expressed in SQL: on the delivery axis (paid AND the
 * money cleared, which is what `deliverable` means) with neither timestamp set. Both columns are
 * `NOT NULL` with defaults, so no null-safe comparison is needed.
 */
export const undeliveredFilter = (org: string): SQL =>
  and(
    // bug: folio-counts-full-scan — the candidates (neither stamp set), through
    // folios_org_undelivered_idx.
    sql`folios.id in (
      select f2.id from folios f2
      where f2.organization_id = ${org} and f2.tickets_sent_at is null and f2.tickets_viewed_at is null
    )`,
    // TECH_DEBT #25 — "paid" = the worst-case derivation: no live line under-allocated, some live line.
    sql`exists (select 1 from folio_lines fl where fl.folio_id = folios.id and fl.cancelled_at is null)`,
    sql`not exists (
      select 1 from folio_lines fl
      where fl.folio_id = folios.id and fl.cancelled_at is null
        and coalesce((select sum(a.amount) from folio_payment_allocations a where a.folio_line_id = fl.id), 0) < fl.line_total
    )`,
    ne(folios.paymentVerification, 'pending'),
  )!

/** A tourist is waiting on an answer (US-T04). A membership test rather than a join, so a folio
 *  with two requests cannot appear twice in the list it decorates. */
// bug: folio-counts-full-scan — the candidates, through folio_requests_org_status_idx.
export const requestPendingFilter = (db: Db, org: string): SQL =>
  inArray(
    folios.id,
    db
      .select({ folioId: folioRequests.folioId })
      .from(folioRequests)
      .where(and(eq(folioRequests.organizationId, org), eq(folioRequests.status, 'pending'))),
  )

/** The union's set (a): every folio someone still has to act on, at any age (rule 3). */
export const pendingWorkFilter = (db: Db, org: string, now: Date): SQL =>
  or(
    verificationPendingFilter(org),
    refundPendingFilter(org),
    overdueFilter(org, now),
    undeliveredFilter(org),
    requestPendingFilter(db, org),
    // devolada-transfer-verification D14 — a Devolada payment that needs the admin, cancelled
    // sales with money to return included.
    devoladaAttentionFilter(org),
  )!

/**
 * The five counts (US-A84 D7, rule 5) as the statements `GET /api/folios/counts` runs — built here
 * so test/folios/hoy-polled-reads.test.ts plans the very statements the handler executes.
 *
 * bug: folio-counts-full-scan — the tenant term carries SQLite's unary `+`, which takes it out of
 * index selection while it still filters. Production keeps no sqlite_stat1, and without statistics
 * the planner prefers entering an org-leading index and testing each folio against the candidate
 * list — every folio of the organization again. With the `+`, the only usable entry is the
 * candidate set itself, then each candidate's row by primary key. Isolation holds twice: here, and
 * in each predicate's org-scoped subquery.
 */
export const pendingWorkCountQueries = (db: Db, org: string, now: Date) => {
  const count = (predicate: SQL) =>
    db
      .select({ n: sql<number>`count(*)` })
      .from(folios)
      .where(and(sql`+${folios.organizationId} = ${org}`, predicate))
  return {
    verification: count(verificationPendingFilter(org)),
    refunds: count(refundPendingFilter(org)),
    overdue: count(overdueFilter(org, now)),
    undelivered: count(undeliveredFilter(org)),
    // Counted over FOLIOS, not over requests: two pending requests on one folio are one folio to
    // act on, and the pill reads "1 Solicitud" beside a list that shows one row.
    folio_requests: count(requestPendingFilter(db, org)),
    // devolada-transfer-verification D14 — «Por verificar» = verification − verification_auto +
    // devolada_attention, in the badge, the bar and Hoy, and each sale counts once:
    // `verification_auto`, the sales Devolada is resolving with nothing for the admin to do;
    // `devolada_attention`, the sales with a Devolada payment that needs the admin which
    // `verification` does not already count — cancelled, or not pending verification.
    verification_auto: count(verificationAutoFilter(org, now)),
    devolada_attention: count(and(devoladaAttentionFilter(org), sql`not (${verificationPendingFilter(org)})`)!),
  }
}

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
