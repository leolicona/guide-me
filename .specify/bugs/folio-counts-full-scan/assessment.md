# Bug Assessment: Hoy's polled reads visit the organization's whole history every minute

- **Slug**: folio-counts-full-scan
- **Created**: 2026-10-16
- **Source**: pasted text — the slug `folio-counts-full-scan` alone. The report behind it is the debt
  entry of the same slug (`.specify/debt/folio-counts-full-scan/debt.md`, PR #167, not yet on `main`)
  and the production measurements of 2026-10-15 and 2026-10-16. No URL was given, so the URL trust
  policy did not apply.
- **Verdict**: valid
- **Severity**: medium

## Report (verbatim or summarized)

The debt entry records that `GET /api/folios/counts` runs five `count(*)` statements that visit every
folio the organization has ever sold, and that Hoy polls it every 60 s. `GET /api/dashboard/day`,
polled by the same screen, reads every slot and every ledger row of the organization to show one day.
On Workers Free, where Cloudflare has enforced the D1 limit of 5,000,000 rows read per account per day
since 2026-09-01, that cost is enough on its own to exhaust the account's daily budget. The developer
chose to fix it on the lite path. The debt stays the record of the cost, and this bug is the fix: per
`speckit-debt-log`, "debt that causes a bug is still debt; the bug gets its own record".

There is precedent for treating a read cost as a bug. BUG-042 (`migrations/0067_folio_correlation_indexes.sql`)
fixed a folio list that "read ~930,000 rows per request … and exhausted the D1 rows-read quota". It
indexed the child keys of the correlated subqueries. This bug is the next layer out: the outer loop
those subqueries run inside.

## Symptom

While Hoy is visible, the admin app calls `/api/folios/counts` and `/api/dashboard/day` every 60 s.
In production (1,011 folios), one poll reads about **15,200 rows** to return five small counts and
the day's 12 departures. Expected: each read grows with the pending work, or with the day, not with
the organization's history.

The consequence is account-wide:

- One screen visible for about 8 h reads about 7.3M rows a day, over the free limit of 5M.
- Over the limit, every D1 query on the account fails until 00:00 UTC, including other projects' queries.
- The account hit the limit on 2026-09-01, 09-02, 09-04 and 09-05, and moved to Workers Paid on
  2026-09-05. Which reads exhausted it on those days was not established.

On Paid nothing fails today, but the account cannot return to the free plan, and the cost per poll
keeps rising with every sale.

## Reproduction

1. **Data.** Production organization `8c8653d8…`, on 2026-10-16: 1,011 folios, 1,046 lines, 1,980
   slots and 1,424 ledger rows.
2. **Counts.** Run the five predicates as `listFolioCounts` composes them, in one statement.
   `meta.rows_read = 10,346`, measured 2026-10-15; about 1k of that is a helper CTE that picked the
   organization.
3. **Dashboard.** Run `getDashboardDay`'s reads for 2026-10-16, measured that day:
   - the slots read returned 12 rows and read **2,004**;
   - each of the two `folio_payments` reads returned 0 rows and read **1,424**.
4. **Plans.** On a local SQLite 3.45.1 with every migration through `0071` applied, and no
   `sqlite_stat1`: production has no `sqlite_stat*` tables either (checked 2026-10-16).
   - Every counts statement opens with `SEARCH folios USING INDEX folios_org_created_idx (organization_id=?)`.
   - The slots read opens with `SEARCH s USING INDEX slots_org_service_date_idx (organization_id=?)`.
   - Both ledger reads open with `SEARCH folio_payments USING INDEX folio_payments_shift_idx (organization_id=?)`.
5. **Polling.** Open Hoy in a visible tab. `DashboardPage` polls both endpoints every
   `DASHBOARD_POLL_MS = 60_000`. A second `/dashboard/day` poll runs while another day is peeked.
   TanStack Query pauses the interval only when `document.visibilityState === 'hidden'`.

The 2026-10-16 candidate sets show what the reads should be proportional to:

- 1 folio pending verification;
- 0 lines with a pending refund;
- 0 live lines with a hold clock;
- 34 folios never delivered (33 of them not pending verification);
- 1 pending request;
- 12 departures today.

## Suspected Code Paths

- `api-turistear/src/routes/folios/handler.ts::listFolioCounts` (`:286`): `countWhere` (`:292`)
  composes `eq(folios.organizationId, org)` with each predicate. That org term is the only one an
  index can serve.
- `api-turistear/src/utils/folioPendingWork.ts`:
  - `::verificationPendingFilter` (`:39`): `payment_verification = 'pending'`, but no index on
    `folios` covers that column.
  - `::refundPendingFilter` (`:48`), `::overdueFilter` (`:54`) and `::requestPendingFilter` (`:88`):
    correlated `EXISTS` on a child table, evaluated once per visited folio.
  - `::undeliveredFilter` (`:72`): `tickets_sent_at IS NULL AND tickets_viewed_at IS NULL`, with no
    index covering those columns.
- `api-turistear/src/routes/dashboard/handler.ts::getDashboardDay`:
  - `slotRows` (`:49`) filters `organization_id, date, status`. The only usable index is
    `slots_org_service_date_idx (organization_id, service_id, date)`, where `service_id` sits between
    the organization and the date.
  - `moneyWhere` (`:122`) filters `organization_id, entry_type, created_at`. The only usable index is
    `folio_payments_shift_idx (organization_id, collected_by, created_at)`, where `collected_by` sits
    between them.
- `app-turistear/src/pages/DashboardPage.tsx::DashboardPage` (`:34`–`:37`) and
  `app-turistear/src/features/dashboard/hooks/useDashboard.ts::DASHBOARD_POLL_MS` (`:9`): the
  60-second poll. It is the multiplier, not the defect.

## Root Cause Hypothesis

Confidence: **high**. Both measured and planned.

**The counts.** Each predicate is evaluated per outer folio, and every index on `folios` leads with
`organization_id` with no predicate column behind it. So the outer loop can narrow by the
organization only, and visits every folio it has ever sold.

Rewriting the `EXISTS` as `folios.id IN (…)` is **not enough** on its own. Without statistics, the
planner still drives from `folios_org_*` and uses the `IN` list only as a membership check. This was
verified locally, and production has no statistics. It drives from the candidate set only when the
outer org term is taken out of index selection.

**The dashboard.** The day filters, `slots.date` and `folio_payments.created_at`, cannot be reached
through any index prefix, because another column sits between them and `organization_id`.

## Proposed Remediation

**Preferred**: keep every recorded decision — the whole-organization scope (US-A84 D7, rule 4), one
definition per predicate shared by the list, the facets and the counts, a clock read at query time,
and the 60 s poll (`occupancy-dashboard.spec.md` D3) — and change only how the reads reach their rows.

1. **One additive migration.** It takes the next free number at PR time. Today that is `0074`:
   `0072` is reserved for the drop of the password columns (`.specify/debt/password-material`), and
   `0073` is claimed by `specs/006-devolada-transfer-verification`. It creates:
   - `folios (organization_id, payment_verification)`
   - `folios (organization_id, tickets_sent_at, tickets_viewed_at)`
   - `folio_lines (organization_id, folio_id) WHERE refund_status = 'pending'`
   - `folio_lines (organization_id, booking_expires_at) WHERE cancelled_at IS NULL AND booking_expires_at IS NOT NULL`
   - `slots (organization_id, date)`
   - `folio_payments (organization_id, created_at)`

   `folio_requests` needs nothing: `uq_folio_requests_open (folio_id) WHERE status = 'pending'`
   already holds only pending rows. As with BUG-042 (`0067`, `0068`), the migration is hand-written
   SQL: `CREATE INDEX IF NOT EXISTS` under a header that says why. Those indexes are not declared in
   `api-turistear/src/db/schema.ts`, so these follow suit unless the fix finds a reason not to.
2. **`folioPendingWork.ts`.** Each predicate states its candidate set as
   `folios.id IN (<an org-scoped subquery that one of those indexes serves>)` and keeps its residual
   checks unchanged: a live line, the owing sum, and `payment_verification <> 'pending'` for
   undelivered. `IN` and `EXISTS` agree here because `folio_id` is never null in these subqueries.
   The list and the facets get the same definitions, so the three cannot disagree.
3. **`listFolioCounts`.** The outer tenant term becomes `+folios.organization_id = ?`. The unary
   plus is SQLite's documented way to disqualify a WHERE term from index selection. The term still
   filters, so tenant isolation is unchanged; it just stops being the index the planner picks. A
   `bug: folio-counts-full-scan` comment says why (constitution I).
4. **`getDashboardDay`.** No query change; the two indexes are enough.

Plans after the change, on the same local SQLite:

- **Counts.** Every statement opens with `SEARCH folios USING INDEX sqlite_autoindex_folios_1 (id=?)`
  over a `LIST SUBQUERY`, which reads only the candidate set:
  - `SEARCH f2 USING INDEX … (organization_id=? AND payment_verification=?)`
  - `SEARCH fl USING COVERING INDEX … refund_pending … (organization_id=?)`
  - `SEARCH fl USING INDEX … live_clock … (organization_id=? AND booking_expires_at>? AND booking_expires_at<?)`
  - `SEARCH f2 USING INDEX … (organization_id=? AND tickets_sent_at=? AND tickets_viewed_at=?)`
  - `SCAN r USING INDEX uq_folio_requests_open`
- **Dashboard.**
  - `SEARCH s USING INDEX … (organization_id=? AND date=?)`
  - `SEARCH folio_payments USING INDEX … (organization_id=? AND created_at>? AND created_at<?)`, for both ledger reads.

Expected cost, estimated from the 2026-10-16 candidate sets: counts in the low hundreds of rows per
call, and the dashboard about two dozen rows plus the day's ledger rows. Today one poll reads about
15,200. Re-measuring confirms it (below).

**Alternatives**:

- **`PRAGMA optimize` (ANALYZE) on production.** With statistics, the planner might pick the
  candidate sets on its own, with no code change. Rejected as the fix, because nothing pins the
  plan: statistics drift, the tests run without them, and the next schema change can flip it. It
  could complement the fix (see Open Questions).
- **Poll less, or stop polling the counts.** This changes D3, so it needs a spec. Every call would
  still read the whole history, which the debt entry classifies as `partial`.
- **Drive each count from its child table with a `CROSS JOIN`.** The plan is deterministic, but each
  count would stop sharing the list's predicate definition, which breaks "must never disagree"
  (`folioPendingWork.ts` header).
- **Clear `booking_expires_at` when a line settles, to bound `overdue` further.** This changes the
  settle write path. It overlaps both `cron-sweeps-full-scan` and the possible bug in
  `deriveBookingExpiresAtSql` recorded in that entry's notes. Out of scope here.

**Files likely to change**:

- `api-turistear/migrations/00NN_hoy_polled_read_indexes.sql` (new; the next free number at PR time)
- `api-turistear/src/utils/folioPendingWork.ts`
- `api-turistear/src/routes/folios/handler.ts`
- `api-turistear/test/folios/hoy-polled-reads.test.ts` (new)

**Tests to add or update**:

- **New plan test.** It takes the shape of `api-turistear/test/folios/correlation-indexes.test.ts`,
  whose `planOf` renders the handlers' own drizzle fragments on the local D1. It covers each
  statement `listFolioCounts` issues, plus `getDashboardDay`'s slots read and both ledger reads.
  - No plan line may `SCAN` `folios`, `slots` or `folio_payments`.
  - No plan line may `SEARCH … (organization_id=?)` through an index other than a partial index that
    holds only candidate rows. The test keeps those partial indexes as an explicit allowlist (the
    refund-pending index, `uq_folio_requests_open`).
  - Match lines by index name, not only by table name. Plan lines name the table's alias, and the raw
    fragments alias their tables (`fl`, `f2`, `r`). The regexes the debt entry proposes,
    `/^SCAN (folios|slots|folio_payments)\b/` and
    `/^SEARCH (folios|slots|folio_payments) USING … \(organization_id=\?\)$/`, would miss an aliased
    full read and would reject the allowed partial-index searches.
  - To render the counts the way they run, `countWhere`'s query builder is factored out, so the test
    and the handler build the same statement.
- **Cross-org isolation.** A `seedTwoOrgs` case where both organizations have pending work of every
  kind: org A's counts never include org B's folios. This proves the `+` term still filters
  (CLAUDE.md § Multitenancy).
- **Unedited suites that must pass.** These pin that the counts and the day are unchanged:
  - `test/folios/folio-lifecycle-unification.test.ts`, including "US-A84 — the counts are counts"
  - `test/folios/correlation-indexes.test.ts`
  - `test/folios/cancel-unverified-guard.test.ts`
  - `test/folios/folio-fulfillment.test.ts`
  - `test/dashboard/dashboard-day.test.ts`
  - the list and facet suites
- **Evidence, not a test.** Re-run the 2026-10-15/16 measurements with `meta.rows_read`, on dev
  after the preview and on prod after release, beside the 10,346 / 2,004 / 1,424 baselines. The
  debt's `/speckit-debt-pay` uses these figures.

## Risks & Considerations

- **The plan depends on the planner.** The plan test pins it on the local D1 (workerd's SQLite)
  without statistics, which is production's state today. If someone later runs `PRAGMA optimize` on
  production, its plans could diverge from the test's. Re-measuring after release is the guard.
- **The unary plus is non-obvious.** Without its comment, the next refactor that "cleans it up"
  silently brings the full read back. The plan test catches that.
- **Migrations and D19.**
  - The preview applies a pull request's pending migrations to dev's D1 when the PR opens, and D19
    forbids renaming a migration once it reaches dev.
  - So the number must be checked against `main`, `0072` and `0073` right before the PR opens.
  - The migration is additive: it creates indexes and drops nothing, so it is safe under the code
    already deployed.
- **Write cost.** Each new index adds one written row per write that touches its columns; the
  partial ones only when the row qualifies. Slot generation writes one extra row per slot. Building
  the indexes reads and writes each table once (about 1–2k rows each). This is small against both
  the Paid quota and the free limit of 100k writes a day.
- **The list changes plan too.** The list and the facets share the fragments, so they move from
  per-row correlated `EXISTS` to an `IN` list evaluated once. The results are the same. The list's
  default window (`listWindowFilter` → `pendingWorkFilter`) keeps its org-driven outer loop. That
  read is not polled and is not part of this symptom.
- **Residual growth.**
  - `overdue` candidates include settled apartados, because a line's clock is never cleared
    (`cron-sweeps-full-scan`, Notes).
  - `undelivered` candidates include cancelled or never-sent folios: 34 of 1,011 today.
  - Both grow far more slowly than the history does, but they still grow.
- **Measuring rows locally.** Local D1 under `@cloudflare/vitest-pool-workers` may not report
  `meta.rows_read`. The pass/fail is the plan test; the row counts come from dev and prod.
- **A related trigger is about to fire.** `specs/006-devolada-transfer-verification` adds "a third
  sweep on the existing trigger" (plan.md). That is the `cron-sweeps-full-scan` trigger "another
  candidate query is added to this cron". It is not this bug, but it shares the account's budget.

## Open Questions

- [NEEDS CLARIFICATION: run `PRAGMA optimize` once on dev and prod after the migration, as the D1
  docs recommend after creating an index? It would add statistics that the plan test does not
  model.]
- [NEEDS CLARIFICATION: should the list endpoint's default window (`pendingWorkFilter` union) be
  bounded in this fix too? It reads the same history, but it is not polled.]
- [NEEDS CLARIFICATION: merge order with PR #167. The debt entry this bug pays should be on `main`
  before `/speckit-debt-pay` runs.]
