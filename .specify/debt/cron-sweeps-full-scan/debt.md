---
slug: cron-sweeps-full-scan
status: open
kind: inadvertent
severity: low
effort: days
opened: 2026-10-15
---

# Technical Debt: the cron sweeps read every folio to find what is due

## What was traded

The API's 15-minute cron runs two sweeps. Each one writes its candidate query as a direct statement
of the rule. For the apartado sweep, the rule is a live line whose own clock passed and that still
owes, reached through `folios`. For the reminders, it is a departure, written as
`COALESCE(slot_date, check_in)`. No existing index serves either condition, so every run reads the
history to find the few rows that are due. Nothing in the code or its history records this cost
being accepted, so the kind is `inadvertent`. The reminders' comment does record a knowing trade
about the width of the date window ("the widest thing the query can honestly do"), but that trade
is about precision, not about an index.

## Where it lives

- `api-turistear/src/routes/pos/sweep.ts::sweepExpiredBookings` holds the `due` query:
  `.from(folios)` filtered by `exists (select 1 from folio_lines fl where fl.folio_id = folios.id
  and fl.cancelled_at is null … fl.booking_expires_at <= now … allocations < fl.line_total)`. Its
  plan is `SCAN folios`, then, for each folio, `SEARCH fl USING INDEX folio_lines_folio_idx
  (folio_id=?)` and the allocations subquery `SEARCH a USING INDEX
  folio_payment_allocations_line_only_idx (folio_line_id=?)`. Every run reads every folio ever sold.
- `api-turistear/src/routes/pos/reminders.ts::sweepDepartureReminders` holds the per-org `rows`
  query. It filters with `gte`/`lte` on `COALESCE(${folioLines.slotDate}, ${folioLines.checkIn})`
  between `from` and `to`. No index covers that expression, so the plan is `SEARCH folio_lines USING
  INDEX folio_lines_org_slot_idx (organization_id=?)`, which reads every line of the org.
- `api-turistear/src/utils/folioStatus.ts::deriveStatusSql` is the correlated status subquery that
  the reminders query evaluates on each of those rows: `SEARCH fl … folio_lines_folio_idx`, then the
  allocations of each line.
- `api-turistear/src/index.tsx`: the default export's `scheduled` handler runs both sweeps on every
  tick, each under its own `ctx.waitUntil`.
- `api-turistear/wrangler.jsonc:64` and `:107` hold `"crons": ["*/15 * * * *"]`, restated in both
  `env.dev.triggers` and `env.production.triggers`. Named envs do not inherit `triggers`, and the
  top-level local profile declares none.

## Interest

- **Reads grow with history, not with work.** The developer measured these figures on 2026-10-15
  (`meta.rows_read` of the raw SQL) on `guideme-db-prod`, which then held 1,011 folios, 1,046 lines,
  1,050 allocations and 2 orgs, with 0 live lines carrying a non-null `booking_expires_at`.
  - The `due` query read 3,066 rows and returned 0.
  - The reminders query for the larger org read 2,058 rows and returned 0.

  That is about 5.1k rows per run. At 96 runs a day, prod reads about 490k rows a day and finds
  nothing. The second org's reminders query adds to that.
- **It grows on its own.** The sweep grows linearly with folio count and the reminders query with
  each org's line count. Both grow whether or not anybody sells that day, because the cron runs
  regardless of traffic.
- **Dev pays it too.** `env.dev` runs the same cron against `guideme-db`, which holds test data:
  703 folios, 714 lines, 888 allocations and 3 orgs, also with 0 live clocked lines. Its reads were
  not measured; the query shape is the same.
- **What that costs.** This app's Cloudflare account is shared with other projects. Since
  2026-09-01 the account has had the D1 free tier's daily limit of 5,000,000 rows read enforced:
  over the limit, queries fail until 00:00 UTC. The account hit the limit on 2026-09-01, 09-02,
  09-04 and 09-05, and moved to Workers Paid ($5/month, 25B rows read/month included) on 2026-09-05.
  On Paid these reads are well within quota and produce no overage bill. The cost is a fixed floor
  of about 10% of the free daily budget, spent on finding nothing, and the floor rises with sales.
- **Writes are already confined to candidates** (observed). Every write in both sweeps happens
  inside the loop over the rows the candidate query returned, filtered by that row's own
  `organization_id`. The cost is in finding the work, not in doing it.

