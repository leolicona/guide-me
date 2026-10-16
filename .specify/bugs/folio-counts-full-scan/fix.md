# Bug Fix: Hoy's polled reads visit the organization's whole history every minute

- **Slug**: folio-counts-full-scan
- **Fixed**: 2026-10-16
- **Assessment**: ./assessment.md
- **Status**: applied

## Summary

The five pending-work predicates now name their **candidate set** first, as
`folios.id IN (<an org-scoped subquery one index serves>)`. The counts run with the tenant term
written `+folios.organization_id = ?`, so SQLite drives each count from its candidates instead of
from every folio of the organization. Migration `0074` adds the seven indexes those sets and
`getDashboardDay`'s day reads enter. No recorded decision moved: the counts are still over the
whole organization, the list, facets and counts still share one definition per predicate, the
clock is still read at query time, and the poll is still 60 s.

## Changes

| File | Change | Notes |
|------|--------|-------|
| `api-turistear/migrations/0074_hoy_polled_read_indexes.sql` | added | Seven indexes, hand-written SQL in the BUG-042 (`0067`/`0068`) style: additive, `IF NOT EXISTS`, no backfill |
| `api-turistear/src/utils/folioPendingWork.ts` | modified | Every predicate takes `org` and opens with its candidate set; new `pendingWorkCountQueries(db, org, now)` builds the five count statements with the `+` tenant term |
| `api-turistear/src/routes/folios/handler.ts` | modified | `listFolioCounts` runs `pendingWorkCountQueries`; the list's `?overdue=true` facet passes `org` |
| `api-turistear/src/routes/dashboard/handler.ts` | modified | The slots read and the two ledger reads are extracted as `daySlotsQuery` and `dayMoneyQueries`; their SQL is unchanged |
| `api-turistear/test/folios/hoy-polled-reads.test.ts` | added test | Plan pins for the seven polled statements, plus a two-org isolation case |
| `api-turistear/test/folios/correlation-indexes.test.ts` | modified | One argument: `refundPendingFilter()` became `refundPendingFilter('org')`; the assertion is unchanged |

The indexes in `0074`:

| Index | Serves |
|-------|--------|
| `folios (organization_id, payment_verification)` | `verificationPendingFilter` |
| `folios (organization_id, tickets_sent_at, tickets_viewed_at)` | `undeliveredFilter` |
| `folio_lines (organization_id, refund_status, folio_id)` | `refundPendingFilter` (covering) |
| `folio_lines (organization_id, cancelled_at, booking_expires_at)` | `overdueFilter` |
| `folio_requests (organization_id, status, folio_id)` | `requestPendingFilter` (covering) |
| `slots (organization_id, date)` | `daySlotsQuery` |
| `folio_payments (organization_id, created_at)` | `dayMoneyQueries` |

## Diff Highlights

A predicate before and after (`refundPendingFilter`):

```ts
// before: tested folio by folio, so a count visited every folio of the org
sql`exists (select 1 from folio_lines fl where fl.folio_id = folios.id and fl.refund_status = 'pending')`

// after: the candidate set, evaluated once through folio_lines_org_refund_idx
sql`folios.id in (
  select fl.folio_id from folio_lines fl
  where fl.organization_id = ${org} and fl.refund_status = 'pending'
)`
```

The count statement (`pendingWorkCountQueries`):

```ts
db.select({ n: sql<number>`count(*)` })
  .from(folios)
  .where(and(sql`+${folios.organizationId} = ${org}`, predicate))
```

The rewrite needs both halves. With the `IN` form but an indexable tenant term, the planner still
entered `folios` by organization and used the candidate list only as a membership test; mutation M1
below shows it.

## Tests Added or Updated

- `test/folios/hoy-polled-reads.test.ts › each pending-work count is driven from its candidate set`
  - Renders `pendingWorkCountQueries`, the statements the handler runs, and plans each one.
  - No plan line may be a full read: `SCAN` of `folios`, `folio_lines`, `folio_payment_allocations`,
    `folio_requests`, `slots` or `folio_payments`, matched by table name or by alias (`f2`, `fl`,
    `a`), nor a `SEARCH … (organization_id=?)` through any index.
  - Every count must fetch its folios by primary key (`sqlite_autoindex_folios_1 (id=?)`).
  - The SQL must still carry `+"folios"."organization_id" = ?`.
