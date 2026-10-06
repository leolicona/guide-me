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

- `api-turistear/migrations/0034_add_affiliates.sql` — present (immutable migration history; the
  objects it creates are dropped by `0069` in both environments — see *What remains*)
- `api-turistear/migrations/0048_affiliate_operators.sql` — present (same)
- `api-turistear/migrations/0049_folio_payments.sql` — present (same; `folio_payments.operator_id`
  dropped)
- `api-turistear/migrations/0061_folio_events.sql` — present (same; `folio_events.operator_id`
  dropped)
- `api-turistear/src/db/schema.ts` "Retired: affiliates and their shift operators" note — gone
- `api-turistear/src/routes/services/handler.ts::legacyAffiliateCommissions` — gone
- `api-turistear/src/middleware/auth.ts::isRefused` — present (002 D4: prod still holds one `users`
  row with role `affiliate`)
- `api-turistear/src/routes/reports/handler.ts::exportCommissionReport` (`ROLE_LABEL[s.role] ?? s.role`)
  — present (same)
- `app-turistear/src/pages/ReportsPage.tsx::roleLabel` — present (same)

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

Checked on `docs/affiliate-tables-payment@65a3e6c` (= `main@3d54b6a` + the one-line comment fix) and
in both databases. **Every part of the exit condition holds:**

- **The migration, in that order, deployed after 001.** `0069` is the last row of `d1_migrations`
  in dev and in prod.
- **`legacyAffiliateCommissions` and the seeding test cases** — removed.
- **D3/D6** — kept, which the entry allows: the prod `affiliate` row still exists (1).
- **The grep** — finds nothing.
- **`pnpm test:api`** — passes.
- **Each environment** — no `affiliate_%` object.

**The verdict is still `partial` because seven anchors are present.** `verified` requires every
anchor gone.

## Evidence

```text
$ grep -rn "affiliate_" api-turistear/src        # on 65a3e6c
(no output; exit 1)

$ pnpm test:api                                   # on 65a3e6c
 Test Files  75 passed (75)
      Tests  961 passed (961)
```

D1, read through the Cloudflare D1 API (`d1_database_query`) at 16:42 UTC:

| DB | `affiliate_%` objects | last migration | users with role `affiliate` |
| --- | ---: | --- | ---: |
| dev `guideme-db` | 0 | `0069_drop_affiliate_tables.sql` | — |
| prod `guideme-db-prod` | 0 | `0069_drop_affiliate_tables.sql` | 1 |

Earlier the same day:
- Before and after `0069`, the row counts of `users`/`folios`/`folio_payments`/`folio_events` were
  unchanged: dev 11 / 642 / 1,541 / 1,662, prod 10 / 1,009 / 1,420 / 3,826.
- The six retired columns were absent in both environments after `0069`.
- `PRAGMA foreign_key_check` on prod returned no rows.

The schema guard that keeps this true in code is
`api-turistear/test/retire-affiliates/drop-affiliate-tables.test.ts`.

## What remains

1. **Four anchors that can never be `gone`.** `migrations/0034`, `0048`, `0049` and `0061` are
   immutable history. Deleting one would break every fresh migration run, `0069`'s included. They
   were anchored as the place the debt lived; the debt was the objects they create, and those are
   gone. This is an anchoring error in the entry, not unpaid work. Correcting it means amending the
   entry's *Where it lives*, which this command may not do — a decision for the developer.
2. **Three anchors that stay while a legacy row exists.** `auth.ts::isRefused`,
   `reports/handler.ts::exportCommissionReport`'s label fallback, and `ReportsPage.tsx::roleLabel`
   exist because prod keeps one `users` row with role `affiliate`. The developer settles that row
   outside the product. Afterwards, these guards can be removed through the normal flow, or kept as
   generic guards and dropped from this entry's anchors.

Re-run `/speckit-debt-pay affiliate-tables` once both are resolved.