The severity is `low`. On Paid it costs no money and causes no failure today. It starts to matter
when one of the conditions under **Trigger** is met.

## Paying it

The debt is paid when both candidate queries read rows bounded by what can actually be due: lines
still owing near their clock, and lines departing inside the reminder window. They must no longer
read every folio, or every line of an org.

A local check on 2026-10-15 (in-memory SQLite with all 72 migrations applied) shows what paying
could look like. This is not a plan:

- A partial index `folio_lines (booking_expires_at) WHERE cancelled_at IS NULL AND
  booking_expires_at IS NOT NULL` does not change the current sweep plan on its own: it stays
  `SCAN folios`. The index is used only by a `due` query driven from `folio_lines`, which gives
  `SEARCH fl USING INDEX … (booking_expires_at>? AND booking_expires_at<?)`.
- An expression index `folio_lines (organization_id, COALESCE(slot_date, check_in))` turns the
  reminders step into `SEARCH folio_lines USING INDEX … (organization_id=? AND <expr>>? AND
  <expr><?)`, with the query unchanged and `deriveStatusSql` included.
- A clock index alone is still not enough. No code clears a line's clock when the line is paid in
  full (see Notes), so the index would still range over every apartado ever settled. Bounding the
  sweep needs settled lines out of that range. How to do that is a design decision, and it is what
  makes the effort `days` rather than `hours`.

The change would touch a new migration in `api-turistear/migrations/`, the `due` query in
`sweep.ts`, whatever the settled-clock decision reaches, and a plan test in `api-turistear/test/`.
If it needs more than that, it is a spec, and it starts at `/speckit-specify`.

To confirm the debt is gone:

- **A plan-pin test exists** beside `api-turistear/test/folios/correlation-indexes.test.ts`, the
  BUG-042 precedent. Today, `grep -rln 'EXPLAIN QUERY PLAN' api-turistear/test` finds only that
  file.
  - The new test takes `EXPLAIN QUERY PLAN` of both candidate queries as the sweeps build them. It
    renders them from the same code, not from a copy of their SQL; today both queries are inline in
    the sweep functions.
  - It asserts that no line of either plan matches `^SCAN folios\b`, `^SCAN (fl|folio_lines)\b`, or
    `^SEARCH folio_lines USING (COVERING )?INDEX \S+ \(organization_id=\?\)$`.
- **Settled apartados do not grow the `due` query's reads.** The check seeds N settled apartados
  (live lines, allocations equal to `line_total`, clocks in the past) and shows that the rows the
  `due` query reads do not grow with N. [NEEDS CLARIFICATION: whether local D1 under
  `@cloudflare/vitest-pool-workers` reports `meta.rows_read`. No test in the tree reads it, and the
  repo had no `node_modules` to check against. If it does not, run this check against `guideme-db`
  (dev) using `meta.rows_read`, the way the 2026-10-15 figures were taken.]
- **The existing suites pass unedited.** These suites must pass, and `git diff <base> -- <these
  files>` must be empty:
  - `api-turistear/test/pos/pos-bookings-sweep.test.ts`
  - `api-turistear/test/folios/departure-reminders.test.ts`
  - the other suites that drive the sweep: `test/pos/pos-zoned-release.test.ts`,
    `test/folios/line-settle.test.ts`, `test/folios/folio-cancellation.test.ts`,
    `test/folios/cancel-unverified-guard.test.ts` and `test/folios/folio-timeline.test.ts`
  - `test/folios/correlation-indexes.test.ts`

  `pnpm test:api` must pass as a whole.

Running the cron less often does **not** pay this debt. The developer notes that the 15-minute
cadence is tied to the default 15-minute grace offset (`organizations.booking_grace_offset_minutes`,
default 15 in `api-turistear/src/db/schema.ts`). A slower cron would release an unpaid apartado's
seats after its departure instead of before it.

**Trigger**: whichever of these comes first:

- The account is back on the D1 free tier. The cron alone takes about 10% of the enforced 5M daily
  rows today, with dev on top.
- Prod passes about 10,000 folios, roughly 10× the 2026-10-15 count. Extrapolating linearly, the
  prod cron alone would then read about 4.9M rows a day, the whole free daily budget.
- Another candidate query is added to this cron.

## Notes

- **Related.** `folio-counts-full-scan` is logged in parallel on 2026-10-15. It records the larger
  polled cost: `GET /api/folios/counts`, about 10k rows per call, every 60 s. It is a separate entry
  and not recorded here.