- `test/folios/hoy-polled-reads.test.ts › Hoy's day reads enter the day`
  - Plans `daySlotsQuery` and both `dayMoneyQueries`.
  - Requires `slots_org_date_idx (organization_id=? AND date=?)` and
    `folio_payments_org_created_idx (organization_id=? AND created_at>? AND created_at<?)`.
- `test/folios/hoy-polled-reads.test.ts › multitenancy › org A's counts never include org B's pending work, of any kind`
  - Org A holds one folio of each kind of pending work; org B holds two of each.
  - A expects 1 of each and B expects 2 of each, so a count that loses its scope reads 3.
- `test/folios/correlation-indexes.test.ts` (BUG-042): only the call changed, to the new signature.
  Its assertion, no `SCAN` of a child table, still holds: the refunds plan is
  `SEARCH fl USING COVERING INDEX folio_lines_org_refund_idx (organization_id=? AND refund_status=?)`.

## Local Verification

**Commands run**:

- **Baseline, before any change.** `npx vitest run` over `correlation-indexes`,
  `folio-lifecycle-unification`, `pending-queues`, `dashboard-day`, `cancel-unverified-guard` and
  `folio-fulfillment`: 6 files, 78 tests passed.
- **The new test.** `npx vitest run test/folios/hoy-polled-reads.test.ts`: 3 passed.
- **The full API suite.** `pnpm test:api`: **80 files, 1,011 tests passed**. This includes the six
  baseline suites, unedited apart from the one argument above. The `DNS lookup failed … api.resend.com`
  lines are this sandbox having no network; nothing fails on them.
- **The build.** `pnpm build:api`: built.
- **Types.** `npx tsc --noEmit -p api-turistear/tsconfig.json` reports no new errors in `src/`,
  compared against the same base without this change.
  - The base already prints 1,812 lines of errors; CI does not type-check the API.
  - The 6 new lines are all in the new test file and are the repo-wide `cloudflare:test` typing
    class: 146 occurrences at the base, the same ones `correlation-indexes.test.ts` shows.

