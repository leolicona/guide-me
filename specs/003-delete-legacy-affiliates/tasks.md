---

description: "Task list for deleting the legacy affiliate users"
---

# Tasks: Delete the legacy affiliate users

**Input**: Design documents from `specs/003-delete-legacy-affiliates/`

**Prerequisites**: plan.md, spec.md, research.md, quickstart.md

**Tests**: required. The migration is replayed on the workerd D1 against seeded rows (D9).

## Format: `[ID] [P?] [Story] Description`

## Phase 1: User Story 1 — no affiliate is left, and nothing of theirs (P1)

**Goal**: one atomic migration hands the seats back and deletes the affiliates with everything tied
to them. It never touches another user's row.

**Independent Test**: seed an affiliate with every kind of row, plus an agent and a second
organization. Replay `0070` and read every table.

- [x] T001 [US1] Write `api-turistear/test/retire-affiliates/delete-legacy-affiliates.test.ts`, covering:
  - every acceptance scenario of US1;
  - the cross-reference failure;
  - the no-affiliate run.

  Watch it fail with no migration (D9).
- [x] T002 [US1] Write `api-turistear/migrations/0070_delete_legacy_affiliates.sql` in this order:
  1. seats (D2);
  2. sale children, then sales (D3);
  3. cash records;
  4. users (D1, D4).

  Make T001 pass.

## Phase 2: User Story 2 — the product knows two roles (P2)

- [x] T003 [US2] Remove `isRefused` from `api-turistear/src/middleware/auth.ts`. Both call sites check
  `status === 'suspended'`. Update the comments in `src/types/context.ts` and `src/db/schema.ts`
  (D5).
- [x] T004 [P] [US2] Type the role in `api-turistear/src/routes/reports/handler.ts` and drop its CSV
  fallback (D6).
- [x] T005 [P] [US2] Type the role in `app-turistear/src/features/reports/types.ts` and drop
  `roleLabel` from `app-turistear/src/pages/ReportsPage.tsx` (D6).
- [x] T006 [P] [US2] Update the cash-holder comment in `api-turistear/src/routes/cash/handler.ts` (D7).
- [x] T007 [US2] Edit `api-turistear/test/retire-affiliates/retire-affiliates.test.ts`:
  - remove the refusal and legacy-money cases;
  - seed its remaining cases without the legacy row (D9).
- [x] T008 [US2] Amend constitution III through `/speckit-constitution` (D8).

## Phase 3: Proof and close

- [x] T009 Run `quickstart.md` § Before merging.
- [x] T010 For each environment, run `quickstart.md` § In each environment right before its deploy
  (dev on merge to `develop`, prod on the release) and right after it.
- [x] T011 After prod: `/speckit-debt-pay affiliate-tables`.

## Dependencies

- T001 before T002.
- T003–T008 are independent of T001–T002.
- T009 after all code tasks.
- T010 after each deploy; T011 after T010 for prod.
