# Research: Passkey Sign-In with Email Code Backup

**Dates**: 2026-10-06; revised 2026-10-07 for Better Auth's standards · **Plan**: [plan.md](./plan.md)

## Sources

The docs site (better-auth.com) was not reachable from the session that did this research. It read
the same pages from the repository at tag `v1.7.7` (`docs/content/docs/*.mdx`). The behaviour below
was then confirmed in the **published npm tarballs**, which are what will run:
- `better-auth@1.7.7`, `@better-auth/core@1.7.7`, `@better-auth/passkey@1.7.7` and
  `@better-auth/drizzle-adapter@1.7.7`;
- `better-call@1.4.0`, `@simplewebauthn/server@13.3.1` and `@better-auth/telemetry@1.7.7`.

Paths like `dist/…` refer to those tarballs.

## R1 — Version and packaging (D1)

- **Decision**: pin the server and client packages at 1.7.7.
- **Rationale**:
  - 1.7.7 is npm `latest`, published 2026-09-30.
  - The passkey plugin is a separate package. Its peers are pinned exactly: `better-call 1.4.0` and
    `@better-auth/utils 0.4.2`.
  - `better-auth` requires `zod ^4.5.4`, which the workspace's `^4` resolves to.
  - Telemetry is off unless `BETTER_AUTH_TELEMETRY` is set or `telemetry.enabled` is true
    (`telemetry/dist/index.mjs:360`).
- **Alternatives**: the 1.6.x line, rejected because 1.7.x is current.

## R2 — Mount the handler (D2)

- **Decision**: Better Auth's handler owns `/api/auth/*`, and the app uses Better Auth's client.
  Our own code moves to `/api/onboarding/*`.
- **Rationale**: the developer chose Better Auth's standards (2026-10-07).
  - With email-and-password disabled, the core surface is:
    - `/get-session`, `/sign-out`, `/update-user`, `/list-sessions`, `/revoke-session(s)` and
      `/revoke-other-sessions`;
    - the routes of the two plugins.
  - `changeEmail` and `deleteUser` are off by default.
  - `/update-user` accepts only fields that are not `input: false`, so the tenant fields are safe.
- **Alternatives**: calling `auth.api.*` from our own routes. This was the 2026-10-06 decision: it
  keeps Principle IV untouched, but re-specifies a contract Better Auth already has. The developer
  rejected it.

## R3 — Runtime flag and instance lifetime (D3)

- **Decision**: the `nodejs_als` compatibility flag, and one instance per `env` object.
- **Rationale**: these are the `node:` imports across the runtime packages.

  | Import | Where |
  |---|---|
  | `node:async_hooks` | `@better-auth/core/dist/async_hooks/index.mjs` (the only runtime one) |
  | `node:crypto`, `node:http`, `node:sqlite` | `better-auth/dist/test-utils/` |
  | `node:fs`, `node:path` | the Drizzle schema generator |
  | `node:fs/promises`, `node:os` | the Node entry of `@better-auth/telemetry` |

  Without async hooks, core logs a warning pointing to the Workers compatibility flags, and
  rethrows.
- **Alternatives**: full `nodejs_compat`, which nothing needs.

## R4 — Sessions (D5)

- **Decision**: Better Auth's defaults: 7 days, renewed daily, no cookie cache. The prefix and the
  secret differ per environment.
- **Rationale**:
  - The token is a random 32-character id, carried in the cookie as
    `encodeURIComponent(token + '.' + base64(HMAC-SHA256(secret, token)))`
    (`better-call/dist/crypto.mjs:21–31`).
  - Renewal extends `expiresAt` only and never rotates the token, so parallel requests cannot race
    (BUG-014).
  - The cookie cache is off by default. Leaving it off is what makes a revocation take effect at the
    next request.
- **Cost**: one session lookup per request, which joins the user, in place of today's user lookup.

## R5 — Refusing a suspended account (D6)

