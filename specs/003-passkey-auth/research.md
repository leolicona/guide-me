# Research: Passkey Sign-In with Email Code Recovery

**Date**: 2026-10-06 · **Plan**: [plan.md](./plan.md)

## Sources

The docs site (better-auth.com) was not reachable from the session that did this research. It read
the same pages from the repository at tag `v1.7.7` (`docs/content/docs/*.mdx`). The behaviour below
was then confirmed in the **published npm tarballs**, which are what will run:
- `better-auth@1.7.7`, `@better-auth/core@1.7.7`, `@better-auth/passkey@1.7.7` and
  `@better-auth/drizzle-adapter@1.7.7`
- `better-call@1.4.0`
- `@simplewebauthn/server@13.3.1`
- `@better-auth/telemetry@1.7.7`

Paths like `dist/…` refer to those tarballs.

## R1 — Version and packaging (D1)

- **Decision**: pin `better-auth`, `@better-auth/passkey` and `@better-auth/drizzle-adapter` at
  exactly 1.7.7, and add `@simplewebauthn/browser` ^13.3 to the app.
- **Rationale**:
  - 1.7.7 is npm `latest`, published 2026-09-30.
  - The passkey plugin is a separate package. It pins `better-call 1.4.0` and
    `@better-auth/utils 0.4.2` exactly, as peers, and Better Auth's FAQ warns about duplicate
    copies (the "dual module hazard").
  - `better-auth` requires `zod ^4.5.4`. The workspace's `^4.4.3` resolves to it, so the lockfile
    moves within the same major.
  - Telemetry is off unless `BETTER_AUTH_TELEMETRY` is set or `telemetry.enabled` is true
    (`telemetry/dist/index.mjs:360`). We set `enabled: false` anyway.
- **Alternatives**: the 1.6.x maintenance line, rejected because 1.7.x is current and the passkey
  plugin's sessionless registration only exists there (not used, but upgrades stay simpler).

## R2 — Mount the handler or call `auth.api` (D2)

- **Decision**: call `auth.api.*` from our own `routes/auth/` handlers, and never route
  `auth.handler`.
- **Rationale**:
  - Server-side calls take `{ body, headers, returnHeaders: true }` and throw `APIError`, which we
    map to the FR-070 codes.
  - Better Auth's native error body is `{ code, message }` at the top level, while constitution IV
    requires `{ error: { code, message } }`.
  - A mounted handler would also publish every core endpoint (`/sign-up/email`, `/update-user`,
    `/change-email`, `/list-sessions`) and the plugins' raw routes.
  - `createAuthEndpoint.serverOnly` (used by `createVerificationOTP` in
    `dist/plugins/email-otp/routes.mjs`) is the same mechanism our local plugin uses for
    `issueInvitationSession` (D12).
- **Consequence**: `auth.api` calls are not rate-limited by Better Auth (docs/concepts/rate-limit),
  hence R8.
- **Alternatives**: mounting `app.on(['GET','POST'], '/api/auth/*', c => auth.handler(c.req.raw))`
  with the Better Auth client in the app. It is less code, but it violates Principle IV twice and
  enlarges the public surface. It would need a constitution amendment the developer has not asked
  for.

## R3 — Runtime flag and instance lifetime (D3)

- **Decision**: add the `nodejs_als` compatibility flag, and memoize one instance per `env` object
  in a `WeakMap`.
- **Rationale**:
  - These are the `node:` imports in the five runtime packages:

    | Import | Where |
    |---|---|
    | `node:async_hooks` | `@better-auth/core/dist/async_hooks/index.mjs` (the only runtime one) |
    | `node:crypto`, `node:http`, `node:sqlite` | `better-auth/dist/test-utils/` |
    | `node:fs`, `node:path` | the Drizzle schema generator (a CLI) |
    | `node:fs/promises`, `node:os` | the Node entry of `@better-auth/telemetry` |

  - Without async hooks, core logs a warning pointing to the Workers compatibility flags, and
    rethrows.
  - The Hono example builds Better Auth per request. The `WeakMap` gives the same correctness with
    one build per isolate, and still builds per test, because each test's `env` is a distinct
    object.
