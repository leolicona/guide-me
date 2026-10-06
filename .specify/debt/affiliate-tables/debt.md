---
slug: affiliate-tables
status: open
kind: deliberate
severity: low
effort: days
opened: 2026-10-06
---

# Technical Debt: the retired affiliate data still lives in D1

## What was traded

`specs/001-retire-affiliates` removed the affiliate role and its shift operators from the code but
left their data in D1 on purpose (plan D1): a migration runs before the code it ships with and must
stay compatible with the code already deployed, and a `DROP` cannot be undone. The tables and
columns were unmapped from Drizzle instead (D2), so nothing reads or writes them by accident.

## Where it lives

- `api-turistear/migrations/0034_add_affiliates.sql` — creates `affiliate_companies`,
  `affiliate_commissions`, `affiliate_invitations` and adds `users.affiliate_company_id`,
  `users.position`, `folios.affiliate_company_id`.
- `api-turistear/migrations/0048_affiliate_operators.sql` — creates `affiliate_operators` and adds
  `folios.operator_id`.
- `api-turistear/migrations/0049_folio_payments.sql` — `folio_payments.operator_id`
  ("`operator_id TEXT REFERENCES affiliate_operators(id)`").
- `api-turistear/migrations/0061_folio_events.sql` — `folio_events.operator_id`
  ("`operator_id TEXT REFERENCES affiliate_operators(id)`").
- `api-turistear/src/db/schema.ts` — the "Retired: affiliates and their shift operators" note
  (`retire-affiliates D2`) that names every unmapped table and column.
- `api-turistear/src/routes/services/handler.ts::legacyAffiliateCommissions` — the two-column
  mapping the service hard-delete uses to clear legacy `affiliate_commissions` rows, which
  FK-reference `services` with `ON DELETE no action` (D7).
- `api-turistear/src/middleware/auth.ts::isRefused` — refuses a user row still stored with role
  `affiliate` (D3); exists because prod keeps one.
- `api-turistear/src/routes/reports/handler.ts::exportCommissionReport` and
  `app-turistear/src/pages/ReportsPage.tsx::roleLabel` — print a stored role the product no longer
  knows (`ROLE_LABEL[s.role] ?? s.role`, D6).

## Interest

- Four tables nobody reads sit in both databases (prod on 2026-10-06: 2 companies, 5 commission
  rows, 2 invitations, 0 operators), and every reader of the migration history has to know they
  are dead.
- Six nullable FK columns ride on `users`, `folios`, `folio_payments` and `folio_events`; every
  raw-SQL test seed or backfill that lists columns has to step around them.
- One table is still written by code (D7): any change to the service hard-delete has to keep the
  local mapping in its batch, or deleting an unsold service that carries a legacy row fails with a
  foreign-key error.
- The D3 refusal and the D6 label fallback stay in the code for as long as a `users` row carries
  role `affiliate`.

## Paying it

Two parts, payable separately:

1. **The tables** — once this change is in prod: a migration nulls the child keys
   (`folios.affiliate_company_id`, `folios.operator_id`, `folio_payments.operator_id`,
   `folio_events.operator_id`, `users.affiliate_company_id`) and drops `affiliate_invitations`,
   `affiliate_commissions`, `affiliate_operators`, `affiliate_companies`, in that order. The same
   change removes `legacyAffiliateCommissions` and its delete from
   `routes/services/handler.ts`, and the D7 case of
   `api-turistear/test/retire-affiliates/retire-affiliates.test.ts`. Deciding what becomes of the
   prod `affiliate` user row (role rewritten, or left and still refused) decides whether D3/D6 can go
   too.
2. **The columns** — SQLite's `ALTER TABLE … DROP COLUMN` refuses a column used in a foreign key,
   so each of the six needs the twelve-step table rebuild — three of them on the ledger tables. This
   part may never be worth paying on its own.

Confirm afterwards:

- `grep -rn "affiliate_" api-turistear/src` finds nothing.
- `pnpm test:api` passes (it applies every migration to a fresh local D1).
- Against each environment: `SELECT name FROM sqlite_master WHERE name LIKE 'affiliate_%'` returns
  no rows.

**Trigger**: this change verified in prod (nothing left to roll back to) — or any migration that
rebuilds `folios`, `folio_payments` or `folio_events` for another reason, which should drop the
retired columns in the same rebuild.

## Notes

- Decisions: `specs/001-retire-affiliates/plan.md` D1, D2, D3, D6, D7; the measurements and the
  SQLite constraints are in `research.md` R1, R2 and R4.
- Constitution v1.1.0 lists this as TODO(AFFILIATE-TABLES) in its Sync Impact Report.
