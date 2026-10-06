# Debt Payment: the retired affiliate data still lives in D1

- **Slug**: affiliate-tables
- **Checked**: 2026-10-06
- **Verdict**: partial
- **Paid by**: `specs/002-drop-affiliate-tables` — #155 (migration
  `api-turistear/migrations/0069_drop_affiliate_tables.sql`), released to production in #157
  (`main@3d54b6a`, Deploy Prod run 16, 2026-10-06 16:30 UTC); applied to dev by Deploy Dev run 114
  (`develop@4164b15`, 16:20 UTC)

## Anchors

- `api-turistear/migrations/0034_add_affiliates.sql` — present (immutable history; every object it
  adds is dropped by `0069`, in both environments)
- `api-turistear/migrations/0048_affiliate_operators.sql` — present (same)
- `api-turistear/migrations/0049_folio_payments.sql` — present (same; `folio_payments.operator_id`
  dropped)
- `api-turistear/migrations/0061_folio_events.sql` — present (same; `folio_events.operator_id`
  dropped)
- `api-turistear/src/db/schema.ts` "Retired: affiliates and their shift operators" note — gone
- `api-turistear/src/routes/services/handler.ts::legacyAffiliateCommissions` — gone
- `api-turistear/src/middleware/auth.ts::isRefused` — present (kept on purpose: 002 D4; prod still
  holds one `users` row with role `affiliate`)
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

Checked on `main@3d54b6a` (tree identical to `develop@4164b15`) and in both databases:

- **The migration, in that order, deployed after 001** — holds. `0069` is the last row of
  `d1_migrations` in dev and in prod.
- **`legacyAffiliateCommissions` removed; seeding test cases removed** — holds.
- **D3/D6** — kept, as the entry allows: the prod `affiliate` user row still exists (1 row), and the
  developer settles it outside the product.
- **`grep -rn "affiliate_" api-turistear/src`** — does NOT find nothing: one hit, the D8 comment
  naming the retired ladder key `affiliate_commission_pct` (a JSON key, not a table). Literally, the
  check fails.
- **`pnpm test:api`** — passes.
- **Each environment** — holds: no `affiliate%` object, none of the six columns, row counts
  unchanged.

## Evidence

```text
$ git diff --stat 4372641 origin/main          # the tree verify passed on → empty

$ pnpm test:api                                 # on main@3d54b6a
 Test Files  75 passed (75)
      Tests  961 passed (961)

$ grep -rn "affiliate_" api-turistear/src
api-turistear/src/utils/cancellationPolicy.ts:25:  // retire-affiliates D8 — the optional `affiliate_commission_pct` (US-A72) is gone with the
```

D1, read through the Cloudflare D1 API (`d1_database_query`), before and after `0069`:

| DB | when (UTC) | users | folios | folio_payments | folio_events | `affiliate%` objects | retired columns | last migration |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| dev `guideme-db` | 16:09 before | 11 | 642 | 1,541 | 1,662 | 11 | 6 | `0068` |
| dev `guideme-db` | 16:21 after | 11 | 642 | 1,541 | 1,662 | 0 | 0 | `0069` |
| prod `guideme-db-prod` | 16:21 before | 10 | 1,009 | 1,420 | 3,826 | 11 | 6 | `0068` |
| prod `guideme-db-prod` | 16:33 after | 10 | 1,009 | 1,420 | 3,826 | 0 | 0 | `0069` |

`PRAGMA foreign_key_check` on prod after `0069`: no rows. The schema guard that keeps this true in
code is `api-turistear/test/retire-affiliates/drop-affiliate-tables.test.ts` (no `affiliate%` object,
none of the six columns, every foreign key resolves, the former child tables accept an insert and a
delete).

## What remains

1. **The grep.** `api-turistear/src/utils/cancellationPolicy.ts:25` names `affiliate_commission_pct`
   in the D8 comment. Rewording it ("the optional affiliate commission share (US-A72)") makes the
   entry's grep return nothing — a one-line source change through the normal flow, after which a
   re-run of `/speckit-debt-pay affiliate-tables` can reach `verified`.
2. **D3/D6** (`auth.ts::isRefused`, the stored-role labels) stay while the prod `affiliate` user row
   exists — by the entry's own terms, settling that row decides whether they go. Not required for
   `verified`.