- **BUG-042 did not reach this.** BUG-042 (`api-turistear/migrations/0067_folio_correlation_indexes.sql`,
  pinned by `test/folios/correlation-indexes.test.ts`) made the correlated subqueries SEARCH. It
  did not touch the tables those queries are driven from, and those tables are this debt.
  - This does not conflict with the constitution's D1-reads constraint ("a correlated subquery keyed
    by a child column has an index led by that key: `EXPLAIN QUERY PLAN` shows no `SCAN` inside a
    correlated subquery").
  - The sweeps' correlated subqueries already SEARCH. The scan is on the outer table, and neither
    sweep is a list endpoint.
- **A line's clock is never cleared** (verified 2026-10-15). Only two places in `api-turistear/src`
  write `folio_lines.booking_expires_at`:
  - `routes/pos/handler.ts::confirmSale` sets it when the line is born, and only for an apartado
    (`bookingExpiresAt: line.bookingExpiresAt ?? null`).
  - `routes/pos/reschedule.ts::rescheduleFolio` stamps it again
    (`.set({ bookingExpiresAt: new Date(expiresAt * 1000) })`).

  No settle path (`settleBooking`, `settleFolioLine`, `verifyPayment`) sets it to null, and neither
  does any migration after `0064_line_booking_clock.sql`. As a result:
  - The `schema.ts` comment "Null for a paid line" holds for a line sold paid in full. It does not
    hold for an apartado line settled later.
  - `rescheduleFolio`'s comment says "each LIVE, still-owing line's clock recomputes", but its loop
    skips only cancelled or slot-less lines. A settled sibling in a folio still in `booking`
    therefore gets a fresh clock too.
  - Prod had no settled lines still carrying a clock on 2026-10-15 (0 live lines with a clock).
    They accumulate as apartados settle.
- **Not assessed here.** `deriveBookingExpiresAtSql` (`api-turistear/src/utils/folioStatus.ts`)
  takes the MIN over live lines' clocks with no still-owing filter, so a settled line's past clock
  counts too. Whether that misreads a mixed apartado, for example in `settleBooking`'s
  `BOOKING_EXPIRED` guard, is a question for `/speckit-bug-assess`, not for this entry.
- **Repeated outbox writes** (negligible, noted only). Every repeat below is discarded by the
  unique index.
  - `sweepDepartureReminders` calls `emitNotification` again on every run inside its window
    (`CATCH_UP_HOURS = 6`, so up to about 24 runs per folio), for both `departure_reminder` and
    `review_requested`. Its `reminded=` and `reviews=` log figures count these attempts, not new
    rows.
  - `sweepExpiredBookings` re-emits `booking_grace_entered` on every run for a folio in grace
    whose `reminder_status` never becomes `'sent'`. That happens when there is no email on file, no
    `RESEND_API_KEY`, or a failed send, because the flag is set only after a successful send. It
    continues until the folio is cancelled or an agent claims the reminder (`claimReminder`).
- **Stale index name in comments** (the code wins). The comments in `reminders.ts` and
  `notifications.ts` name `uq_notifications_folio_event_channel`, which
  `0063_line_cancellation.sql` dropped. The guard now is `uq_notifications_folio_line_event_channel`
  on `(folio_id, COALESCE(folio_line_id, ''), event, channel)`, which still removes duplicate
  folio-scoped events through the `COALESCE`. `emitNotification` uses Drizzle's
  `.onConflictDoNothing()` (`ON CONFLICT DO NOTHING`), which its doc comment calls INSERT OR
  IGNORE. The effect here is the same.
- **Stale dev database name** (the code wins). The header of the dev section in `wrangler.jsonc`
  reads `guideme-db-dev`. The dev binding, and the file's top comment, name `guideme-db`, which is
  the database the dev cron actually reads.
- **Provenance.** The developer measured the 2026-10-15 figures and stated the cadence-grace link
  and the billing context. The local query plans were reproduced for this entry with a throwaway
  script kept outside the repo.
- **Archived citations.** The anchored code cites `US-AG07`, `US-A77`, `US-T08`, `TECH_DEBT #25`,
  `docs/folios/folio-state-machine.spec.md` and `apartado-stages.spec.md`. These resolve in
  `leolicona/guide-me-docs` and were not read for this entry.
