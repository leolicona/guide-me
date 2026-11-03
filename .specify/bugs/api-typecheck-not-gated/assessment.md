# Bug Assessment: Nothing type-checks the API, and error codes in use are missing from ErrorCode

- **Slug**: api-typecheck-not-gated
- **Created**: 2026-11-03
- **Source**: pasted text — `specs/006-devolada-transfer-verification/research.md:633`, § Defects found on the way, defect 9 (T077)
- **Verdict**: valid
- **Severity**: medium

## Report (verbatim or summarized)

> 9. Nothing type-checks the API (no `tsc` in CI), and 20 error codes in use are missing from `ErrorCode` (27 on 2026-10-06; the retired affiliate and operator codes left with their routes). `src/types/errors.ts:1-36`.

## Symptom

No workflow and no package script runs `tsc` on `api-turistear`; the Vite build strips types without checking them. On `main` 6bd538e, `npx tsc --noEmit -p api-turistear` reports **540 errors, 288 of them under `src/`**. Among them, **15 error codes passed to `ApiError` are not members of `ErrorCode`**: `ALLOCATION_MISMATCH`, `DIFFERENT_SERVICE`, `EXPRESS_NOT_ELIGIBLE`, `EXPRESS_PAYLOAD_INVALID`, `NOTIFICATION_ALREADY_SENT`, `NOTIFICATION_NOT_DRAINABLE`, `NOTIFICATION_NOT_FOUND`, `NOT_A_BOOKING`, `NOT_PENDING_VERIFICATION`, `NOT_RESCHEDULABLE`, `NO_CAPACITY_AVAILABLE`, `NO_SHOW_MARGIN_TOO_EARLY`, `RELEASE_BEFORE_SALES_CUTOFF`, `UNKNOWN`, `VOID_WINDOW_CLOSED`. Expected: the API type-checks clean in CI, and every code the API answers is declared, so the app can map it to copy.

## Reproduction

1. `cd api-turistear && npx tsc --noEmit -p .`
2. Observed: 540 errors (288 under `src/`); `grep ErrorCode` lists the 15 codes above.
3. `grep -n tsc .github/workflows/*.yml api-turistear/package.json` → nothing.

## Suspected Code Paths

- `api-turistear/src/types/errors.ts:1-65` — the `ErrorCode` union.
- `.github/workflows/` — the `verify` job (lint, tests, builds; no API `tsc`).
- `api-turistear/package.json` — no `typecheck` script.

## Root Cause Hypothesis

The API was never gated on types, so errors accumulated; the Devolada feature kept its own code at zero new errors against a baseline of 288 but did not pay the baseline down. Confidence: high.

## Proposed Remediation

**Preferred**: In two steps. (1) Add the 15 missing codes to `ErrorCode` and fix the remaining `src/` errors, file by file; tests' errors (the other 252) may be excluded from the first gate with a `tsconfig` that covers `src/` only. (2) Add `pnpm --filter api-turistear exec tsc --noEmit` to the `verify` job once it is clean.

**Alternatives**:
- Gate on "no new errors" with a stored baseline count. Cheaper today, but the baseline never shrinks by itself.

**Files likely to change**:
- `api-turistear/src/types/errors.ts`, many files under `api-turistear/src/`
- `api-turistear/package.json`, `.github/workflows/<verify workflow>.yml`, possibly `api-turistear/tsconfig.src.json`

**Tests to add or update**:
- The CI gate itself; no new unit tests.

## Risks & Considerations

- A large mechanical diff; split by area so each PR stays reviewable.
- Some errors may hide real bugs (wrong column types, `string | undefined` ids); fix them as bugs, not with casts.

## Open Questions

- None.