- **Alternatives**:
  - Full `nodejs_compat`, rejected because nothing on the runtime path needs it.
  - A module-scope instance with `import { env } from 'cloudflare:workers'`, rejected because the
    rest of the API takes `c.env` per request (`getDb(c.env)`), and tests swap bindings per test.

## R4 — Sessions and cookies (D5)

- **Decision**: database sessions, 60-day `expiresIn`, 1-day `updateAge`, no `cookieCache`,
  `freshAge` 0, `useSecureCookies` true, a per-environment `cookiePrefix`, and
  `crossSubDomainCookies` on `COOKIE_DOMAIN`.
- **Rationale**:
  - The session token is a random 32-character id. The cookie is
    `encodeURIComponent(token + '.' + base64(HMAC-SHA256(secret, token)))`
    (`better-call/dist/crypto.mjs:21–31`). Renewal only extends `expiresAt`; the token never
    rotates, so parallel requests cannot race (BUG-014).
  - With `cookieCache`, a revoked session keeps working until the cache cookie expires, which FR-023
    and FR-025 forbid.
  - Dev and prod share `.turistearya.com`, so a common name lets one environment's cookie shadow
    the other's.
  - A host-only cookie locally is what CLAUDE.md's "200 and no session" warning was about.
- **Cost, measured against today**: today's middleware reads `users` by email on every request.
  Better Auth's `getSession` reads the session and its user, so it is one lookup per request, plus
  at most one renewal write per session per day.
- **Alternatives**: a 5-minute cookie cache, rejected because it saves reads at the price of
  revocation.

## R5 — Refusing a session at creation (D6)

- **Decision**: `databaseHooks.session.create.before` throws `APIError` for a suspended user or a
  retired role.
- **Rationale**:
  - Both sign-in paths create their session through `internalAdapter.createSession`, so the hook
    covers both.
  - Throwing is required: on `false`, `createSession` returns null, and `signInEmailOTP`
    (`dist/plugins/email-otp/routes.mjs:440–460`) does not check for null before setting the
    cookie.
  - The passkey route rethrows any `APIError` from inside its `try` unchanged
    (`passkey/dist/index.mjs:513`).
- **Alternatives**: checking after sign-in and revoking, rejected because a session row would exist,
  even briefly, for an account that must have none.

## R6 — Email codes (D7)

- **Decision**: our route issues the code with `auth.api.createVerificationOTP` and sends it
  through Resend, awaited. Verification is `auth.api.signInEmailOTP` with these options:

  | Option | Value |
  |---|---|
  | `otpLength` | 6 |
  | `expiresIn` | 600 |
  | `allowedAttempts` | 5 |
  | `disableSignUp` | true |
  | `storeOTP` | `{ hash }`: HMAC-SHA256 keyed by `BETTER_AUTH_SECRET` |

- **Rationale**:
  - **Newest code wins**: `consumeVerificationValue` takes the newest row for the identifier, by
    `createdAt` descending, and deletes every row for it (`dist/db/internal-adapter.mjs:815–845`).
    So a newer code invalidates the older one (FR-010).
  - **Attempts**: a wrong code re-creates the row with `attempts + 1`. At 5 used attempts the next
    try answers `TOO_MANY_ATTEMPTS` (`routes.mjs:761–781`, FR-011).
  - **Constant time**: codes are compared with `constantTimeEqual` (`otp-token.mjs:17–24`).
  - **Why not the built-in `hashed` mode**: it is an unsalted SHA-256 (`utils.mjs`
    `defaultKeyHasher`). Over 10⁶ possible codes it reverses as fast as it hashes, which fails
    FR-016. An HMAC keyed outside D1 does not reverse from the table alone.
  - **Disabled sign-up**: with `disableSignUp`, the plugin's own send answers `{ success: true }`
    for an unknown email and sends nothing (`routes.mjs:101–107`). Our route reproduces that
    exactly (FR-013).
  - **Why not the plugin's send**: it runs `sendVerificationOTP` through `runInBackgroundOrAwait`.
    With a background handler configured, a failed send could never be reported. We do not
    configure one for this path and await our own send.
