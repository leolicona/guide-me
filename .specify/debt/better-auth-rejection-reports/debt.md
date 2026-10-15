---
slug: better-auth-rejection-reports
status: open
kind: deliberate
severity: low
effort: days
opened: 2026-10-15
---

# Technical Debt: the API suite ignores Better Auth's duplicate unhandled-rejection reports

## What was traded

Inside workerd, an `APIError` that a Better Auth endpoint handler throws (a wrong code, an expired
challenge, a registration that does not verify) is answered correctly AND reported once more as an
unhandled rejection by Better Auth's dispatch pipeline. Vitest then fails the run although every
HTTP answer is right and asserted. Rather than block specs/004-passkey-auth on a root cause inside
Better Auth 1.7.7's dispatch and AsyncLocalStorage interplay in workerd, which was not found, the
suite ignores those reports (research.md R15, 2026-10-15).

## Where it lives

- `api-turistear/vitest.config.ts::onUnhandledError` — `if (error.name === 'APIError' &&
  typeof body?.code === 'string') return false`: drops every unhandled-rejection report whose error
  is a Better Auth `APIError` carrying its `{ code, message }` body.

## Interest

- A Better Auth `APIError` that is genuinely unhandled (for example one thrown from our own
  `databaseHooks` or `hooks.after` in `src/auth/index.ts` outside a request) no longer fails the
  API suite; only a wrong HTTP answer in an asserting test would catch it.
- In deployed Workers the same duplicate report presumably surfaces as an "Uncaught (in promise)
  APIError" log line on every refused sign-in. [NEEDS CLARIFICATION: not observed on dev yet —
  check the Worker logs after cutover.]

## Paying it

Find the root cause, or a Better Auth / workerd / `@cloudflare/vitest-pool-workers` version that no
longer reports a handled refusal; then delete the `onUnhandledError` callback (and its comment) from
`api-turistear/vitest.config.ts`. Confirm with `pnpm test:api`: it passes, and its output contains
no "Unhandled Rejection" — `test/auth/email-code.test.ts` (wrong, expired and exhausted codes) and
`test/auth/passkeys.test.ts` (a registration from another origin) raise exactly these refusals.

The reproduction from the investigation: a minimal `betterAuth({ database: drizzleAdapter(...),
plugins: [emailOTP({ disableSignUp: true, ... })] })` and one
`auth.api.signInEmailOTP({ body: { email, otp: '000000' }, asResponse: true })` inside a test is
enough; a bare `AsyncLocalStorage.run` rejecting after D1 I/O is not.

**Trigger**: any upgrade of `better-auth`, `@better-auth/*` or `@cloudflare/vitest-pool-workers`
(re-run without the filter first), or a test that needs to assert an unhandled rejection.

## Notes

- specs/004-passkey-auth research.md R15; the filter landed in commit 1517e85 and was widened from
  4xx to any coded `APIError` in 0de484b (a failed registration is Better Auth's own 500).
