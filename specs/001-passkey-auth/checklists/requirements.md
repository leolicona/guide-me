# Specification Quality Checklist: Passkey Sign-In with Email Code Backup

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-10-06
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

- Iteration 1 (2026-10-06): 2 [NEEDS CLARIFICATION] markers were open. One asked whether shift operators move to llaves de acceso. The other (FR-007) asked whether creating a llave de acceso is optional or mandatory.
- Iteration 2 (2026-10-06): both were answered (spec § Clarifications), and all items pass.
  - Creating a llave de acceso is **mandatory for every role**, and the server enforces it: FR-007–FR-009, `PASSKEY_ENROLLMENT_REQUIRED` and `PASSKEY_LAST_ONE`.
  - Shift operators are **out of scope**. Story 7 and the old FR-050/FR-051 were withdrawn. FR-050 now guards that the operator flow stays unchanged, and FR-062 and SC-003 were narrowed: Agnostic Auth leaves every staff path but stays bound for operator PINs.
- Some references to the code base and the constitution are deliberate, not leaked implementation. The constitution requires them:
  - The scope boundary names test suites and the shared session helper, because Principle I requires a mechanical test.
  - The error codes are declared in FR-070, because Principle IV says they must exist in the spec before they exist in code.
  - HttpOnly cookies on `.turistearya.com` are restated because they are law under Principle IV.

  No framework, library or storage design is chosen. Those decisions belong to `/speckit-plan`.
- "WebAuthn", "FIDO2" and "passkey" appear because the user's own request names them. The UI term is fixed as "llave de acceso".
- Items marked incomplete require spec updates before `/speckit-clarify` or `/speckit-plan`.