- **Decision**: `databaseHooks.session.create.before` throws for a suspended user, and the
  business middleware refuses one at every request.
- **Rationale**:
  - Both sign-in paths go through `internalAdapter.createSession`, so the hook covers both.
  - Throwing is required: on `false`, `createSession` returns null, and `signInEmailOTP` does not
    check for null before setting the cookie (`email-otp/routes.mjs:440–460`).
  - The passkey route rethrows an `APIError` unchanged (`passkey/dist/index.mjs:513`).

## R6 — Email codes (D7)

- **Decision**: the plugin's defaults, plus `disableSignUp: true` and `storeOTP: 'encrypted'`, with
  sends in the background through `waitUntil`.
- **Rationale**:
  - **Defaults**: 6 digits, 300 s and 3 attempts. On a wrong code the row is re-created with
    `attempts + 1`. At 3 used attempts the next try answers `TOO_MANY_ATTEMPTS`
    (`routes.mjs:761–781`).
  - **Newest code wins**: redeeming takes the newest row by `createdAt` and deletes every row for the
    identifier (`internal-adapter.mjs:815–845`).
  - **Constant time**: codes are compared with `constantTimeEqual` (`otp-token.mjs:17–24`).
  - **Storage**: `'encrypted'` uses `symmetricEncrypt` keyed by the environment secret, so the
    table alone cannot be read back (FR-016). `'hashed'` is an unsalted SHA-256 (`utils.mjs`), which
    reverses over 10⁶ codes, so it is rejected.
  - **Unknown email**: with `disableSignUp`, it gets `{ success: true }` and no send
    (`routes.mjs:101–107`, FR-013).
  - **Background sends**: they go through `runInBackgroundOrAwait`, so a known and an unknown
    email answer in the same time.
  - **`waitUntil`**: it is importable from `cloudflare:workers`; the project's generated types
    declare it (`api-turistear/worker-configuration.d.ts:13000`).
- **Consequence**: a failed send cannot be reported to the user. The spec's Edge Cases say so.
- **Alternatives**:
  - Awaiting the send. Rejected: it creates a timing difference that reveals whether an account
    exists.
  - A magic link. Rejected: the spec chose a code, and links get prefetched by mail scanners
    (BUG-010).

## R7 — Fresh session to add a passkey (D8)

- **Decision**: Better Auth's default. Adding a passkey needs a session created within `freshAge`
  (1 day). Deleting one needs only a session.
- **Rationale**: registration uses `freshSessionMiddleware` when `requireSession` is true
  (`passkey/dist/index.mjs:88`). Delete and update do not (`index.mjs:581–660`).
- **Alternatives**: the 15-minute custom step-up of the 2026-10-06 plan, withdrawn under the
  standard.

## R8 — Rate limiting (D9)

- **Decision**: Better Auth's limiter, `enabled: true` and `storage: 'database'`.
- **Rationale**:
  - **Built-in rules** (`api/rate-limiter/index.mjs:308–314`): `/sign-in*` at 3 per 10 s; the
    email-code send at 3 per 60 s; everything else at 100 per 60 s.
  - **Key**: the client IP (`cf-connecting-ip`).
  - **Refusal**: `429` with `X-Retry-After` (`index.mjs:64–72`).
  - **Storage**: memory storage counts per isolate on Workers. Database storage shares one count,
    although a burst of concurrent requests can overshoot the limit by a few, because it reads and
    then writes.
- **Accepted**: the limits are per address, not per email (spec Assumptions).
- **Alternatives**: our own per-email guarded counters (the 2026-10-06 plan), withdrawn under the
  standard.

## R9 — Passkeys (D8)

- **Decision**: a per-environment `rpID`, an explicit `origin`, and `residentKey` and
  `userVerification` set to `required`.
