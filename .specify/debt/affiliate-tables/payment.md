# Debt Payment: the retired affiliate data still lives in D1

- **Slug**: affiliate-tables
- **Checked**: 2026-10-06
- **Verdict**: partial
- **Paid by**: `specs/002-drop-affiliate-tables` — #155 (migration
  `api-turistear/migrations/0069_drop_affiliate_tables.sql`), released to production in #157
  (`main@3d54b6a`, Deploy Prod run 16, 2026-10-06 16:30 UTC), applied to dev by Deploy Dev run 114
  (`develop@4164b15`); plus `65a3e6c` on `docs/affiliate-tables-payment` (the D8 comment stops
  naming the retired ladder key)

## Anchors

As amended on 2026-10-06 (`c76724d`; see the entry's Notes):

- The four affiliate tables and the six retired columns in `guideme-db` and `guideme-db-prod` — gone
- `api-turistear/src/db/schema.ts` "Retired: affiliates and their shift operators" note — gone
- `api-turistear/src/routes/services/handler.ts::legacyAffiliateCommissions` — gone
- `api-turistear/src/middleware/auth.ts::isRefused` — present
- `api-turistear/src/routes/reports/handler.ts::exportCommissionReport` (`ROLE_LABEL[s.role] ?? s.role`)
  — present
- `app-turistear/src/pages/ReportsPage.tsx::roleLabel` — present

## Exit condition

> One migration, once this change is in prod, in this order […]: `ALTER TABLE … DROP COLUMN` for
> the six columns, then `DROP TABLE affiliate_invitations`, `affiliate_commissions`,
> `affiliate_operators`, `affiliate_companies`. […] The same change removes
> `legacyAffiliateCommissions` and its delete from `routes/services/handler.ts`, and the cases of
> `api-turistear/test/retire-affiliates/retire-affiliates.test.ts` that seed the dropped objects.
> What becomes of the prod `affiliate` user row […] decides whether D3/D6 can go too.
>
> Confirm afterwards:
> - `grep -rn "affiliate_" api-turistear/src` finds nothing.
> - `pnpm test:api` passes (it applies every migration to a fresh local D1).
> - Against each environment: `SELECT name FROM sqlite_master WHERE name LIKE 'affiliate_%'`
>   returns no rows.

Checked on `docs/affiliate-tables-payment@c76724d` and in both databases. **Every part of the exit
condition holds:**

- **The migration** ran in that order, deployed after 001: `0069` is the last row of
  `d1_migrations` in dev and in prod.
- **`legacyAffiliateCommissions`** and the seeding test cases are removed.
- **The grep** finds nothing.
- **`pnpm test:api`** passes.
- **Each environment** has no `affiliate_%` object and none of the six columns.

The entry makes D3/D6 conditional: *"What becomes of the prod `affiliate` user row … decides whether
D3/D6 can go too."* That row still exists, in prod and in dev, so their three anchors are present.
The verdict is therefore `partial`, not `verified`: every anchor must be gone.

## Evidence

```text
$ git diff --stat 65a3e6c c76724d      # only the register changed since the test run
 .specify/debt/affiliate-tables/debt.md    | 24 +++++----
 .specify/debt/affiliate-tables/payment.md | 90 ++++++++++++++++---------------

$ grep -rn "affiliate_" api-turistear/src          # on c76724d
(no output; exit 1)

$ pnpm test:api                                     # on 65a3e6c (same code tree as c76724d)
 Test Files  75 passed (75)
      Tests  961 passed (961)
```

D1, read through the Cloudflare D1 API (`d1_database_query`) at 16:45 UTC:

| DB | `affiliate_%` objects | retired columns present | last migration | users with role `affiliate` |
| --- | ---: | ---: | --- | ---: |
| dev `guideme-db` | 0 | 0 | `0069_drop_affiliate_tables.sql` | 1 |
| prod `guideme-db-prod` | 0 | 0 | `0069_drop_affiliate_tables.sql` | 1 |

Earlier the same day:
- Row counts of `users`/`folios`/`folio_payments`/`folio_events` were unchanged across `0069`:
  dev 11 / 642 / 1,541 / 1,662, prod 10 / 1,009 / 1,420 / 3,826.
- `PRAGMA foreign_key_check` on prod returned no rows.

The schema guard in code is `api-turistear/test/retire-affiliates/drop-affiliate-tables.test.ts`.

## What remains

- **The `users` row stored with role `affiliate`** — one in prod, one in dev. The developer settles
  it outside the product (their decision in `specs/002-drop-affiliate-tables`, D4).
- **Once it is settled**, the three anchors above — `auth.ts::isRefused`, the CSV label fallback in
  `exportCommissionReport`, and `ReportsPage.tsx::roleLabel` — can leave this entry. Two ways:
  - removed from the code through the normal flow;
  - kept as generic guards against any unknown stored role, which is what they already are in
    code. The entry's anchors would then be amended the way the migrations were, on the
    developer's word.

Then re-run `/speckit-debt-pay affiliate-tables`. Nothing else is outstanding.