- **Accepted risk**: a known email answers after Resend replies, while an unknown one answers
  immediately. That timing difference reveals existence to a patient caller. R8's per-IP and
  per-email limits bound how fast it can be probed. The alternative, sending in the background,
  makes the spec's "the code could not be sent" edge case impossible.
- **Alternatives**: a magic link, rejected because the spec chose a code (6 digits survive being
  read aloud from another device), and links are prefetched by mail scanners (BUG-010).

## R7 — Step-up (D8)

- **Decision**: `authenticated_at` is set once per session, and a sensitive change needs it within
  900 s. Otherwise the answer is `REAUTH_REQUIRED`, and the app re-runs sign-in.
- **Rationale**: Better Auth's `freshAge` counts from `createdAt` with a 1-day default. The plugin
  applies it only to registration (`freshSessionMiddleware`), and never to its delete or update
  routes (`passkey/dist/index.mjs:581–660`). A fresh sign-in creates a new session, which is fresh
  by definition. Revoking the replaced session of the same user avoids orphaned rows.
- **Alternatives**: a separate "confirm it's you" ceremony that updates the current session.
  Rejected as a second flow to build and test for the same proof.

## R8 — Rate limits (D9)

- **Decision**: our own D1 table, consumed by one guarded upsert per key.
- **Rationale**:
  - Better Auth keys its limiter by `ip|path`, and skips it for `auth.api` calls.
  - Its memory store counts per isolate on Workers.
  - Nothing in it limits per email.
  - One `INSERT … ON CONFLICT(key) DO UPDATE SET … WHERE count < :limit RETURNING count` decides
    atomically: the constitution V idiom, since D1 has no interactive transactions.
- **Alternatives**: Workers KV, rejected because it is eventually consistent, so two isolates could
  both pass. Better Auth's `"database"` storage, rejected because it is not applied to server-side
  calls.

## R9 — Passkeys (D10)

- **Decision**: per-environment `rpID`, an explicit `origin`, `residentKey` and `userVerification`
  set to `required`, user verification enforced in both `afterVerification` hooks, and our own
  guarded delete.
- **Rationale**:
  - **Origin**: `origin` falls back to the request's `Origin` header when unset
    (`passkey/dist/index.mjs:337, 453`).
  - **User verification**: both verifications pass `requireUserVerification: false` to
    SimpleWebAuthn, so FR-002 needs our hook. The hooks receive `verification.registrationInfo` and
    `verification.authenticationInfo`, which carry `userVerified`.
  - **Use count**: the counter check sits inside SimpleWebAuthn's `verifyAuthenticationResponse`. A
    count that did not increase, when either value is non-zero, throws. It becomes
    `AUTHENTICATION_FAILED`, indistinguishable from a bad signature. FR-070 is amended to file it
    under `PASSKEY_VERIFICATION_FAILED`.
  - **Delete**: the plugin's delete finds the row, then deletes it. Ours refuses the last passkey in
    the same statement (FR-008).
  - **Last used**: the plugin's table has no last-used column. We add `last_used_at` and set it from
    the credential id in the verified request.
- **Alternatives**:
  - `rpID: "turistearya.com"` shared by both environments. Rejected: phones would offer dev
    passkeys on prod's sign-in sheet, and FR-003 would rely only on the databases being different.
  - Parsing `authenticatorData` ourselves to report a cloned passkey separately. Rejected: it is
    code that duplicates the verifier for a distinction the user never acts on, since both answers
    say "use the email code".

## R10 — The invitation's session (D12)

- **Decision**: a server-only endpoint in a local plugin calls `internalAdapter.createSession(userId,
  undefined, { authMethod: 'invitation', … })`, then `setSessionCookie` (exported from
  `better-auth/cookies`).
- **Rationale**: `createSession` accepts an `override` of additional fields
  (`internal-adapter.mjs:247–278`). The cookie is set through the same function every built-in
  sign-in uses. The session-create hook (R5) still runs.
