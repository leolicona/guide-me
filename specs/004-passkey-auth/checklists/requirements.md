# Specification Quality Checklist: Passkey Sign-In with Email Code Backup

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-10-06
**Feature**: [spec.md](../spec.md) · **Folder**: `specs/004-passkey-auth/` (renumbered from 003 on 2026-10-07, because `develop` holds `003-delete-legacy-affiliates`)

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

- Iteration 1 (2026-10-06): 2 [NEEDS CLARIFICATION] markers were open. One asked whether shift operators move to llaves de acceso. The other (FR-007) asked whether creating a llave de acceso is optional or mandatory.
- Iteration 2 (2026-10-06): both were answered (spec § Clarifications), and all items pass.
  - Creating a llave de acceso is **mandatory for every role**, and the server enforces it: FR-007–FR-009, `PASSKEY_ENROLLMENT_REQUIRED` and `PASSKEY_LAST_ONE`.
  - Shift operators are **out of scope**. Story 7 and the old FR-050/FR-051 were withdrawn. FR-050 now guards that the operator flow stays unchanged, and FR-062 and SC-003 were narrowed: Agnostic Auth leaves every staff path but stays bound for operator PINs.
- Iteration 3 (2026-10-06): the scope was narrowed to the existing roles. Affiliates and their shift operators were retired on `develop` (`specs/001-retire-affiliates`, #154), so:
  - The spec covers `admin` and `agent` only. The affiliate story details are gone, and the retired-role refusal (`retire-affiliates D3`) holds on every new sign-in path.
  - The operator clarification is superseded, and FR-050 is withdrawn.
  - FR-062 and SC-003 are back to the full retirement of Agnostic Auth, and no follow-up debt is needed for it.
  - The spec was renumbered `001-passkey-auth` → `003-passkey-auth`, because `develop` already holds 001 and 002.

  All items still pass.
- Iteration 4 (2026-10-06): the developer chose **Better Auth** to implement authentication.
  - The choice is recorded in Clarifications and in the "Built on Better Auth" assumption. Every FR and SC stays technology-agnostic and unchanged. Naming the library is a constraint the developer set, not leaked implementation.
  - The fit-gap was read against Better Auth v1.7.7, its latest stable release (2026-09-30).
  - Two constitution decisions go to the plan: Principle IV's route structure and error envelope, and the stack row with the `nodejs_compat` flag.

  All items still pass.
- Iteration 5 (2026-10-07): `/speckit-analyze` found the spec number (003), the migration number (0070) and the retired-role guard stale against `develop`, which had merged #158 and #159. The developer then chose **Better Auth's standards**, and the spec was rewritten accordingly:
  - The llave de acceso is **optional**: offered after an email-code sign-in, and never forced. This supersedes iterations 2–4.
  - Better Auth's defaults apply: codes last 5 minutes with 3 attempts, sessions last 7 days, and its fresh-session rule and rate limiter are used.
  - `/api/auth/*` is served by Better Auth's handler, with its format and codes; constitution IV is amended in the PR.
  - The admin "restore access" story (US6) is out of scope (constitution III).
  - The retired-role refusal is gone (`delete-legacy-affiliates` D5, D8).
  - The folder is now `specs/004-passkey-auth`, and the migration is `0071`.

  All items pass. The library is still named only in Clarifications, Assumptions and FR-070, which states its route ownership and codes as a contract.
- Iteration 6 (2026-10-07): applied the remediation from `/speckit-analyze`.
  - C1: the constitution was amended to v1.2.0 (`f8ff722`) before implementation; the plan, spec and T043 record it.
  - C2: Story 1 gained scenario 9 (old links), which T038's test now cites.
  - M1: the API tests pin the response shapes that MSW copies.
  - M2: the exempt reads are named in the plan's row III.
  - M3: passkey rename and delete are tested across organizations with `seedTwoOrgs`.
  - M4: the sign-in attempt limit is tested.

  All items pass.
- Iteration 7 (2026-10-07): second `/speckit-analyze` pass, then fixes.
  - I1: FR-070 declares `ACCOUNT_SUSPENDED` on `/api/auth/*`.
  - L2: the deleted-account case is added to T015.
  - L3: the invitee-without-code edge case is added.
  - L4: T027 and T030 exclude fixture sessions.
  - L5: FR-024 and FR-025 are de-duplicated.
  - L6: the Phase 2 note is widened.

  Zero CRITICAL or HIGH findings remain.
- Some references to the code base and the constitution are deliberate, not leaked implementation. The constitution requires them:
  - The scope boundary names test suites and the shared session helper, because Principle I requires a mechanical test.
  - The error codes are declared in FR-070, because Principle IV says they must exist in the spec before they exist in code.
  - HttpOnly cookies on `.turistearya.com` are restated because they are law under Principle IV.

  No framework, library or storage design is chosen. Those decisions belong to `/speckit-plan`.
- "WebAuthn", "FIDO2" and "passkey" appear because the user's own request names them. The UI term is fixed as "llave de acceso".
- Items marked incomplete require spec updates before `/speckit-clarify` or `/speckit-plan`.
