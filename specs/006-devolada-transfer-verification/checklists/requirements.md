# Specification Quality Checklist: Automatic Transfer Verification with Devolada

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-10-05
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Notes

- **Iteration 1** failed *All functional requirements have clear acceptance criteria*: FR-021
  (organization isolation) had no scenario, and constitution III requires one. Fixed in iteration 2
  by adding User Story 1, scenario 6 (two connected organizations, `seedTwoOrgs`).
- **Iteration 3 (2026-10-06)** — the three [NEEDS CLARIFICATION] markers were answered and recorded
  under `## Clarifications`: FR-008 (the link travels by WhatsApp; the customer confirms on
  Devolada's page; no CLABE or reference on Turistear's screens), FR-009 (the link replaces the
  seller's manual recording), FR-016 (an unpaid expiry or *expired* verdict cancels automatically;
  *invalid* stays with the admin). Applying FR-016 changed FR-015 and Story 2's scenarios and added
  SC-009. One default was added in the same pass: an unpaid **settlement** returns the sale to an
  apartado instead of cancelling it, because a sale holding cleared money is never cancelled
  automatically. All items pass; the spec is ready for `/speckit-plan`.
- **Accepted exceptions to "no implementation details"**: Context names three test files as the
  scope boundary, because constitution I requires the boundary as a mechanical test naming the
  suites that must pass unedited. FR-023 names the error codes, because constitution IV requires
  every code to be declared in the spec before it exists in code, as specs/004-passkey-auth did in
  its FR-070. The constitution supersedes the template's guidance. Nothing else in the spec names a
  technology.
- Devolada's own vocabulary (*confirmed*, *partial*, *invalid*, *expired*, *unapplied*,
  *superseded*, CLABE, CEP) is used deliberately: it is the provider's business language, which
  the admin will see, not an implementation choice. Its contract is kept verbatim in
  `contracts/devolada-collections-v1.openapi.yaml` (constitution VIII).
- **/speckit-analyze (2026-10-06)** amended the spec in place: FR-017 and US1 scenario 2 now read
  «Verificando pago» (constitution VII: the UI's existing word for the concept); the out-of-org
  notification edge case says *logged*; SC-002 measures tickets *released*, not *received*; SC-009
  holds while Devolada answers. All items still pass.
- **Re-baseline against `main` (2026-10-15)**: the folder moved from `specs/001-…` to
  `specs/006-…` (main took 001–005). The spec lost its affiliate and shift-operator sellers (both
  retired on `main`); no requirement changed. The plan's environment, delivery and auth facts were
  re-read: Better Auth sessions, the one-branch pipeline with previews, and secrets in GitHub
  environments (research § Re-baseline). All items still pass.
- **/speckit-analyze (2026-10-15)**, after the re-baseline, found 3 CRITICAL, 3 HIGH, 10 MEDIUM and
  10 LOW items. All were resolved in place. The developer decided two clarifications, recorded under
  `## Clarifications` (Session 2026-10-15): a sale Devolada is resolving stays out of Por verificar
  until the admin has something to do (FR-015 gained that sentence, and US1 scenario 2 now names
  the right labels), and a link's 24-hour lifetime is confirmed, with the stay rule stated in the
  Assumptions. All items still pass.
- **/speckit-analyze, second run (2026-10-15)**, after the PR merged into `main`, found no CRITICAL
  item, and 4 HIGH, 10 MEDIUM and 12 LOW items. All were resolved in place. The developer took the
  three recommended decisions, recorded under `## Clarifications` (Session 2026-10-15):
  - a link that would stay open less than 15 minutes is not created (FR-010, Assumptions);
  - a link is never closed under a payment being verified while the sale lives (FR-011, US4
    scenarios 4-5);
  - the UI's word for the link is «enlace» (FR-022).

  FR-007 now says *transfer* where it said *electronic payment*, and FR-023 declares the error
  codes. All items still pass.
- **/speckit-analyze, third run (2026-10-15)** found no CRITICAL item, and 2 HIGH, 2 MEDIUM and
  4 LOW items. All were resolved in place. The developer decided three more clarifications
  (Session 2026-10-15):
  - the admin may switch Devolada accounts at any time, because each link is followed with the key
    that created it (FR-004, research D21);
  - «Verificar» records a settlement by hand, also while Devolada is still verifying it (FR-018, US3
    scenario 5);
  - a disconnected organization's pending links still clear by notification (FR-004).

  US4's Independent Test now uses an apartado, because a pending transfer sale cannot be cancelled.
  All items still pass.