- **Rationale**:
  - **`origin`** falls back to the request's `Origin` header when unset (`index.mjs:337, 453`), so
    it is always set.
  - **User verification** is requested of the device, but the plugin verifies with
    `requireUserVerification: false`. Phone passkeys always verify, and the spec accepts this as
    standard.
  - **Use count**: a backwards count fails inside SimpleWebAuthn and answers
    `AUTHENTICATION_FAILED`.
- **Alternatives**: `rpID: "turistearya.com"` shared by both environments. Rejected because phones
  would offer dev passkeys on prod.

## R10 — Invitations (D11)

- **Decision**: accepting an invitation creates the agent and sends a sign-in code. The passkey is
  offered after that sign-in.
- **Rationale**: it is the standard path, with no resolver of ours.
- **Alternatives**: sessionless registration, with `registration.requireSession: false` and
  `resolveUser({ context })`.
  - The client supports `addPasskey({ context, createSession: true })` (`client.mjs:75, 99`).
  - It would let the invitee create a passkey straight from the link.
  - It was rejected because it needs a resolver and a signed context of ours, and because
    `requireSession: false` would drop the fresh-session check for every later passkey added
    (`index.mjs:23–50`).

## R11 — Email case (D16)

- **Decision**: lowercase `users.email` and `invitations.identity` in migration 0071, and lowercase
  every email at our edge.
- **Rationale**: Better Auth lowercases before every lookup (`routes.mjs:95, 409`), while today's
  rows store the address as typed.
- **Pre-flight**: the gate (D19) counts case collisions in both databases.

## R12 — Sessions in the business suites (D17)

- **Decision**: a test-only `AFTER INSERT ON users` trigger, installed after migrations, writes a
  session whose token is `'test-session-' || NEW.email`. `sessionCookie(email)` signs it
  synchronously with `@noble/hashes` in Better Auth's cookie format (R4).
- **Rationale**:
  - The business suites call `auth(email)` inline in headers, so a synchronous helper keeps each
    file's change to two lines.
  - Better Auth reads a real row and verifies a real signature.
  - With `ON DELETE CASCADE`, the cleanup helpers need no change.
  - Assertions about sessions in `test/auth/` exclude tokens matching `test-session-%`.
- **Alternatives**: an asynchronous helper (every call site changes), or a test bypass (a back door).

## R13 — Ceremonies in tests and end to end (D17)

- **Decision**:
  - API tests use a WebCrypto P-256 software authenticator that builds `none` attestations and ES256
    assertions.
  - End to end, Playwright uses CDP's virtual authenticator, with each test account's credential
    held as a GitHub secret.
- **Rationale**: SimpleWebAuthn verifies with WebCrypto, which workerd provides. App tests mock
  `navigator.credentials` at the platform boundary and serve Better Auth's endpoints from MSW.

## Withdrawn

These were withdrawn on 2026-10-07, when the developer chose Better Auth's standards:
- the wrapped routes and our error codes;
- the mandatory passkey and its enrollment gate;
- the last-passkey guard and the 10-key limit;
- `last_used_at`;
- the 15-minute step-up;
- per-email limits;
- `OTP_DELIVERY_FAILED`;
- the admin access restore (constitution III).

The spec's Clarifications record each one.

## Withdrawn scenarios from the archive (constitution I)

| Today's suite | Scenarios withdrawn | Replaced by |
|---|---|---|
| `test/auth/admin-login-session.test.ts` | 1–9 (password login, JWT access and refresh) | US1, US2 and the session tests |
| `test/auth/admin-login-session.test.ts` | 10–12 | Restated on the new session |
| `test/auth/admin-registration.test.ts` | 1–7 | US3 |
| `test/auth/agent-invitation.test.ts` | 1–8 | Kept: the invite is unchanged; acceptance moves to `/api/onboarding` |
| `test/auth/agent-invitation.test.ts` | 9–11 | US4 |
| `test/auth/password-recovery.test.ts` | 1–8 | US1 |