**Query plans on local D1 (workerd's SQLite, no statistics):**

| Statement | Plan, entry lines |
|-----------|-------------------|
| counts.verification | `SEARCH folios … sqlite_autoindex_folios_1 (id=?)` · `LIST SUBQUERY` · `SEARCH f2 … folios_org_verification_idx (organization_id=? AND payment_verification=?)` |
| counts.refunds | `SEARCH folios … (id=?)` · `SEARCH fl USING COVERING INDEX folio_lines_org_refund_idx (organization_id=? AND refund_status=?)` |
| counts.overdue | `SEARCH folios … (id=?)` · `SEARCH fl … folio_lines_org_live_clock_idx (organization_id=? AND cancelled_at=? AND booking_expires_at>? AND booking_expires_at<?)` |
| counts.undelivered | `SEARCH folios … (id=?)` · `SEARCH f2 … folios_org_undelivered_idx (organization_id=? AND tickets_sent_at=? AND tickets_viewed_at=?)` |
| counts.folio_requests | `SEARCH folios … (id=?)` · `SEARCH folio_requests USING COVERING INDEX folio_requests_org_status_idx (organization_id=? AND status=?)` |
| day.slots | `SEARCH slots USING INDEX slots_org_date_idx (organization_id=? AND date=?)` |
| day.collected, day.perSeller | `SEARCH folio_payments USING INDEX folio_payments_org_created_idx (organization_id=? AND created_at>? AND created_at<?)` |

**Rows read on local D1.** `meta.rows_read`, with 404 folios in one organization: 400 inert ones
and one of each pending kind. "Before" is the old SQL with `0074`'s indexes dropped; "after" is the
new SQL. The counts returned are identical.

| Count | Before | After |
|-------|-------:|------:|
| verification | 405 | 5 |
| refunds | 1,210 | 3 |
| overdue | 1,212 | 6 |
| undelivered | 415 | 24 |
| folio_requests | 404 | 1 |
| **total** | **3,646** | **39** |

With the indexes present but the old SQL, verification and undelivered already drop (3 and 16
rows), but refunds, overdue and requests stay at 1,210, 1,212 and 404. The indexes alone do not fix
the three child-driven counts; the candidate-set form is needed.

**Mutation tests.** Each mutation was applied to a backed-up copy, run against
`hoy-polled-reads.test.ts`, then restored and checked by checksum.

| Mutation | Result |
|----------|--------|
| M1 — tenant term indexable again (no `+`) | the counts plan test **fails** |
| M2 — migration `0074` removed | both plan tests **fail** |
| M3 — tenant term removed entirely | isolation still passes (the inner scopes hold); the SQL-text assertion **fails** |
| M4 — every inner org scope removed | isolation still passes (the outer term holds) |
| M5 — both removed | isolation **fails**: org A reads 3 of every kind |

**Manual checks**: none. The production figures are taken after the preview or the release (see
Follow-ups).

## Deviations from Assessment

1. **Non-partial composite indexes instead of the two partial ones.** The assessment proposed
   `folio_lines (organization_id, folio_id) WHERE refund_status = 'pending'` and
   `folio_lines (organization_id, booking_expires_at) WHERE cancelled_at IS NULL AND booking_expires_at IS NOT NULL`.
   The fix uses `(organization_id, refund_status, folio_id)` and
   `(organization_id, cancelled_at, booking_expires_at)`.
   - Gained: every plan line now names exactly what it narrows on, so the test refuses every
     org-only `SEARCH` with no allowlist of "harmless" partial indexes.
   - Cost: one index row per line write, rather than only for qualifying rows.
2. **A seventh index, on `folio_requests (organization_id, status, folio_id)`.** The assessment said
   `folio_requests` needed nothing, relying on `uq_folio_requests_open … WHERE status = 'pending'`.
   That does not hold:
   - drizzle binds `status = ?` as a parameter, and SQLite cannot match a bound parameter against a
     partial index's literal;
   - `folio_requests` had no index led by `organization_id` at all, which constitution III asks for.

   Without this index the requests subquery would read every request of every organization.
3. **`test/folios/correlation-indexes.test.ts` was edited, one argument.** The assessment listed it
   among the suites that must pass unedited. `refundPendingFilter` now takes `org`, because an
   unscoped candidate subquery would read other tenants' rows (constitution III). The BUG-042
   assertion is untouched and still passes.
4. **`api-turistear/src/routes/dashboard/handler.ts` changed, though the assessment said "no query
   change" and did not list the file.** The query builders moved verbatim; nothing in them changed.
   The three reads are extracted into `daySlotsQuery` and `dayMoneyQueries` so the plan test renders the handler's own
   statements rather than a copy (BUG-042's rule). The grouped seller read is included because its
   `GROUP BY collected_by` could tempt the planner back to `folio_payments_shift_idx`.
   `dashboard-day.test.ts` passes unedited.
5. **The test refuses full reads by index name and table alias, as the assessment refined it, plus
   one SQL-text assertion that the tenant term is still present.** Mutation M3 showed that nothing
   else notices the term gone, because the inner scopes keep the counts right.
6. **`requestPendingFilter` uses drizzle's `inArray(folios.id, <subquery>)`.** The other predicates
   use raw SQL; this one keeps the typed columns it already had.

## Follow-ups

- **Before opening the PR,** confirm that `0074` is still the next free number on `main`.
  - `0072` is reserved for the password-column drop and `0073` is claimed by
    `specs/006-devolada-transfer-verification`.
  - The preview applies a PR's pending migrations to dev's D1 as soon as it opens, and D19 forbids
    renaming a migration after that.
- **Evidence for `/speckit-debt-pay folio-counts-full-scan`:** after the preview applies `0074` to
  dev, and again after the release, re-measure `meta.rows_read` for `/counts` and the day reads
  beside the baselines (10,346 / 2,004 / 1,424). Debt PR #167 should be on `main` first.
- **Still open from the assessment:**
  - `PRAGMA optimize` after the migration.
  - The list's default window (`listWindowFilter` → `pendingWorkFilter`). It now evaluates each
    candidate set once (`LIST SUBQUERY`) instead of five correlated subqueries per folio, but its
    outer loop is still org-driven.
  - The merge order with #167.
- **`cron-sweeps-full-scan`:**
  - Its `[NEEDS CLARIFICATION]` is answered: local D1 under `@cloudflare/vitest-pool-workers` does
    report `meta.rows_read`. The figures above were taken that way.
  - `folio_lines_org_live_clock_idx` is the index that debt's `due` query could enter once it is
    driven from `folio_lines`. That change is not made here.
