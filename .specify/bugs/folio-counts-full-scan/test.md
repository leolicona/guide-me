# Bug Verification: Hoy's polled reads visit the organization's whole history every minute

- **Slug**: folio-counts-full-scan
- **Tested**: 2026-10-16
- **Assessment**: ./assessment.md
- **Fix**: ./fix.md
- **Result**: partial

## Summary

On a local D1 seeded to production's shape, the symptom no longer reproduces. One Hoy poll —
the five counts plus the day's three reads — reads **229 rows instead of 14,020**, and all eight
statements return exactly what they returned before. The full API suite, the build and the
type-check show no regression.

The result is `partial`, not `verified`, for one reason. The assessment's reproduction was
measured **in production** (`meta.rows_read` against `guideme-db-prod`), and the fix is not
deployed anywhere yet. That measurement cannot be repeated until the preview applies migration
`0074` to dev and a release takes it to production.

## Checks Performed

| Check | Command / Action | Result | Notes |
|-------|------------------|--------|-------|
| Reproduction, production scale (post-fix) | Temporary vitest file, run and deleted. It seeds the local D1 to production's 2026-10-16 shape, then measures `meta.rows_read` of the old SQL with `0074`'s indexes dropped, against the new SQL with them | pass | 14,020 → 229 rows per poll; 8 of 8 statements return the same result |
| Reproduction in production | `meta.rows_read` of the same statements on `guideme-db-prod` | not-run | The fix is not deployed. Production is at migration `0070` and dev at `0071` (`d1_migrations`, read 2026-10-16) |
| Query plans | `test/folios/hoy-polled-reads.test.ts` (plan pins on the handlers' own statements) | pass | Every count is driven by its candidate set; the day reads enter by day |
| New / updated tests | `npx vitest run test/folios/hoy-polled-reads.test.ts test/folios/correlation-indexes.test.ts` | pass | 2 files, 6 tests |
| Regression suite | `pnpm test:api` | pass | 80 files, 1,011 tests |
| Build | `pnpm build:api` | pass | built in 3.97 s |
| Type-check | `npx tsc --noEmit -p api-turistear/tsconfig.json`, diffed against the base without the fix (line numbers ignored) | pass | No new error in `src/`. The 6 new lines are the repo-wide `cloudflare:test` typing class, all in the new test file (146 occurrences at the base). CI does not type-check the API |
| App lint / tests | `pnpm lint:app`, `pnpm test:app` | skipped | The branch changes no file under `app-turistear/` (`git diff --stat origin/main..HEAD -- app-turistear` is empty) |
| CI `verify` | GitHub Actions on a pull request | not-run | No pull request is open yet |
| Migration number | `git ls-tree origin/main api-turistear/migrations/`; `d1_migrations` on dev and prod | pass | `main` ends at `0071`; `0072` and `0073` exist nowhere yet, so `0074` is free as of 2026-10-16 |

## Output Excerpts

The production-scale reproduction. The local data held 1,011 folios, 1,011 lines, 1,424 ledger
rows and 1,980 slots in one organization. It had 1 pending verification, 33 cancelled folios
never delivered, 1 pending request, no refunds owed and no live clocks.

```text
counts.verification    before rows_read= 1012  after rows_read=   5  same_result=true  n=1
counts.refunds         before rows_read= 3032  after rows_read=   1  same_result=true  n=0
counts.overdue         before rows_read= 3032  after rows_read=   2  same_result=true  n=0
counts.undelivered     before rows_read= 1077  after rows_read= 169  same_result=true  n=0
counts.folio_requests  before rows_read= 1012  after rows_read=   3  same_result=true  n=1
day.slots              before rows_read= 2004  after rows_read=  37  same_result=true
day.collected          before rows_read= 1424  after rows_read=   3  same_result=true
day.perSeller          before rows_read= 1427  after rows_read=   9  same_result=true
TOTAL per poll          before=14020  after=229
```

The local "before" matches what production measured, which is what makes this a faithful
reproduction:

| Statement | Production (assessment) | Local, before |
|-----------|------------------------:|--------------:|
| Day's slots | 2,004 | 2,004 |
| Day's money | 1,424 | 1,424 |
| Five counts | ~9.3k (10,346 minus a ~1k helper CTE) | 9,165 |

Test runs:

```text
 Test Files  2 passed (2)        Tests  6 passed (6)          # hoy-polled-reads + correlation-indexes
 Test Files  80 passed (80)      Tests  1011 passed (1011)    # pnpm test:api
✓ built in 3.97s                                              # pnpm build:api
base=1812 head=1818   → 6 new lines, all in test/folios/hoy-polled-reads.test.ts
```

The `DNS lookup failed … api.resend.com` lines the suite prints come from this sandbox having no
network; nothing fails on them.

## Residual Risks

- **The production planner is not the test planner.** Both are SQLite without statistics today,
  and production has no `sqlite_stat*` tables (checked 2026-10-15/16). If someone later runs
  `PRAGMA optimize` on production, its plans could differ from the ones the test pins. The
  post-release `meta.rows_read` measurement is the guard.
- **What the reproduction does not model.** It seeds no apartados and no cancelled lines with
  clocks. In production, `overdue`'s candidate set also holds every settled apartado, because a
  line's clock is never cleared (`cron-sweeps-full-scan`, Notes), so it grows with apartados sold.
  It still grows far more slowly than the whole history did.
- **Index write cost.** The seven new indexes add one written row per write that touches their
  columns, including one per generated slot. This was not measured.
- **The list's default window is not part of this fix.** `listWindowFilter` → `pendingWorkFilter`
  now evaluates each candidate set once, but its outer loop is still org-driven. It is not polled.
- **D19.** The preview applies `0074` to dev's D1 as soon as the pull request opens, and the
  migration cannot be renamed afterwards. Re-check the number against `main` right before opening.

## Recommendation

**Hold the bug open until it is measured in production.** Verified locally, end to end at
production scale.

1. Open the pull request: `0074` is still free today.
2. Once the preview has applied `0074` to dev, re-run the counts and day statements on
   `guideme-db` with `meta.rows_read`.
3. After the release, do the same on `guideme-db-prod`, beside the 10,346 / 2,004 / 1,424
   baselines.

If production confirms it, this report can be amended to `verified`, and
`/speckit-debt-pay folio-counts-full-scan` can close the debt with those figures as evidence. Debt
PR #167 should be on `main` first.
