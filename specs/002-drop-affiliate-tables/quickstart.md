# Quickstart: validate the drop

## Before merging

```bash
pnpm lint:app && pnpm test:app && pnpm test:api && pnpm build:api && pnpm build:app
pnpm --filter api-turistear exec vitest run test/retire-affiliates   # D7 — the schema guard
grep -rnE "affiliate_(companies|commissions|invitations|operators)" api-turistear/src   # → none (SC-004)
```

The API suite applies every migration, `0069` included, to a fresh local D1.

## Release order (D2)

1. `feat/retire-affiliates` (001) merges to `develop`, is released `develop → main`, and is deployed
   to production.
2. Only then does this branch merge to `develop` (dev migrates and deploys), and ship in the next
   release to `main`.

## Baseline — before `0069` (read 2026-10-06 16:09 UTC, after release #156)

| DB | users | folios | folio_payments | folio_events | `affiliate%` objects | last migration |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| dev `guideme-db` | 11 | 642 | 1,541 | 1,662 | 11 | `0068` |
| prod `guideme-db-prod` | 10 | 1,009 | 1,420 | 3,826 | 11 | `0068` |

The 11 objects are the four tables and their seven indexes.

## In each environment — right before and right after its deploy (SC-001, SC-002)

```sql
SELECT (SELECT count(*) FROM users) AS users, (SELECT count(*) FROM folios) AS folios,
       (SELECT count(*) FROM folio_payments) AS payments, (SELECT count(*) FROM folio_events) AS events;
-- after: the same four numbers (plus whatever was sold in between)

SELECT type, name FROM sqlite_master WHERE name LIKE 'affiliate%';      -- after: no rows
SELECT name FROM pragma_table_info('folios') WHERE name IN ('operator_id', 'affiliate_company_id');
                                                                         -- after: no rows
```

(Via `wrangler d1 execute guideme-db --remote --env dev --command "…"`, and `guideme-db-prod --env
production` for prod.) Then close the debt with `/speckit-debt-pay affiliate-tables`.
