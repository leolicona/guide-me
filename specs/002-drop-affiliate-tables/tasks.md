---

description: "Task list for dropping the retired affiliate tables"
---

# Tasks: Drop the retired affiliate tables

**Input**: Design documents from `specs/002-drop-affiliate-tables/`

**Prerequisites**: plan.md, spec.md, research.md

**Tests**: required — the schema guard runs on the migrated D1 (D7).

## Format: `[ID] [P?] [Story] Description`

## Phase 1: User Story 1 — the database holds nothing of the retired program (P1)

**Goal**: the six columns, then the four tables, gone in one atomic migration.

**Independent Test**: schema listing, foreign-key listing, insert/delete on the former children.

- [x] T001 [US1] Probe the drop order in SQLite and in the workerd D1 with legacy rows (research R1)
- [x] T002 [US1] Write `api-turistear/migrations/0069_drop_affiliate_tables.sql` — columns, then leaves, then parents (D1)
- [x] T003 [US1] Write `api-turistear/test/retire-affiliates/drop-affiliate-tables.test.ts` (D7)
- [x] T004 [P] [US1] Strip `operator_id` from the 0061 replay in `api-turistear/test/folios/folio-timeline.test.ts` (D5)
- [x] T005 [P] [US1] Seed the legacy user as a bare `users` row; drop the invitation and D7 cases in `api-turistear/test/retire-affiliates/retire-affiliates.test.ts` (D7)

## Phase 2: User Story 2 — the code names nothing that is gone (P2)

- [x] T006 [US2] Remove `legacyAffiliateCommissions` and its delete from `api-turistear/src/routes/services/handler.ts` (D3)
- [x] T007 [P] [US2] Remove the "Retired" note from `api-turistear/src/db/schema.ts` (D6); fix the comment in `api-turistear/test/catalog/service-hard-delete.test.ts`

## Phase 3: Proof and close

- [x] T008 Run `quickstart.md` § Before merging
- [x] T009 `/speckit-debt-pay affiliate-tables` — the code half now; the environment checks after each deploy
- [ ] T010 After the release order (D2) completes: run `quickstart.md` § In each environment and re-run `/speckit-debt-pay affiliate-tables`

## Dependencies

- T001 before T002; T002 before T003–T005; T008 after all code tasks; T010 after deploy.
