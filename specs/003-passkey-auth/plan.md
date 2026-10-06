# Implementation Plan: Passkey Sign-In with Email Code Recovery

**Branch**: `claude/webauth-passkeys-fido-auth-ylusuh` | **Date**: 2026-10-06 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/003-passkey-auth/spec.md`

## Summary

Replace passwords and Agnostic Auth with Better Auth 1.7.7, which runs inside the API Worker.
Admins and agents sign in with a passkey (WebAuthn/FIDO2); creating one is mandatory and enforced
by the server. A 6-digit email code is the recovery path. Better Auth stores and checks sessions,
codes and passkeys in D1, but it is never exposed directly: our own `routes/auth/` call it from the
server, keep the `{ error: { code, message } }` envelope, and add what Better Auth does not do:
- the enrollment gate
- per-email limits
- the 15-minute step-up
- the last-passkey guard
- the tenant-scoped access restore

Agnostic Auth leaves every environment. Password columns stop being read or written; they are
dropped by the deploy that follows cutover (D16).

Code cites these decisions as `passkey-auth D<n>`.

## Decisions

**D1 — Better Auth 1.7.7, pinned exactly.** The API takes `better-auth`, `@better-auth/passkey`
and `@better-auth/drizzle-adapter`, all at 1.7.7. The app takes `@simplewebauthn/browser` ^13.3,
the major the passkey plugin is built on. Telemetry is set off explicitly.
*Why*: the plugin pins its peers exactly (`better-call 1.4.0`, `@better-auth/utils 0.4.2`), and a
second copy breaks it. Telemetry already defaults to off in 1.7.7 (`BETTER_AUTH_TELEMETRY` unset).
Saying so in code keeps a future default from turning it on. ([research](./research.md) R1)

**D2 — Better Auth is called, never mounted.** `routes/auth/` holds our router, handlers and Zod
schemas, as constitution IV requires.
- Each handler calls `auth.api.*` with the request headers and `returnHeaders: true`, then
  forwards Better Auth's `Set-Cookie` headers.
- An `APIError` is mapped to an `ApiError` with an FR-070 code.
- `auth.handler` is not routed anywhere.

*Why*: Principle IV stays whole: `zValidator`, our envelope, codes declared in the spec. The public
surface is exactly [the contract](./contracts/api.md). Mounting the handler would also publish
`/sign-up/email`, `/update-user`, `/change-email` and the plugins' raw endpoints, none of which
the product offers. The cost is that Better Auth's rate limiter never sees server-side calls, so
the limits are ours (D9). (R2)

**D3 — One auth instance per isolate, built from the request's bindings.** `src/auth/index.ts`
exports `getAuth(env)`. It memoizes the instance in a `WeakMap` keyed by the `env` object and
builds it with `drizzleAdapter(getDb(env), { provider: 'sqlite', transaction: false })`. The
Worker gains the compatibility flag `nodejs_als`, not the full `nodejs_compat`.
*Why*:
- Workers hand out bindings per request. The `WeakMap` rebuilds nothing on a warm isolate and
  still builds a fresh instance for each test's `env`.
- D1 has no interactive transactions (constitution V), so the adapter must not open one.
- The only Node import on 1.7.7's runtime path is `node:async_hooks`, measured in the published
  tarballs. The other `node:` imports live in its test utilities, its schema generator and the
  Node entry of its telemetry. (R3)

**D4 — Better Auth's models map onto D1 in snake_case, with app-generated UUIDs.**
- `user` maps onto the existing `users` table, which gains `email_verified` and `image`.
- New tables: `sessions`, `accounts`, `verifications`, `passkeys`, plus our own `auth_rate_limits`
  (D9).
- Every child table references `users(id) ON DELETE CASCADE`. They are scoped transitively through
  `user_id`, and migration 0070 says so (constitution III).
- Timestamps are epoch seconds, through Drizzle's `timestamp` mode, like the rest of the schema.
- `advanced.database.generateId: 'uuid'`.

*Why*: one schema and one ID shape across the tree. `accounts` stays empty, since email codes and
passkeys never write it, but Better Auth's schema check requires it. Ordering codes by a seconds
timestamp is safe, because one email gets at most one code per minute (D9). See
[data-model.md](./data-model.md).

**D5 — Sessions are Better Auth's database sessions, with these settings:**

| Setting | Value | Requirement |
|---|---|---|
| `expiresIn` | `SESSION_REFRESH_TTL_SECONDS` (5,184,000 s, 60 days) | FR-022 |
| `updateAge` | 1 day | FR-022 |
| `cookieCache` | off | FR-023, FR-025 |
| `freshAge` | 0 (our step-up replaces it, D8) | FR-005 |
| `useSecureCookies` | true | Constitution IV (HttpOnly, Secure) |
| `secret` | `BETTER_AUTH_SECRET`, one Worker secret per environment | FR-021, constitution VIII |
| `crossSubDomainCookies` | on `COOKIE_DOMAIN` when it is set | |
| `cookiePrefix` | `AUTH_COOKIE_PREFIX` per environment: `gm`, `gm-dev`, `gm-local` | |
| `trustedOrigins` | `[APP_BASE_URL]` | |

The local profile's `COOKIE_DOMAIN` becomes empty, so the cookie is host-only behind the
5174 → 5173 proxy.

The session carries four fields of ours: `auth_method`, `authenticated_at`, `passkey_required` and
`passkey_unsupported`.

*Why*:
- A cookie cache would keep a revoked session alive until the cache expired, so it stays off. That
  costs one session read per request, in place of today's user read. Better Auth reads the user in
  the same lookup, and renewal writes at most once a day.
- Dev and prod both set cookies on `.turistearya.com`, so a shared cookie name would let each
  overwrite the other.
- The token is not rotated on renewal, which ends the BUG-014 race by construction.
- The empty local domain is what makes a fresh worktree able to sign in (SC-011). (R4)

**D6 — `authMiddleware` keeps its contract and becomes the enrollment gate.**
- It reads the session with `auth.api.getSession` and forwards the renewal cookie.
- It sets `c.var.user` exactly as today, with the same `UserPayload`.
- A suspended user or a retired role is refused with `403 ACCOUNT_SUSPENDED`
  (`retire-affiliates D3`).
- A session with `passkey_required` gets `403 PASSKEY_ENROLLMENT_REQUIRED`.

A second export, `authMiddlewareAllowingEnrollment`, admits exactly four routes: `GET /api/me`,
the two passkey registration routes, and `POST /api/auth/logout`.

Better Auth's `databaseHooks.session.create.before` refuses suspended users and retired roles by
throwing, so no session row is ever written for them.
*Why*:
- Every business router already passes through `authMiddleware`, so FR-007 is enforced
  server-side without touching any of them (constitution IV).
- The hook covers both sign-in paths in one place. It throws instead of returning `false`, because
  the email-code path does not check for a null session. (R5)

**D7 — Email codes: Better Auth stores and verifies them; our routes issue and send them.**

`POST /api/auth/email-code/request` runs these steps:
1. Lowercase the email.
2. Pass the limit guards (D9).
3. Look up an admin or agent who is not suspended.
4. If found, create the code with `auth.api.createVerificationOTP` (a server-only endpoint) and send
   it through `services/resend.ts`, awaiting the send.
5. A send failure answers `503 OTP_DELIVERY_FAILED`. An unknown email gets the same `200` and
   nothing is sent.

`POST /api/auth/email-code/verify` calls `auth.api.signInEmailOTP`. It then:
- sets `passkey_required = 0` only when the client reported `passkeySupport: 'none'` (FR-009);
- moves an `unverified` user to `active` (FR-015).

Plugin options:

| Option | Value | Requirement |
|---|---|---|
| `otpLength` | 6 | FR-010 |
| `expiresIn` | 600 | FR-010 |
| `allowedAttempts` | 5 | FR-011 |
| `disableSignUp` | true | |
| `storeOTP` | `{ hash: HMAC-SHA256(BETTER_AUTH_SECRET, code) }` | FR-016 |

`sendVerificationOTP` throws if it is ever called, because the plugin's own send endpoint is never
routed.

In the local profile only, `OTP_LOG_TO_CONSOLE = "true"` logs the code instead of sending it
(FR-064).

*Why*:
- The plugin's built-in `hashed` mode is unsalted SHA-256. Over a 10⁶ code space, a leaked table
  reverses in milliseconds. An HMAC whose key never lives in D1 does not (FR-016).
- Awaiting the send is what makes `OTP_DELIVERY_FAILED` truthful. The accepted cost is a timing
  difference between a known and an unknown email, bounded by the limits in D9. (R6)

**D8 — The step-up is a fresh sign-in.**
- `authenticated_at` is set when a session is created, and renewal never moves it.
- Adding a passkey outside the mandatory step, or removing one, requires
  `now − authenticated_at ≤ 900 s`. Otherwise the answer is `403 REAUTH_REQUIRED`.
- The app then reruns "Entrar con llave de acceso" (or the email code), which issues a new session.
- Any successful sign-in revokes the same user's session that the request still carried.

*Why*: there is no second ceremony to build, and a fresh sign-in is the strongest proof the product
has. Revoking the replaced session keeps "Cerrar sesión en todos los dispositivos" honest. (R7)

**D9 — The rate limits live in D1, as single-statement guards.**

`auth_rate_limits(key, window_start, count)` is consumed through one `INSERT … ON CONFLICT DO
UPDATE … WHERE count < limit RETURNING`. If no row comes back, the answer is
`429 OTP_RATE_LIMITED` with `retry_after_seconds`.

The keys:
- `otp:min:<email>`: 1 per 60 s (FR-012)
- `otp:hour:<email>`: 5 per 3,600 s (FR-012)
- `otp:ip:<cf-connecting-ip>`: 20 per 3,600 s, a backstop against address spraying

*Why*:
- `auth.api` calls bypass Better Auth's limiter, and its memory store would count per isolate.
- A single guarded statement is constitution V's idiom: two parallel requests cannot both pass the
  last slot. (R8)

**D10 — Passkeys use `@better-auth/passkey`, configured against its defaults.**

Configuration:

| Option | Value | Requirement |
|---|---|---|
| `rpID` | Host of `APP_BASE_URL`: `app.turistearya.com`, `app-dev.turistearya.com` or `localhost` | FR-003 |
| `origin` | `APP_BASE_URL` | |
| `rpName` | `Turistear Ya!` | |
| `residentKey` | `required` | FR-001 |
| `userVerification` | `required` | FR-002 |

- `origin` is set explicitly because, when it is unset, the plugin trusts the request's `Origin`
  header.
- `registration.afterVerification` and `authentication.afterVerification` throw when
  `userVerified` is false, because the plugin passes `requireUserVerification: false` to
  SimpleWebAuthn.
- Registration keeps `requireSession: true`; the invitation creates its session first (D12).

Our routes add:
- the limit of 10 per account, checked before options are generated (`PASSKEY_LIMIT_REACHED`);
- `last_used_at`, written after a verified sign-in from the credential id in the request body;
- list and rename filtered by owner;
- delete as one guarded statement that refuses the last passkey (`PASSKEY_LAST_ONE`, FR-008),
  instead of the plugin's read-then-delete;
- notice emails after a passkey is added or removed, under `waitUntil` (constitution VIII).

Errors map as follows:

| Better Auth code | Our code |
|---|---|
| `PASSKEY_NOT_FOUND` | `PASSKEY_NOT_RECOGNIZED` |
| `CHALLENGE_NOT_FOUND` | `PASSKEY_VERIFICATION_FAILED` |
| `AUTHENTICATION_FAILED` | `PASSKEY_VERIFICATION_FAILED` |
| `FAILED_TO_VERIFY_REGISTRATION` | `PASSKEY_VERIFICATION_FAILED` |

A use count that went backwards surfaces as `AUTHENTICATION_FAILED`: SimpleWebAuthn throws inside
verification, so it cannot be told apart from a bad signature. The spec's FR-070 is amended to
match.

*Why*: per-environment hosts mean a phone never even offers a dev passkey on prod. The plugin's
own defaults are "preferred", "trust the header" and "read then delete", and each would break a
requirement. (R9)

**D11 — Registration needs no password.**
- `POST /api/auth/register {name, email, company_name, phone}` writes the organization and its
  `unverified` admin in one `db.batch`. The organization keeps its D17 default policy, and
  `password_hash` and `password_salt` are written as `''` until D16.
- It then issues a sign-in code exactly as D7 does, with the same limits.
- `EMAIL_ALREADY_EXISTS` is answered as today.

*Why*: one code path verifies an address, whether the account is new or old (FR-015, FR-030).

**D12 — Invitation completion opens the session that the enrollment step needs.**
`POST /api/auth/invite/complete {token, name, passkeySupport}` does three things:
1. In one `db.batch`, writes the agent (`active`, `email_verified = 1`, since the link proves the
   address) and marks the invitation accepted.
2. Opens a session through `issueInvitationSession`, a server-only endpoint of our local Better
   Auth plugin (`src/auth/plugin.ts`). It calls `internalAdapter.createSession` with
   `auth_method: 'invitation'`, then `setSessionCookie`.
3. Sends the app to the same enrollment step as an email-code sign-in, with `passkey_required`
   following `passkeySupport`.

*Why*: every way in reaches one enrollment flow. The plugin's sessionless registration
(`requireSession: false` with `resolveUser`) would need a second signed context and still fail
browsers without WebAuthn (FR-031). (R10)

**D13 — Restoring an agent's access is tenant-scoped, and lives in the agents router.**
`POST /api/agents/:id/restore-access` (admin only):
- In one `db.batch`, deletes the agent's `passkeys` and `sessions`. Each delete is filtered through
  `users.id = ? AND users.organization_id = <actor org> AND users.role = 'agent'`.
- An agent outside the actor's organization answers `404` (constitution III).
- A notice email follows under `waitUntil`.

Two routes close out sessions for the user themself:
- `POST /api/auth/sessions/revoke-all` calls `auth.api.revokeSessions` (FR-024).
- `POST /api/auth/logout` calls `auth.api.signOut` (FR-023).

*Why*: the admin plugin's operations are global, and this product's admins are per organization.

**D14 — Agnostic Auth and passwords leave the code.**
- **Deleted**:
  - `services/agnosticAuth.ts` and `utils/jwt.ts`
  - the routes `/login`, `/verify` (GET and POST), `/forgot-password` and `/reset-password`. They
    are unmounted, not tombstoned (`retire-affiliates D11`), so Hono answers `404`.
  - `sendMagicLinkEmail` and `sendPasswordResetEmail`
  - the `AGNOSTIC_AUTH_API` binding, `AGNOSTIC_AUTH_APP_ID` and `DEV_AUTH_SERVICE_URL`, from all
    three `wrangler.jsonc` profiles, `bindings.d.ts` and `vitest.config.ts`
- **Added**: `sendSignInCodeEmail`, `sendPasskeyNoticeEmail` and `sendAccessRestoredEmail`.
- **Codes**: `ErrorCode` gains the ten FR-070 codes and loses `INVALID_CREDENTIALS` and
  `EMAIL_NOT_VERIFIED`.

*Why*: FR-062 and SC-003 ask for zero references, and a binding nobody calls is still a reference.

**D15 — The app rebuilds `features/auth` and adds one route.**
- **Sign-in screen**: "Entrar con llave de acceso" first, with the conditional-UI autofill on the
  email input, then "Recibir código por correo".
- **Enrollment step**: mandatory, in `AuthLayout`. `AuthGuard` sends any session with
  `passkeyRequired` there.
- **`/seguridad`** (`ROUTES.SECURITY`, linked from `AccountMenu` for both roles): passkeys as
  `SectionCard` rows, rename in a `FormSheet`, remove and "Cerrar sesión en todos los dispositivos"
  in a `ConfirmSheet`.
- **Legacy-link page**: shown for `/verify`, `/forgot-password` and `/reset-password`.
- **"Restablecer acceso"**: a `ConfirmSheet` on the agent row.
- **WebAuthn calls**: `@simplewebauthn/browser` runs the ceremonies.
  `passkeySupport = typeof PublicKeyCredential === 'function' ? 'available' : 'none'`.
- **Removed**: `LoginForm`, `PasswordInput`, `PasswordStrength`, `ForgotPasswordForm`,
  `ResetPasswordForm`, `useLogin`, `useForgotPassword`, `useResetPassword` and `useVerify`.
- **Mirror**: `services/authService.ts`, its MSW handlers and `features/auth/types.ts` follow
  [the contract](./contracts/api.md).

*Why*: constitution VII. Sheets carry every edit and confirmation, and no new token is needed.
WebAuthn existing at all is the honest test of "this device can hold a passkey", because a
computer without a platform authenticator can still use the phone (hybrid) or a security key
(Story 2, scenario 3).

**D16 — Password material is dropped by the deploy that follows cutover.**
- From cutover, this feature stops reading and writing passwords. The columns are `NOT NULL`, so
  inserts write `''`.
- Dropping `users.password_hash`, `users.password_salt` and `password_reset_tokens` is the next
  deploy's migration. It is registered at implementation as debt `password-material`.

*Why*: a migration runs before the code it ships with, and the code being replaced still reads
those columns (constitution, Additional constraints). The repo already took this path for
affiliates (`specs/001-retire-affiliates` D1, then `specs/002-drop-affiliate-tables`). The spec's
FR-061 and SC-006 are amended to say when the drop happens.

**D17 — Migration `0070_better_auth.sql` is additive.** It adds:
- the tables and indexes of D4 and D9;
- `users.email_verified` (`NOT NULL DEFAULT 0`), backfilled to 1 where `status = 'active'`;
- `users.image` (nullable, never written).

It also lowercases `users.email` and `invitations.identity`.
*Why*: Better Auth looks up emails lowercased. Old code ignores the new columns. If two addresses
differ only in case, the unique index fails the migration before any code ships, and
[quickstart.md](./quickstart.md) runs that check first. (R11)

**D18 — Tests get a session the way production does.**
- The test setup file (`test/helpers/apply-migrations.ts`) installs a test-only trigger, never a
  migration. It gives every inserted user a `sessions` row whose token is derived from the email.
- `test/helpers/session.ts` exports a synchronous `sessionCookie(email)`. It signs that token with
  the pinned test secret through `@noble/hashes`, producing the exact cookie Better Auth reads.
- This replaces `buildFakeJwt`. Each of the 65 business suites changes only its import and its
  cookie line: the spec's scope boundary.

The rewritten `test/auth/` drives real ceremonies through a software authenticator (WebCrypto
P-256, attestation `none`).

End-to-end runs sign in through Playwright's virtual authenticator, holding a credential whose
private key is a GitHub secret. The `E2E_*_PASSWORD` secrets retire.
*Why*:
- Constitution VI: a real D1 and a real Better Auth, with Resend stood in for at its origin, as
  today.
- An asynchronous helper would have touched every call site of 65 files, not two lines in each.
- The software authenticator proves user verification, the 10-key limit and the use count. A
  stubbed verifier could not. (R12, R13)

**D19 — Amend the constitution in this pull request**, through `/speckit-constitution`
(v1.1.0 → v1.2.0, MINOR):
- **Principle IV**: Better Auth sessions on `.turistearya.com`, issued by the API, named
  `__Secure-<prefix>.session_token`, replacing `gm_access` and `gm_refresh`.
- **Principle VI**: the `AGNOSTIC_AUTH_API` stand-in leaves; the test config pins
  `BETTER_AUTH_SECRET`.
- **Principle VIII**: Agnostic Auth leaves the list of services we do not own, and Resend's role on
  the recovery path is recorded.
- **Stack table**: the "Auth" row becomes Better Auth with its passkey and email-OTP plugins; the
  "Runtime" row adds `nodejs_als`.

CLAUDE.md's local-login caveat is rewritten to match (SC-011).
*Why*: Governance asks for amendments to land in the pull request that needs them.

## Technical Context

**Language/Version**: TypeScript (ESM), Node 22

**Primary Dependencies**:
- API: Hono 4, Drizzle ORM 0.45, Zod 4, Better Auth 1.7.7 with `@better-auth/passkey` and
  `@better-auth/drizzle-adapter`, `@noble/hashes` (tests).
- App: React 19, MUI 9, TanStack Query 5, React Router 7, `@simplewebauthn/browser` 13.

**Storage**: Cloudflare D1, migration `0070_better_auth.sql` (D17); the follow-up drop (D16).

**Testing**:
- API: Vitest 4 with `@cloudflare/vitest-pool-workers`, against a real D1 with every migration
  applied.
- App: jsdom with Testing Library, MSW and axe.
- End to end: Playwright with the CDP virtual authenticator.

**Target Platform**: Cloudflare Workers (`compatibility_date` 2025-08-03, plus `nodejs_als`);
evergreen mobile browsers (Android 9+ with Play services, iOS 16+).

**Project Type**: web service and web app (pnpm workspace).

**Performance Goals**:
- A passkey sign-in completes in under 10 s from screen to home (SC-001), of which the server
  takes two round trips.
- An authenticated request costs one session lookup and at most one daily renewal write.

**Constraints**:
- No external authentication service (SC-003, SC-004).
- Revocation takes effect at the next request (FR-023), so there is no session cache.
- The business suites change only how they obtain a session (Scope Boundary).
- Migrations stay additive (D16, D17).

**Scale/Scope**:
- Two roles; today's staff of a handful of organizations.
- About 25 API files and 25 app files touched; 65 test files get a two-line edit; 1 migration.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design. It passes both times.*

| Principle | Gate | Result |
| --- | --- | --- |
| I. Spec-driven, cited | Spec, plan and contracts sit under `specs/003-passkey-auth/`. Decisions D1–D19 carry their why. The scope boundary is a mechanical test (D18). Spec amended in place where the plan taught something (FR-061, SC-006, FR-070) | PASS |
| II. Money law | No money path changes; the cash, sale and report suites run untouched except for their session line | PASS |
| III. Tenant isolation | New tables are scoped through `user_id`, and the migration says so (D4). Codes and limits are keyed by a globally unique email, exempt as `users.email` is. The restore filters by the actor's organization and answers `404` across organizations, proven with `seedTwoOrgs` (D13). No schema declares `organization_id` | PASS |
| IV. The server decides | The enrollment gate, step-up, limits and last-passkey guard are all enforced in the API (D6–D10). Routes live in `routes/auth/` behind `zValidator` with the `ApiError` envelope, and Better Auth is not mounted (D2). Codes are declared in the spec (FR-070). The mirror and MSW follow the contract (D15). Cookies stay HttpOnly on `.turistearya.com`, and the text naming `gm_access` and `gm_refresh` is amended (D19) | PASS |
| V. Capacity guarded by the DB | No capacity path changes. The new guards (rate limit, last passkey) use the same single-statement idiom (D9, D10) | PASS |
| VI. Proven where enforced | API tests run in workerd against a real D1 and a real Better Auth, with ceremonies from a software authenticator (D18). Resend is stood in for at its origin. The test config pins `BETTER_AUTH_SECRET`. Every new file cites `passkey-auth US<n>`. Component tests assert axe. End to end stays nightly and labelled, not a merge gate | PASS |
| VII. Elegant Field Minimalism | "Llave de acceso" and "código por correo" are used everywhere. `FormSheet` and `ConfirmSheet` carry every edit, there are no new tokens, and targets are at least 48 px (D15) | PASS |
| VIII. Services we do not own | Agnostic Auth leaves (D14). Resend failing on the code path answers `OTP_DELIVERY_FAILED`, and nothing there is a money write. Notices go after the write, under `waitUntil`. `BETTER_AUTH_SECRET` differs per environment (D5) | PASS |

The stack table is the one departure, and it is justified in Complexity Tracking and amended by D19.

## Project Structure

### Documentation (this feature)

```text
specs/003-passkey-auth/
├── spec.md
├── plan.md              # this file
├── research.md          # R1–R13: what was measured in Better Auth 1.7.7 and the alternatives behind D1–D19
├── data-model.md        # tables, columns, indexes, state of a session
├── contracts/
│   └── api.md           # every auth endpoint, its body, its answers and its codes
├── quickstart.md        # secrets, pre-flight checks, the cutover and how to prove it
├── checklists/
│   └── requirements.md
└── tasks.md             # /speckit-tasks
```

### Source Code (repository root)

```text
api-turistear/
├── migrations/0070_better_auth.sql             # D4, D9, D17
├── wrangler.jsonc                              # −AGNOSTIC_AUTH_*, +nodejs_als, +AUTH_COOKIE_PREFIX, local COOKIE_DOMAIN "", +OTP_LOG_TO_CONSOLE (local)
├── vitest.config.ts                            # −AGNOSTIC_AUTH_API stand-in, +BETTER_AUTH_SECRET pinned
├── src/
│   ├── auth/
│   │   ├── index.ts                            # getAuth(env): Better Auth config (D3, D5, D7, D10)
│   │   ├── plugin.ts                           # local plugin: session fields, create hook, issueInvitationSession (D6, D12)
│   │   ├── errors.ts                           # APIError → ApiError (FR-070)
│   │   └── rateLimit.ts                        # guarded D1 limits (D9)
│   ├── db/schema.ts                            # +sessions, accounts, verifications, passkeys, authRateLimits; users +emailVerified, image
│   ├── middleware/auth.ts                      # getSession, enrollment gate (D6)
│   ├── routes/auth/{index,handler,schema}.ts   # contract (D2, D7, D8, D10–D12)
│   ├── routes/agents/{index,handler}.ts        # restore-access (D13)
│   ├── services/resend.ts                      # −magic link, −reset; +code, +notices (D14)
│   ├── services/agnosticAuth.ts                # deleted
│   ├── utils/jwt.ts                            # deleted
│   └── types/{errors,context}.ts               # codes (FR-070)
└── test/
    ├── helpers/{apply-migrations,session,authenticator}.ts   # D18
    ├── helpers/jwt.ts                          # deleted
    └── auth/                                   # rewritten: email-code, passkeys, registration, invitation, sessions, enrollment-gate, restore-access