- **Alternatives**:
  - The plugin's sessionless registration with `createSession: true`. Rejected: it does not help a
    browser without WebAuthn, and it needs a signed `context` handed to the client.
  - Minting a code server-side and redeeming it. Rejected as a code we would issue only to throw
    away.

## R11 — Email case (D17)

- **Decision**: lowercase `users.email` and `invitations.identity` in migration 0070, and lowercase
  every email at the edge from then on.
- **Rationale**: `signInEmailOTP` and the send route lowercase the email before every lookup
  (`routes.mjs:95, 409`). Today's registration and invitation store the address as typed. A user stored
  as `Ana@…` would never receive a code.
- **Pre-flight**: [quickstart.md](./quickstart.md) counts case collisions in both databases before
  the deploy. A collision would fail the unique index inside the migration, which runs before any
  new code, so it fails safe.

## R12 — Sessions in the business suites (D18)

- **Decision**: a test-only `AFTER INSERT ON users` trigger, installed by the setup file after the
  migrations, writes a session for every seeded user. Its token is
  `'test-session-' || NEW.email`, and it expires far in the future. `sessionCookie(email)` signs
  that token synchronously with `@noble/hashes` (`hmac(sha256, secret, token)`) in Better Auth's
  cookie format (R4).
- **Rationale**:
  - The business suites call `auth(email)` inline in request headers, which is 65 files and many
    call sites each. A synchronous helper keeps each file's change to its import and its cookie
    line.
  - The trigger is a fixture, not a mock. Better Auth reads a real row and verifies a real
    signature, so a forged, altered or other-environment cookie fails exactly as in production.
  - With `ON DELETE CASCADE`, the existing cleanup helpers need no change.
- **Alternatives**:
  - An asynchronous helper, rejected because it touches every call site.
  - A header that bypasses auth in test mode, rejected because it is a back door in production code
    (constitution IV).

## R13 — Ceremonies in tests and end to end (D18)

- **Decision**:
  - API tests use a software authenticator, `test/helpers/authenticator.ts`, built on WebCrypto
    ECDSA P-256. It builds `none` attestations and ES256 assertions, with controllable user-verified
    flags and counters.
  - End to end, Playwright drives Chromium's CDP virtual authenticator. `WebAuthn.addCredential`
    loads, per test account, a credential whose private key is a GitHub secret. The matching public
    key is enrolled once in dev through the real flow.
- **Rationale**:
  - SimpleWebAuthn verifies with WebCrypto, which workerd provides.
  - A real authenticator signal is what proves FR-002 (user verification), FR-006 (the use count)
    and the 10-key limit.
  - The virtual authenticator keeps end to end on the real sign-in, with no code read from a
    mailbox.
- **App tests**: `@simplewebauthn/browser` is mocked at its module boundary, because jsdom has no
  WebAuthn. App tests prove the mirror and the screens, never verification (constitution VI).

## Withdrawn scenarios (constitution I)

These archived scenarios are replaced by `passkey-auth` stories. Their files are rewritten, not
edited.

| Today's suite | Scenarios withdrawn | Replaced by |
|---|---|---|
| `test/auth/admin-login-session.test.ts` | 1–5 (password login, `INVALID_CREDENTIALS`, `EMAIL_NOT_VERIFIED`), 6–9 (JWT access and refresh, BUG-014 refresh race) | Login is replaced by US1 and US2. The JWT cases are replaced by the session tests: renewal, parallel requests, forged cookie (SC-005) |
| `test/auth/admin-login-session.test.ts` | 10–12 (role guard, logout) | Kept as scenarios, restated on the new session |
| `test/auth/admin-registration.test.ts` | 1–7 (password registration, magic link, `verify`) | US3 |
| `test/auth/agent-invitation.test.ts` | 1–8 | Kept: the invite is unchanged |
| `test/auth/agent-invitation.test.ts` | 9–11 (password completion) | US4 |
| `test/auth/password-recovery.test.ts` | 1–8 | US1 (the email code is the recovery) |
