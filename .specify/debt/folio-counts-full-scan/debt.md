---
slug: folio-counts-full-scan
status: open
kind: inadvertent
severity: medium
effort: days
opened: 2026-10-15
---

# Technical Debt: Hoy polls a count that reads the organization's whole folio history

## What was traded

US-A84 (D7) made the pending-work counts one aggregate over the **whole organization**, never the
loaded window (rule 4, S-3/S-4), so a pill's number is the number its list delivers.
`occupancy-dashboard.spec.md` D3 then made Hoy poll its reads every 60 s. Both are recorded
decisions. What the tree does not record is what they cost together. `GET /api/folios/counts` finds
the few folios that still need someone by visiting every folio the organization has ever sold, five
times per call, and Hoy pays that once a minute. The scope was chosen on purpose. The cost of
evaluating it this way is priced nowhere: not in the handler, the hook, or the commit that started
the polling (`e3fd3c6`, #103). Hence `inadvertent`.

## Where it lives

- `api-turistear/src/routes/folios/handler.ts::listFolioCounts`: five `count(*)` statements over
  `folios`, each `organization_id = ? AND <predicate>`, run together on every call. The organization
  is the only thing that narrows which folios are visited.
- `api-turistear/src/utils/folioPendingWork.ts::verificationPendingFilter`, `::refundPendingFilter`,
  `::overdueFilter`, `::undeliveredFilter`, `::requestPendingFilter`: the five predicates. Each is a
  correlated `EXISTS` evaluated once per visited folio. Verification and refunds correlate on
  `folio_lines`. Overdue and undelivered correlate on `folio_lines` with a nested sum over
  `folio_payment_allocations`. Requests correlates on `folio_requests`.
- `app-turistear/src/pages/DashboardPage.tsx::DashboardPage`: the poller,
  `const { data: counts } = useFolioCounts(true, DASHBOARD_POLL_MS)`. It sits beside
  `useDashboardDay(undefined)` and, while the strip peeks another day, a second polled
  `useDashboardDay(peekDay ?? undefined, peekDay !== null)`.
- `app-turistear/src/features/dashboard/hooks/useDashboard.ts::DASHBOARD_POLL_MS`
  (`export const DASHBOARD_POLL_MS = 60_000`) and `::useDashboardDay`
  (`refetchInterval: DASHBOARD_POLL_MS`, `refetchOnWindowFocus: true`): the D3 convention.
- `app-turistear/src/features/folios/hooks/useFolios.ts::useFolioCounts`: the shared query
  (`['folios', 'counts']`) that carries the interval.
- `app-turistear/src/layout/AppLayout.tsx::AppLayout` (`useFolioCounts(user.role === 'admin')`) and
  `app-turistear/src/features/folios/components/FolioListScreen.tsx::FolioListScreen`
  (`useFolioCounts(isAdmin)`): consumers with no interval. The client is created with no defaults
  (`app-turistear/src/config/queryClient.ts`: `export const queryClient = new QueryClient()`), so
  `staleTime` is 0 and `refetchOnWindowFocus` is true. These consumers therefore refetch the same
  query on mount, on window refocus, and after every `invalidateQueries({ queryKey: ['folios'] })`
  that a folio mutation fires.
- `api-turistear/src/routes/dashboard/handler.ts::getDashboardDay`: the other read Hoy polls. The
  day's `slots` read and the two `folio_payments` reads (`collectedRows`, `sellerRows`) are bounded
  only by the organization (see *Interest*). The `foliosRows` count and the per-slot `lineAgg` are
  bounded.

## Interest

`/counts`, measured on 2026-10-15:

- Data: prod `guideme-db-prod` had 1,011 folios, 1,046 folio_lines, 1,050 allocations and 2 orgs.
  Dev `guideme-db` had 703 / 714 / 888 and 3 orgs.
- The five filters, run as raw SQL in one statement for the largest prod organization, returned
  `meta.rows_read = 10,346`. Roughly 1k of that was a helper CTE that picked the organization, so a
  `/counts` call reads **~9–10k rows**. The cost grows linearly with the organization's folio count.
  A resolved folio costs the same to read as a pending one, so the count never stops paying for a
  sale.
- Why: the query plans were taken on an in-memory SQLite 3.45.1 with all 72 migrations applied and
  no statistics. Every one of the five statements opens with
  `SEARCH folios USING INDEX folios_org_created_idx (organization_id=?)`, which visits every folio of
  the organization, then runs its correlated subqueries once per folio. The correlations themselves
  use indexes (BUG-042's `folio_lines_folio_idx`, `folio_payment_allocations_line_only_idx`;
  `uq_folio_requests_open`). Every index on `folios` leads with `organization_id` and none covers a
  predicate column, so there is no narrower index for the query to use.

Estimated from those figures:

- Polling every 60 s while Hoy is visible makes ~60 calls/h × ~10k ≈ 600k rows/h per open screen.
  One screen open ~8 h is ≈ 4.8M rows/day. That is 96% of the D1 Workers Free daily limit of
  5,000,000 rows read per account, which Cloudflare enforces since 2026-09-01 (queries fail until
  00:00 UTC). The account, which other projects share, hit that limit on 2026-09-01, 09-02, 09-04
  and 09-05, and moved to Workers Paid ($5/month, 25B rows read/month included) on 2026-09-05. This
  entry does not attribute those days to this endpoint.
- On Paid, one such screen is ≈ 144M rows/month, about 0.6% of the included quota, so there is no
  overage today. The interest is that **the account cannot go back to the free plan**, and the
  headroom shrinks as folios accumulate.
- More admin screens multiply the cost, since both endpoints are admin-only. So do the unpolled
  refetches above (mount, refocus, invalidation), each at the same per-call price. Neither was
  measured.

`getDashboardDay`, polled at the same 60 s (twice while a day is peeked). **Not measured in
production.**

- Same local plans: the day's departures open with
  `SEARCH slots USING INDEX slots_org_service_date_idx (organization_id=?)`. That reads every slot
  of the organization, past and already-generated future, and filters to the day after reading.
  Both money reads open with `SEARCH folio_payments USING INDEX folio_payments_shift_idx
  (organization_id=?)`. That reads every ledger row of the organization (payments, refunds,
  commissions, reversals) and filters by type and date after reading. Like `/counts`, its cost
  grows with history.
- [NEEDS CLARIFICATION: rows read per `getDashboardDay` call in production. The `slots` and
  `folio_payments` row counts were not measured on 2026-10-15, so its share of the polled cost is
  unknown.]

## Paying it

Paid means a `/counts` call reads in proportion to the work that is pending, not to the
organization's history. The same holds for `getDashboardDay`'s `slots` and `folio_payments` reads,
which must read in proportion to the day. Whatever the fix, it keeps what the counts promise:

- **Whole-organization scope.** Rule 4, S-3/S-4, pinned by "US-A84 — the counts are counts" in
  `api-turistear/test/folios/folio-lifecycle-unification.test.ts`.
- **One definition per predicate.** The list, the counts and the facets "must never disagree", as
  the header of `folioPendingWork.ts` says.
- **A clock read at query time, never stored.** The comment on `overdueFilter` requires it, and so
  does constitution II: "a new money state is derived from recorded movements, never stored beside
  them".

It would touch `api-turistear/src/routes/folios/handler.ts`, `api-turistear/src/utils/folioPendingWork.ts`
and `api-turistear/src/routes/dashboard/handler.ts`, plus a migration if the fix needs one. If the
polling convention moves, it also touches `useDashboard.ts` and `DashboardPage.tsx`. Choosing how
needs a spec (`/speckit-specify`), not an edit. The 60 s convention is `occupancy-dashboard.spec.md`
D3, and the whole-organization scope is US-A84 D7 / rule 4. A change that only polls less, or stops
polling the counts, lowers the interest. Every call would still read the whole history, so that
change counts as `partial`, not paid.

Confirm afterwards:

- **A plan test in `api-turistear/test/`.** It follows the shape of
  `api-turistear/test/folios/correlation-indexes.test.ts`, whose `planOf` renders the handlers' own
  drizzle fragments and runs `EXPLAIN QUERY PLAN` on the local D1. It covers each statement
  `listFolioCounts` issues, plus the `slots` read and both `folio_payments` reads of
  `getDashboardDay`. For each one, no plan line matches `/^SCAN (folios|slots|folio_payments)\b/` or
  `/^SEARCH (folios|slots|folio_payments) USING (COVERING )?INDEX \S+ \(organization_id=\?\)$/`.
  All eight of those statements match the second pattern today. `pnpm test:api` runs the test.
- **The 2026-10-15 measurement, re-run.** Run the five statements as raw SQL for the largest prod
  organization through `wrangler d1 execute guideme-db-prod --remote` and record `meta.rows_read`
  beside the 10,346 baseline. This is the evidence; the plan test is the pass/fail. Measure
  `getDashboardDay`'s reads the same way, which closes the marker above.
- **`pnpm test:api` passes.** That is necessary but not enough. It passes today with the debt
  present (see *Notes*).

**Trigger**: any move of the Cloudflare account back to Workers Free, where one Hoy screen open ~8 h
alone reads ≈ 4.8M of the 5M rows/day. Or the next change that adds a poller of `/counts`, a sixth
pending-work predicate, or another always-open admin screen: each one multiplies a read that
already grows with every sale.

## Notes

- Related entry: `cron-sweeps-full-scan`, logged in parallel. It covers the 15-minute cron sweeps,
  at ~5.1k rows per run in prod (≈ 490k/day): the same account quota, but a separate debt that is
  not recorded here.
- Citations to the private archive `leolicona/guide-me-docs` appear here only as code comments
  carry them:
  - US-A84, `folio-lifecycle-unification.spec.md` D7, rule 4, S-3/S-4: in `listFolioCounts`,
    `useFolioCounts` and `folioPendingWork.ts`.
  - `occupancy-dashboard.spec.md` D3: in `useDashboard.ts` and `DashboardPage.tsx`.
  - `TECH_DEBT #25`: the line-derived predicates.
  - BUG-042: migrations 0067/0068.
  - The constitution's "D1 reads are metered (archived TECH_DEBT #31)".
- Not a constitution violation. The endpoint meets the rule's letter: it is not a list endpoint, and
  no correlated subquery has a `SCAN`. The cost is in the outer loop, an index `SEARCH` on
  `organization_id` alone, which the rule does not cover.
- Why `pnpm test:api` alone proves nothing: `correlation-indexes.test.ts` › "the facet filters and
  the pending-work counts" passes with this debt present. It plans only one of the five predicates
  (`refundPendingFilter`) and forbids only `SCAN` of the child tables.
- The plan lines quoted above come from SQL written by hand from the same predicates, run on a local
  SQLite with no `sqlite_stat1`. D1's planner can differ, which is why the confirmation renders the
  real SQL and runs on the local D1.
- Background tabs do not poll. This was verified on TanStack Query 5.100.14 (the version
  `pnpm-lock.yaml` pins for `app-turistear/package.json`'s `^5.100.14`). `node_modules` is not
  installed in the worktree, so it was read from that exact version's npm package source.
  - In `queryObserver.ts`, the `refetchInterval` tick fetches only if `refetchIntervalInBackground`
    is set or `focusManager.isFocused()` is true.
  - In `focusManager.ts`, `isFocused()` is `document.visibilityState !== 'hidden'`.
  - The app sets neither option nor a custom focus manager.

  So a hidden tab, or a phone with its screen off, stops polling. A visible tab in an unfocused
  window keeps polling.
- Where the code differs from the description this entry was logged from (the code wins):
  - Only `overdueFilter` and `undeliveredFilter` reach `folio_payment_allocations`. The description
    said all five predicates do. `verificationPendingFilter` and `refundPendingFilter` correlate on
    `folio_lines` only, and `requestPendingFilter` on `folio_requests` only.
  - `refetchOnWindowFocus: true` is set explicitly on `useDashboardDay` only. `useFolioCounts`
    inherits it as TanStack's default.
  - `AppLayout` and `FolioListScreen` never poll. Only `DashboardPage` passes an interval.
  - A "no full `SCAN folios`" plan check would already pass: there is no `SCAN folios` in the plans
    today. The whole-history read is the org-only `SEARCH` that the exit condition above checks for.
