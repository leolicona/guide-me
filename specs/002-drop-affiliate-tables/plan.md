# Implementation Plan: Drop the retired affiliate tables

**Branch**: `feat/drop-affiliate-tables` | **Date**: 2026-10-06 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/002-drop-affiliate-tables/spec.md`

## Summary

Migration `0069_drop_affiliate_tables.sql` drops the six child columns with `ALTER TABLE … DROP
COLUMN`, then the four affiliate tables, leaves before parents. The service hard-delete loses its
legacy cleanup; `schema.ts` loses its note; the tests stop seeding what is gone and gain a schema
check that fails on a dangling foreign key. Ships only after 001 is in production (D2). Pays debt
`affiliate-tables`.

Code cites these decisions as `drop-affiliate-tables D<n>`.

## Decisions

**D1 — One migration, children first.** Six `DROP COLUMN`s (`folio_events`, `folio_payments`,
`folios` ×2, `users` ×2), then `affiliate_invitations`, `affiliate_commissions`,
`affiliate_operators`, `affiliate_companies`.
*Why*: measured ([research.md](./research.md) R1; 001 research R4): a parent dropped first leaves
every child unable to `INSERT` or `DELETE`; `DROP COLUMN` accepts the column-level `REFERENCES`
and needs no table rebuild. One file so it applies as one unit.

**D2 — Release order: 001 to production first, then this.**
*Why*: a migration runs before the code it ships with. Code older than 001 writes the dropped
columns on every sale; 001's code names only `affiliate_commissions`, and only in the service
hard-delete. So this change merges to `develop` only after 001 has been released to `main` and
deployed — never in the same release.
*Met*: 001 (#154) shipped in release #156, deployed to production by Deploy Prod run 15
(`586ec5a`, 2026-10-06 16:02 UTC).

**D3 — The service hard-delete's legacy cleanup leaves** (001 D7). The batch goes back to slot
zones, slots, schedules, service zones, extras and the service.
*Why*: its table is gone; kept, the statement would fail every hard delete.

**D4 — 001's guards for a stored retired role stay**: the `authMiddleware` refusal (001 D3), cash
holders as every non-admin user (001 D5), the report's stored-role label (001 D6).
*Why*: the migration does not touch `users.role`; the developer settles the prod row outside the
product, and until then — or if another such row ever appears — the guards keep the code honest
about what the column can hold. They name no dropped object.

**D5 — The 0061 replay strips `operator_id`.** `folio-timeline.test.ts` S-5 replays migration
0061's backfill `INSERT`s verbatim; two of them name `operator_id`, which 0069 removed. The replay
removes that column from the historical SQL before running it.
*Why*: what S-5 proves is the rest of the mapping; re-adding the column through the test shim in
`apply-migrations.ts` would widen a shim TECH_DEBT #25 is trying to sweep away.

**D6 — `schema.ts` drops its "Retired" note.** The record of what was there is 001's spec, this
spec and the migration.

**D7 — Proof.** `test/retire-affiliates/drop-affiliate-tables.test.ts` asserts on the migrated
schema: no `affiliate%` object, none of the six columns, every foreign key resolves, and the former
child tables accept an insert and a delete. `retire-affiliates.test.ts` keeps its US1–US3 cases
with the legacy user seeded as a bare `users` row; its invitation and D7 cases leave with their
tables.

## Technical Context

**Language/Version**: SQL (SQLite dialect, Cloudflare D1); TypeScript (ESM), Node 22

**Primary Dependencies**: Hono 4, Drizzle ORM (API)

**Storage**: Cloudflare D1 — one migration, `0069`

**Testing**: Vitest 4 with `@cloudflare/vitest-pool-workers` (every migration applied to a real
local D1)

**Target Platform**: Cloudflare Workers

**Project Type**: web service (the app is untouched)

**Performance Goals**: the migration rewrites four tables' rows once (prod: ~1,000 sales); no
runtime change

**Constraints**: atomic; zero rows lost; release order D2

**Scale/Scope**: 1 migration, 2 source files, 4 test files

## Constitution Check

| Principle | Gate | Result |
| --- | --- | --- |
| I. Spec-driven, cited | Spec, plan, tasks under `specs/002-drop-affiliate-tables/`; decisions numbered; scope boundary names the edited suites | PASS |
| II. Money law | No ledger value changes: `DROP COLUMN` keeps every other column (R1); row counts checked before and after (SC-002) | PASS |
| III. Tenant isolation | No route or query changes scope | PASS |
| IV. The server decides | No response shape changes | PASS |
| V. Capacity guarded by the DB | Untouched | PASS |
| VI. Proven where enforced | The schema guard runs in workerd against the migrated D1 (D7) | PASS |
| VII. Elegant Field Minimalism | No UI | PASS |
| VIII. Services we do not own | Untouched | PASS |
| Additional constraints — migrations | "additive and backward-compatible with the code already deployed" — this one is subtractive | **Justified below** |

## Project Structure

### Documentation (this feature)

```text
specs/002-drop-affiliate-tables/
├── spec.md
├── plan.md        # this file
├── research.md    # the measurements D1 rests on
├── quickstart.md  # how to validate, release order, post-deploy checks
├── checklists/
│   └── requirements.md
└── tasks.md
```

### Source Code (repository root)

```text
api-turistear/
├── migrations/0069_drop_affiliate_tables.sql     # new (D1)
├── src/db/schema.ts                              # note removed (D6)
├── src/routes/services/handler.ts                # legacy cleanup removed (D3)
└── test/
    ├── retire-affiliates/retire-affiliates.test.ts       # no seeding of dropped objects (D7)
    ├── retire-affiliates/drop-affiliate-tables.test.ts   # new (D7)
    ├── folios/folio-timeline.test.ts                     # 0061 replay strips operator_id (D5)
    └── catalog/service-hard-delete.test.ts               # comment only
```

**Structure Decision**: the existing API layout; nothing new besides the migration and one test file.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
| --- | --- | --- |
| A subtractive migration, against "Migrations … are additive and backward-compatible with the code already deployed" | Removing the retired data is the developer's request, and the debt 001 registered for it | Keeping the tables forever leaves dead schema on the ledger tables. Compatibility — what the rule protects — is kept by release order (D2): when 0069 runs, the deployed code is 001's, which names one dropped object in one admin-only statement. Residual risk, accepted: a service hard-delete in the seconds between the migration and the deploy answers an error, writes nothing (atomic batch) and succeeds on retry |
