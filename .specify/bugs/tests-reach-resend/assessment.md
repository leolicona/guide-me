# Bug Assessment: API tests without a Resend stub call the real Resend

- **Slug**: tests-reach-resend
- **Created**: 2026-11-03
- **Source**: pasted text — `specs/006-devolada-transfer-verification/research.md:634`, § Defects found on the way, defect 10 (T077)
- **Verdict**: valid
- **Severity**: low

## Report (verbatim or summarized)

> 10. Unstubbed outbound calls in API tests reach the real provider (Resend), with the test key `vitest.config.ts` pins, so nothing is delivered. For example, `test:pos/payment-verification.test.ts` does not call `stubResend`.

## Symptom

A test that sells, verifies or cancels triggers an email send; unless the suite calls `stubResend`, the request goes to `https://api.resend.com/emails` with the pinned key `test_resend_key`, and Resend answers 401. Nothing is delivered, but each run makes real network calls, depends on the network for timing, and records `failed` email outcomes that no test asserts. Expected: no API test reaches a real provider; an unexpected outbound call fails the test.

## Reproduction

1. Run `pnpm --filter api-turistear exec vitest run test/pos/payment-verification.test.ts` with outbound network allowed.
2. Observed: requests to `api.resend.com` (visible with a fetch spy, or as `failed` rows in `notifications` for the email channel).
3. On `main` 6bd538e, 13 of 93 API test files call `stubResend`.

## Suspected Code Paths

- `api-turistear/vitest.config.ts:23` — pins `RESEND_API_KEY: 'test_resend_key'`.
- `api-turistear/test/helpers/auth-flows.ts:54-70` (`stubResend`) — opt-in, per suite; falls through to the real `fetch` for every other URL.
- `api-turistear/src/services/resend.ts:32, 76, 120` — the real `fetch` calls.

## Root Cause Hypothesis

Stubbing is opt-in, and no global guard refuses outbound requests in tests. The Devolada feature avoided the problem for its own provider with a fake (`api-turistear/test/helpers/devolada.ts`) but did not add a global guard. Confidence: high.

## Proposed Remediation

**Preferred**: A global `setupFiles` entry that wraps `fetch`: Resend's origin answers a recorded 200 by default (suites that assert emails keep `stubResend`), and any other non-local origin throws, so a new provider cannot be reached by accident.

**Alternatives**:
- Make `services/resend.ts` read its origin from a binding (today it is hard-coded) and point it at an unroutable host in `vitest.config.ts`. Smaller, but leaves other providers open and makes sends fail rather than succeed.

**Files likely to change**:
- `api-turistear/vitest.config.ts`, a new `api-turistear/test/setup/outbound.ts`
- `api-turistear/test/helpers/auth-flows.ts`

**Tests to add or update**:
- A guard test: an unexpected `fetch('https://example.com')` inside a test throws.

## Risks & Considerations

- Suites that currently pass because a send fails (and its failure is ignored) may change behaviour once sends succeed; run the full suite.
- `test/pos/payment-verification.test.ts` is a scope-boundary file for the Devolada feature; a global setup changes nothing in it.

## Open Questions

- None.
