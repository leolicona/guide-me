# Debt Payment: the retired affiliate data still lives in D1

- **Slug**: affiliate-tables
- **Checked**: 2026-10-06
- **Verdict**: partial
- **Paid by**: `specs/002-drop-affiliate-tables` — migration
  `api-turistear/migrations/0069_drop_affiliate_tables.sql`, branch `feat/drop-affiliate-tables`,
  commit `c47bff1` (not merged, not deployed)

## Anchors

- `api-turistear/migrations/0034_add_affiliates.sql` — present (migrations are immutable history;
  every object it adds is dropped by `0069`)
- `api-turistear/migrations/0048_affiliate_operators.sql` — present (same; dropped by `0069`)
- `api-turistear/migrations/0049_folio_payments.sql` — present (same; `folio_payments.operator_id`
  dropped by `0069`)
- `api-turistear/migrations/0061_folio_events.sql` — present (same; `folio_events.operator_id`
  dropped by `0069`)
- `api-turistear/src/db/schema.ts` "Retired: affiliates and their shift operators" note — gone
- `api-turistear/src/routes/services/handler.ts::legacyAffiliateCommissions` — gone
- `api-turistear/src/middleware/auth.ts::isRefused` — present (kept on purpose: 002 D4)
- `api-turistear/src/routes/reports/handler.ts::exportCommissionReport` (`ROLE_LABEL[s.role] ?? s.role`)
  — present (kept on purpose: 002 D4)
- `app-turistear/src/pages/ReportsPage.tsx::roleLabel` — present (kept on purpose: 002 D4)

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

Checked on the tree at `c47bff1`:

- **The migration** — exists with exactly that order (`0069_drop_affiliate_tables.sql`). Holds.
- **`legacyAffiliateCommissions` and its delete** — removed. Holds.
- **The test cases seeding dropped objects** — `retire-affiliates.test.ts` now seeds only a bare
  `users` row with role `affiliate`; its invitation and D7 cases are gone. Holds.
- **D3/D6** — kept, as the entry allows: the prod `affiliate` user row is settled outside the product
  by the developer (002 D4).
- **`grep -rn "affiliate_" api-turistear/src`** — does NOT find nothing: one hit, a comment naming
  the retired ladder key `affiliate_commission_pct` (not a table). Literally, the check fails.
- **`pnpm test:api`** — passes.
- **Each environment** — not run: `0069` has not been applied to `guideme-db` or
  `guideme-db-prod`, and must not be until 001 is deployed to production (002 D2).

## Evidence

```text
$ grep -rn "affiliate_" api-turistear/src
api-turistear/src/utils/cancellationPolicy.ts:25:  // retire-affiliates D8 — the optional `affiliate_commission_pct` (US-A72) is gone with the

$ pnpm test:api
 Test Files  75 passed (75)
      Tests  961 passed (961)
```

The suite applies `0001`–`0069` to a fresh local D1. The assertions covering the debt are in
`api-turistear/test/retire-affiliates/drop-affiliate-tables.test.ts`: no `sqlite_master` object
named `affiliate%`, none of the six columns in `PRAGMA table_info`, every `PRAGMA foreign_key_list`
target exists, and `folios`/`folio_payments`/`folio_events` accept an insert and a delete.

## What remains

1. **The environments.** After the release order in `specs/002-drop-affiliate-tables/quickstart.md`
   completes (001 to production, then 002 merged and released), run in each of `guideme-db` and
   `guideme-db-prod`: `SELECT name FROM sqlite_master WHERE name LIKE 'affiliate_%'` → no rows.
   Who: the developer, or a session with the Cloudflare D1 connector.
2. **The grep.** `api-turistear/src/utils/cancellationPolicy.ts:25` names `affiliate_commission_pct`
   in the D8 comment. The entry's grep counts it; whether that comment should go (or the grep be
   read as "no `affiliate_*` table") is the developer's call at the next payment attempt.
3. **D3/D6** (`auth.ts::isRefused`, the stored-role labels) stay until the prod `affiliate` user
   row is resolved outside the product — by the entry's own terms, that decides whether they go.

Re-run `/speckit-debt-pay affiliate-tables` once 1 is done.
