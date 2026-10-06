---

description: "Task list for retiring affiliates and affiliate shift operators"
---

# Tasks: Retire affiliates and affiliate shift operators

**Input**: Design documents from `specs/001-retire-affiliates/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/api-changes.md

**Tests**: required by constitution VI — the retirement is proven in the API (D13); app tests lose
the cases for removed behaviour.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependencies)
- **[Story]**: which user story the task serves

---

## Phase 1: Foundational (blocks every story)

- [x] T001 Stop mapping the retired tables and columns and note them in `api-turistear/src/db/schema.ts` (D2)
- [x] T002 Narrow `UserRole` to `admin | agent`, drop `affiliateCompanyId` and `OperatorPayload` in `api-turistear/src/types/context.ts`
- [x] T003 Delete `api-turistear/src/routes/affiliates/`, `api-turistear/src/routes/operators/`, `api-turistear/src/utils/{operatorSession,phone,pin}.ts`; unmount them and simplify `/api/me` in `api-turistear/src/index.tsx` (D11, D12)

**Checkpoint**: the API compiles only once every consumer below is fixed.

---

## Phase 2: User Story 1 — the product has two roles again (P1)

**Goal**: no affiliate surface; selling resolves identically for every caller.

**Independent Test**: retired addresses answer 404; an agent sells with service commissions.

- [x] T004 [US1] Remove the curated catalog, the allow-list guard and the per-affiliate rates from `api-turistear/src/routes/pos/handler.ts`, `api-turistear/src/routes/pos/lodging.handler.ts`; narrow `requireRole` in `api-turistear/src/routes/pos/index.ts` (FR-005)
- [x] T005 [P] [US1] Resolve only agent invitations; drop `position`, `invitation_type`, `company_name` in `api-turistear/src/routes/auth/{handler,schema}.ts` (FR-004)
- [x] T006 [P] [US1] Remove `sendAffiliateInvitationEmail` from `api-turistear/src/services/resend.ts`
- [x] T007 [P] [US1] Narrow the cash routes' roles in `api-turistear/src/routes/cash/index.ts`
- [x] T008 [P] [US1] Delete `app-turistear/src/features/affiliates/`, `app-turistear/src/services/affiliatesService.ts`, `app-turistear/src/pages/Affiliate{sList,New,Detail}Page.tsx`; drop their routes from `app-turistear/src/App.tsx` and `app-turistear/src/config/routes.ts`
- [x] T009 [US1] Drop `affiliate` from `RoleGuard`, `AppLayout` and `AccountMenu` (`app-turistear/src/features/auth/components/RoleGuard.tsx`, `app-turistear/src/layout/{AppLayout,AccountMenu}.tsx`)
- [x] T010 [P] [US1] Remove the affiliate branch of the invitation flow: `app-turistear/src/pages/InviteAcceptPage.tsx`, `app-turistear/src/features/auth/components/InviteCompleteForm.tsx`, `app-turistear/src/features/auth/{schemas,types}.ts`, `app-turistear/src/services/authService.ts` and their tests
- [x] T011 [P] [US1] Delete `api-turistear/test/affiliates/`; drop the affiliate cases of `api-turistear/test/pos/stay-discount.test.ts` and `api-turistear/test/cash/bounded-drop-reads.test.ts`

---

## Phase 3: User Story 2 — a leftover account or shift link opens nothing (P1)

**Goal**: the legacy role is refused; the shift session is gone.

**Independent Test**: legacy user → `403 ACCOUNT_SUSPENDED`; `gm_op` alone → `401`.

- [x] T012 [US2] Refuse a role outside `admin`/`agent` and stop reading `gm_op` in `api-turistear/src/middleware/auth.ts` (D3, D4)
- [x] T013 [P] [US2] Remove the operator-session cookie helpers and their clearing from `api-turistear/src/utils/cookies.ts` (D4)
- [x] T014 [P] [US2] Delete `app-turistear/src/features/operators/`, `app-turistear/src/services/operatorsService.ts`, `app-turistear/src/pages/Operator{s,Access}Page.tsx` and their routes; drop the operator from `getMe` and the session user
- [x] T015 [P] [US2] Delete `api-turistear/test/operators/`; drop the `gm_op` assertion from `api-turistear/test/auth/admin-login-session.test.ts`

---

## Phase 4: User Story 3 — the money already recorded is never lost (P2)

**Goal**: legacy cash and sales stay readable and settleable.

**Independent Test**: legacy seller in the roster, the report and the CSV; collection accepted;
service with a legacy commission row deletes.

- [x] T016 [US3] Target every non-admin user in the roster, payouts and collections; drop `role`/`affiliate_company` from balance rows in `api-turistear/src/routes/cash/handler.ts` (D5)
- [x] T017 [P] [US3] Drop the affiliate company filter and column; keep the stored role and fall back to it in the CSV label in `api-turistear/src/routes/reports/{handler,schema}.ts` (D6)
- [x] T018 [P] [US3] Keep deleting legacy `affiliate_commissions` rows on service hard-delete, through a local mapping, in `api-turistear/src/routes/services/handler.ts` (D7)
- [x] T019 [P] [US3] Remove `affiliate_commission_pct` and `sellerKind` from `api-turistear/src/utils/cancellationPolicy.ts` and its caller in `api-turistear/src/routes/folios/handler.ts` (D8)
- [x] T020 [P] [US3] App mirror: `app-turistear/src/features/cash/` (types, BalanceScreen, CashBoxCard), `app-turistear/src/pages/CashBalancesPage.tsx`, `app-turistear/src/features/reports/types.ts`, `app-turistear/src/services/reportsService.ts`, `app-turistear/src/pages/ReportsPage.tsx`, `app-turistear/src/test/handlers/cash.ts` and their tests
- [x] T021 [P] [US3] App: drop the affiliate share from `app-turistear/src/features/organization/{types.ts,components/CancellationPolicyCard.tsx}`; fix the copy in `app-turistear/src/features/catalog/components/ConfirmDeleteServiceSheet.tsx`
- [x] T022 [US3] Tests: rewrite the affiliate cases of `api-turistear/test/reports/commission-report.test.ts`, `api-turistear/test/catalog/service-hard-delete.test.ts`, `api-turistear/test/cancellation/cancellation-policy-engine.test.ts`, `api-turistear/test/organizations/organization-policy.test.ts`

---

## Phase 5: User Story 4 — sale surfaces stop speaking of operators (P3)

**Goal**: no `operator_name` anywhere; one search on both sides.

**Independent Test**: list, detail, timeline, receipt, dashboard and search show no operator.

- [x] T023 [US4] Drop the operator join and `operator_name` from `api-turistear/src/utils/{folioDetail,folioEvents,folioListRows,folioPayments,folioSearch}.ts`, `api-turistear/src/routes/folios/handler.ts`, `api-turistear/src/routes/pos/handler.ts` (sale response, list, `?operator=`, every `operatorId` write) and `api-turistear/src/routes/dashboard/handler.ts` (D9, D10)
- [x] T024 [P] [US4] App mirror: `app-turistear/src/features/folios/` (types, folioSearch, FolioListScreen, FolioCard, FolioDetailScreen, FolioTimeline), `app-turistear/src/features/pos/{types.ts,components/PaymentBreakdown.tsx}`, `app-turistear/src/pages/FolioReceiptPage.tsx`, `app-turistear/src/services/dashboardService.ts`, `app-turistear/src/features/dashboard/components/DaySalesCard.tsx` and their tests
- [x] T025 [P] [US4] Tests: drop `operator_name`/the operator join from `api-turistear/test/folios/{correlation-indexes,folio-list-scanability,folio-timeline}.test.ts` and `api-turistear/test/paid-ledger/dual-write.test.ts`

---

## Phase 6: Proof and polish

- [x] T026 Write `api-turistear/test/retire-affiliates/retire-affiliates.test.ts` (D13; cites `retire-affiliates US1`–`US3`)
- [x] T027 [P] Remove the affiliate seeders and rename `clearAffiliateDb` → `clearFullDb` in `api-turistear/test/helpers/tenancy.ts` and its callers
- [x] T028 [P] Fix comments that cite the retired features (`WizardShell`, `StatusChip`, `ListRow`, `ListPageHeader`, `InviteAgentForm`, `bookingsService`) (D12)
- [x] T029 Amend the constitution through `/speckit-constitution`; update `CLAUDE.md`
- [x] T030 Register debt `affiliate-tables` through `/speckit-debt-log` (D1, D7)
- [x] T031 Run `quickstart.md`: lint, both suites, both builds, SC-001 grep, unedited-suite check, no migration

## Dependencies

- Phase 1 before everything; the API compiles once T004–T025's API tasks land.
- Each app task depends only on the API contract (contracts/api-changes.md), not on API code.
- T026 after T012, T016–T018; T031 last.