app-turistear/
├── e2e/setup/auth.setup.ts                     # virtual authenticator (D18)
└── src/
    ├── config/routes.ts                        # +SECURITY; −FORGOT_PASSWORD, RESET_PASSWORD (legacy page)
    ├── services/authService.ts (+ MSW)         # contract mirror
    ├── features/auth/                          # sign-in, code, enrollment, security, legacy link (D15)
    ├── features/agents/                        # "Restablecer acceso"
    ├── layout/AccountMenu.tsx                  # link to /seguridad
    └── pages/                                  # LoginPage, RegisterPage, InviteAcceptPage, SecurityPage, LegacyLinkPage
```

**Structure Decision**: the existing pnpm workspace, with one new API folder, `src/auth/`. It holds
the Better Auth instance and its local plugin, which are neither routes, middleware nor services in
the constitution's sense. Everything a client calls stays in `routes/auth/` and `routes/agents/`.

## Complexity Tracking

| Departure | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| A new dependency on the auth path (Better Auth 1.7.7 with two plugin packages), in place of the stack table's Agnostic Auth | The developer chose Better Auth (spec Clarifications). It provides WebAuthn verification, signed database sessions and code storage | A hand-built WebAuthn stack means our own CBOR, COSE and attestation handling, a larger surface than a pinned, audited library |
| The Worker compatibility flag `nodejs_als` | Better Auth keeps its request context in `AsyncLocalStorage` (R3) | The full `nodejs_compat` would add Node polyfills that no runtime import needs |
| A test-only database trigger in the setup file (D18) | It gives 65 suites a session with a two-line edit each | An asynchronous helper would change every call site; a middleware test bypass would be a back door in production code |
