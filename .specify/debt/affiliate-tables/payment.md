# Debt Payment: the retired affiliate data still lives in D1

- **Slug**: affiliate-tables
- **Checked**: 2026-10-06
- **Verdict**: verified
- **Paid by**:
  - `specs/002-drop-affiliate-tables` — #155, migration `0069`, released to prod in #157
    (`main@3d54b6a`, Deploy Prod run 16);
  - `specs/003-delete-legacy-affiliates` — #159, migration `0070` and the guard removal, released
    to prod in #160 (`main@8b18f03`, Deploy Prod run 17, 2026-10-06 19:25 UTC);
  - `65a3e6c` (#158) — the comment that last named the retired ladder key.

## Anchors

As amended on 2026-10-06 (see the entry's Notes):

- The four affiliate tables and the six retired columns in `guideme-db` and `guideme-db-prod` — gone
- `api-turistear/src/db/schema.ts` — the "Retired: affiliates and their shift operators" note — gone
- `api-turistear/src/routes/services/handler.ts::legacyAffiliateCommissions` — gone
- `api-turistear/src/middleware/auth.ts::isRefused` — gone (removed by 003 D5)
- `api-turistear/src/routes/reports/handler.ts::exportCommissionReport`, the fallback
  `ROLE_LABEL[s.role] ?? s.role` — gone (003 D6). The typed lookup `ROLE_LABEL[s.role]` remains;
  it is the pre-001 form, with the role typed `admin | agent`.
- `app-turistear/src/pages/ReportsPage.tsx::roleLabel` — gone (003 D6)

## Exit condition

> One migration, once this change is in prod, in this order […]: `ALTER TABLE … DROP COLUMN` for
> the six columns, then `DROP TABLE affiliate_invitations`, `affiliate_commissions`,
> `affiliate_operators`, `affiliate_companies`. […] The same change removes
> `legacyAffiliateCommissions` and its delete from `routes/services/handler.ts`, and the cases of
> `api-turistear/test/retire-affiliates/retire-affiliates.test.ts` that seed the dropped objects.
> What becomes of the prod `affiliate` user row (role rewritten, or left and still refused) decides
> whether D3/D6 can go too.
>
> Confirm afterwards:
> - `grep -rn "affiliate_" api-turistear/src` finds nothing.
> - `pnpm test:api` passes (it applies every migration to a fresh local D1).
> - Against each environment: `SELECT name FROM sqlite_master WHERE name LIKE 'affiliate_%'`
>   returns no rows.

I checked this on `develop@8aa9350`, whose tree is identical to `main@8b18f03`, the code in
production, and in both databases after Deploy Prod run 17.

- **The migration** — `0069` dropped the six columns, then the tables, leaves before parents. It was
  the last migration in both environments until `0070`.
- **`legacyAffiliateCommissions`** — gone, together with the test cases that seeded the dropped
  objects (002).
- **The prod `affiliate` user row** — the developer chose to delete it together with its sale
  (*"Remove them, all affiliates must be removed"*, option "Delete user and their sales").
  Migration `0070` deleted every user stored as `affiliate` and everything tied to them (prod: 1
  user, 1 sale, its rows and 1 cash drop; dev: 1 user, 3 sales, 3 drops). With no such row left,
  D3/D6 went in the same change (003 D5, D6).
- **The three confirmations** — all hold (see Evidence).

## Evidence

```text
$ git diff --stat origin/main origin/develop    # main@8b18f03 vs develop@8aa9350
(no output — identical trees)

$ grep -rn "affiliate_" api-turistear/src
(no output; exit 1)

$ grep -rnE "isRefused|\?\? s\.role|\?\? role\b" api-turistear/src app-turistear/src
(no output; exit 1)

$ grep -rn "legacyAffiliateCommissions" api-turistear/src ; grep -rn "Retired: affiliates" api-turistear/src/db/schema.ts
(no output; exit 1 for both)

$ pnpm test:api                                 # on develop@8aa9350
 Test Files  76 passed (76)
      Tests  963 passed (963)
```

The suite applies every migration, `0069` and `0070` included, to a fresh local D1. The cases that
cover this debt:
- `test/retire-affiliates/drop-affiliate-tables.test.ts` — no `affiliate%` object, none of the six
  columns, every foreign key resolves;
- `test/retire-affiliates/delete-legacy-affiliates.test.ts` — `0070` replayed against a seeded
  legacy affiliate:
  - only that user's rows go;
  - seats come back exactly;
  - a cross-reference rolls back;
  - a suspended account is the only refusal;
  - the CSV labels read Administrador or Agente.

D1, read through the Cloudflare D1 API after Deploy Prod run 17 (19:25 UTC):

| DB | `SELECT name FROM sqlite_master WHERE name LIKE 'affiliate_%'` | retired columns | users with role `affiliate` | last migration | `PRAGMA foreign_key_check` |
| --- | --- | ---: | ---: | --- | --- |
| dev `guideme-db` | no rows | 0 | 0 | `0070_delete_legacy_affiliates.sql` | no rows |
| prod `guideme-db-prod` | no rows | 0 | 0 | `0070_delete_legacy_affiliates.sql` | no rows |

Row counts across `0070` matched `specs/003-delete-legacy-affiliates/quickstart.md` § Baseline
exactly, in both environments:

| DB | users | sales | lines | ledger | allocations | events | ticket links | drops |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| prod | 10 → 9 | 1,009 → 1,008 | 1,044 → 1,043 | 1,420 → 1,418 | 1,048 → 1,047 | 3,826 → 3,824 | 1,005 → 1,004 | 16 → 15 |
| dev | 11 → 10 | 642 → 639 | 653 → 650 | 1,541 → 1,535 | 819 → 816 | 1,662 → 1,654 | 428 → 425 | 43 → 40 |

Seats handed back:
- prod: the 2026-07-23 departure, 25 → 23;
- dev: three departures, 30 · 30 · 1 → 0 · 0 · 0.

## What remains

Nothing.
