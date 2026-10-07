# Implementation Plan: Passkey Sign-In with Email Code Backup

**Branch**: `claude/webauth-passkeys-fido-auth-ylusuh` | **Date**: 2026-10-07 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/004-passkey-auth/spec.md`

## Summary

Replace passwords and Agnostic Auth with **Better Auth 1.7.7, used the standard way**.

- **Routing**: its handler owns `/api/auth/*`, and the app talks to it through Better Auth's own
  client.
- **Plugins**: the `passkey` and `emailOTP` plugins do sign-in. Better Auth's database sessions and
  rate limiter do the rest.
- **What we still write**: only what Better Auth cannot know.
  - registering an organization and accepting an invitation, under `/api/onboarding/*`;
  - the suspended-account refusal;
  - the notice emails;
  - the business routes' session middleware.
- **Retirement**: Agnostic Auth leaves every environment. Password columns stop being read and are
  dropped by the next deploy (D15).

The 2026-10-06 version of this plan wrapped Better Auth inside our own routes and added a mandatory
passkey, per-email limits, a 15-minute step-up, a last-passkey guard and an admin restore. On
2026-10-07 the developer chose Better Auth's standards instead (spec Clarifications), and those
pieces are withdrawn.

Code cites these decisions as `passkey-auth D<n>`.

## Decisions

**D1 — Better Auth 1.7.7, pinned exactly.**
- API: `better-auth`, `@better-auth/passkey` and `@better-auth/drizzle-adapter` at 1.7.7.
- App: `better-auth` (client) and `@better-auth/passkey` (its `/client` entry) at 1.7.7.
- Telemetry is set off explicitly.

*Why*: the passkey plugin pins its peers exactly (`better-call 1.4.0`, `@better-auth/utils 0.4.2`),
and a second copy breaks it. Telemetry already defaults to off in 1.7.7; saying so keeps a future
default from turning it on. ([research](./research.md) R1)

**D2 — Better Auth's handler owns `/api/auth/*`; our own routes move to `/api/onboarding/*`.**
`src/index.tsx` mounts
`app.on(['GET', 'POST'], '/api/auth/*', (c) => getAuth(c.env).handler(c.req.raw))`.
`/api/auth` is Better Auth's default `basePath`.

What we still own lives in `routes/onboarding/{index,handler,schema}.ts`, following constitution
IV:
- `POST /api/onboarding/register`
- `GET /api/onboarding/invitations/:token`
- `POST /api/onboarding/invitations/:token/accept`

Of Better Auth's core, only the safe parts are reachable:
- email-and-password is not enabled, so `/sign-up/email` and `/sign-in/email` do not exist;
- `changeEmail` and `deleteUser` stay disabled, which is the default;
- `organizationId`, `role`, `status`, `phone` and `plan` are `additionalFields` with
  `input: false`, so `/update-user` can change only `name`.

*Why*: the developer's decision to adopt the standard. Better Auth's client then works unchanged,
and we write only what Better Auth does not know (organizations, invitations).
- `input: false` is what keeps constitution III's "`organization_id` never from a body" true on a
  route we do not write.
- Principle IV is amended for `/api/auth/*` (D18). (R2)

**D3 — One auth instance per isolate.** `src/auth/index.ts` exports `getAuth(env)`, memoized in a
`WeakMap` keyed by the `env` object. It is built with
`drizzleAdapter(getDb(env), { provider: 'sqlite', transaction: false })`. The Worker gains the
compatibility flag `nodejs_als`, not the full `nodejs_compat`.

*Why*:
- Workers hand out bindings per request. The `WeakMap` rebuilds nothing on a warm isolate and still
  builds a fresh instance for each test's `env`.
- D1 has no interactive transactions (constitution V).
- The only Node import on 1.7.7's runtime path is `node:async_hooks`, measured in the published
  tarballs. (R3)

**D4 — Better Auth's standard schema, mapped to snake_case D1 tables.**

| Better Auth model | Table | Notes |
|---|---|---|
| `user` | `users` (existing) | Gains `email_verified` and `image` |
| `session` | `sessions` | New |
| `account` | `accounts` | New; required by the schema, always empty here |
| `verification` | `verifications` | New |
| `passkey` | `passkeys` | New |
| `rateLimit` | `rate_limits` | New |

- No column is ours beyond Better Auth's.
- Child tables reference `users(id) ON DELETE CASCADE` and are scoped transitively through
  `user_id`. The migration says so (constitution III).
- Timestamps are epoch seconds through Drizzle's `timestamp` mode, except `rate_limits.last_request`,
  which Better Auth keeps in milliseconds.
- IDs are UUIDs (`advanced.database.generateId: 'uuid'`).

See [data-model.md](./data-model.md).

**D5 — Sessions use Better Auth's defaults.**
- `expiresIn` 7 days, `updateAge` 1 day and `freshAge` 1 day are defaults; `cookieCache` stays off,
  also the default (FR-022, FR-023, FR-025, FR-005).
- Per environment:
  - `secret: BETTER_AUTH_SECRET`, a Worker secret that differs per environment;
  - `advanced.cookiePrefix: AUTH_COOKIE_PREFIX`: `gm` in prod, `gm-dev` in dev, `gm-local` locally;
  - `advanced.crossSubDomainCookies` on `COOKIE_DOMAIN` when it is set;
  - `advanced.useSecureCookies: true`;
  - `trustedOrigins: [APP_BASE_URL]`;
  - `advanced.ipAddress.ipAddressHeaders: ['cf-connecting-ip']`.

*Why*:
- Dev and prod both set cookies on `.turistearya.com`, so a shared cookie name would let one
  environment overwrite the other's session.
- A separate secret per environment is constitution VIII.
- The token is not rotated on renewal, which ends the BUG-014 race by construction. (R4)

**D6 — Suspended accounts are refused in two places.**
- **At sign-in**: `databaseHooks.session.create.before` throws
  `APIError('FORBIDDEN', { code: 'ACCOUNT_SUSPENDED' })` for a suspended user, so no session row is
  written. For a user still `unverified`, the same hook sets `status = 'active'` (FR-015; the email
  code proved the address).
- **On every request**: `authMiddleware` reads `auth.api.getSession({ headers, returnHeaders: true })`
  and forwards the renewal cookie. It refuses `suspended` with `403 ACCOUNT_SUSPENDED`, as today,
  and sets `c.var.user` to today's `UserPayload`.

*Why*: business routes keep their exact contract, so the 61 business suites only change how they get
a session. The hook covers both sign-in paths in one place. It throws instead of returning `false`,
because the email-code path does not check for a null session. (R5)

**D7 — Email codes use the `emailOTP` plugin's defaults.**
- Options: `otpLength` 6, `expiresIn` 300 and `allowedAttempts` 3 are defaults. We set
  `disableSignUp: true` and `storeOTP: 'encrypted'`.
- `sendVerificationOTP` calls `sendSignInCodeEmail` in `services/resend.ts`. When
  `OTP_LOG_TO_CONSOLE === 'true'` (local only), it logs the code instead (FR-064).
- Sends run in the background through `advanced.backgroundTasks.handler`, set to `waitUntil` from
  `cloudflare:workers`.

*Why*:
- `'encrypted'` is Better Auth's own option, keyed by the environment secret, so the table alone
  cannot be read back (FR-016). Its `'hashed'` option is an unsalted SHA-256, which reverses over
  10⁶ codes.
- With `disableSignUp`, an unknown email gets the same `{ success: true }` and nothing is sent. With
  the send in the background, a known and an unknown email also answer in the same time (FR-013).
- Not awaiting the send is Better Auth's documented practice. (R6)

**D8 — Passkeys use the `passkey` plugin.**

| Option | Value | Requirement |
|---|---|---|
| `rpID` | Host of `APP_BASE_URL`: `app.turistearya.com`, `app-dev.turistearya.com` or `localhost` | FR-003 |
| `origin` | `APP_BASE_URL` | |
| `rpName` | `Turistear Ya!` | |
| `authenticatorSelection` | `{ residentKey: 'required', userVerification: 'required' }` | FR-001, FR-002 |
| `registration.requireSession` | default (true), which keeps the fresh-session check on add | FR-005 |

- `origin` is set explicitly because, when it is unset, the plugin trusts the request's `Origin`
  header.
- Its standard routes do list, rename and delete.

*Why*: per-environment hosts mean a phone never offers a dev passkey on prod. User verification is
requested from the device but not refused server-side, which the spec accepts as standard
behaviour. (R9)

**D9 — Better Auth's rate limiter, stored in D1.**
- Settings: `rateLimit: { enabled: true, storage: 'database', modelName: 'rate_limits' }`.
- Built-in rules apply per client IP (`cf-connecting-ip`): `/sign-in*` allows 3 per 10 s, the
  email-code send allows 3 per 60 s, and everything else 100 per 60 s.
- A refusal is `429` with `X-Retry-After`, which `src/index.tsx`'s CORS exposes to the app.

*Why*:
- In memory, each Worker isolate would count on its own.
- Enabling it explicitly avoids depending on how Better Auth detects production inside a Worker. (R8)

**D10 — Registration.** `POST /api/onboarding/register {name, email, company_name, phone}`:
1. Lowercases the email.
2. Refuses with `409 EMAIL_ALREADY_EXISTS` as today.
3. Writes the organization (with its D17 policy) and its `unverified` admin, with `email_verified = 0`
   and password columns `''` (D15), in one `db.batch`.
4. Calls `auth.api.sendVerificationOTP({ body: { email, type: 'sign-in' } })` and answers `201`.

The app then shows the code step and uses `authClient.signIn.emailOtp`.

*Why*: organizations are ours, and the sign-in is Better Auth's. One code path verifies every
address (FR-015, FR-030).

**D11 — Invitations.**
- `GET /api/onboarding/invitations/:token` is today's lookup, moved.
- `POST /api/onboarding/invitations/:token/accept {name}`:
  - writes the agent (`active`, `email_verified = 1`, password columns `''`) and accepts the
    invitation, in one `db.batch`;
  - refuses with `409 EMAIL_ALREADY_EXISTS` when the address now has an account;
  - then sends a sign-in code exactly as D10 does.

The app shows the code step and then the passkey offer (FR-031).

*Why*: the plugin's sessionless registration (`requireSession: false` plus `resolveUser`) would let
the invitee create a passkey straight from the link. It would also need a resolver and a signed
context of ours, and it would drop the fresh-session check on every later passkey added. The extra
code is the standard path. (R10)

**D12 — Notices through Better Auth's hooks.** `hooks.after` (`createAuthMiddleware`) on
`/passkey/verify-registration` and `/passkey/delete-passkey` sends `sendPasskeyNoticeEmail` through
the same background handler, after the change succeeded (FR-041, constitution VIII).

*Why*: hooks are Better Auth's own extension point, and nothing is wrapped.

**D13 — Agnostic Auth and passwords leave the code.**
- **Deleted**:
  - `services/agnosticAuth.ts`, `utils/jwt.ts`, `utils/cookies.ts` and `routes/auth/` (replaced by
    Better Auth and `routes/onboarding/`);
  - `sendMagicLinkEmail` and `sendPasswordResetEmail`;
  - `INVALID_CREDENTIALS` and `EMAIL_NOT_VERIFIED`;
  - the `AGNOSTIC_AUTH_API` binding, `AGNOSTIC_AUTH_APP_ID` and `DEV_AUTH_SERVICE_URL`, from all
    three `wrangler.jsonc` profiles, `bindings.d.ts`, `vitest.config.ts` and `.dev.vars.example`;
  - `SESSION_REFRESH_TTL_SECONDS`, which only `utils/cookies.ts` read; sessions now use Better
    Auth's defaults (D5).
- Unknown paths under `/api/auth/*`, such as the old `/login` and `/forgot-password`, get Better
  Auth's `404`.

*Why*: FR-062 and SC-003 ask for zero references.

**D14 — The app uses Better Auth's client.**
- **Client**: `app-turistear/src/services/authClient.ts` holds
  `createAuthClient({ baseURL: VITE_API_BASE_URL, basePath: '/api/auth', plugins: [emailOTPClient(), passkeyClient()], fetchOptions: { credentials: 'include' } })`.
- **Screens**:
  - `SignInScreen`: "Entrar con llave de acceso" first, with conditional-UI autofill on the email
    input, then "Recibir código por correo".
  - `PasskeyOffer`: dismissible, shown after an email-code sign-in when
    `typeof PublicKeyCredential === 'function'`.
  - `SecurityPage` at `/seguridad`, linked from `AccountMenu` for both roles: list, rename in a
    `FormSheet`, remove and sign out everywhere in a `ConfirmSheet`.
  - `LegacyLinkPage` for `/verify`, `/forgot-password` and `/reset-password`.
- **Unchanged**: `/api/me`, `useMe` and the business 401/403 interceptor.
- **MSW**: handlers mirror the Better Auth endpoints the app calls.

*Why*: constitution VII (sheets, one vocabulary), and no hand-written mirror of Better Auth's
contract.

**D15 — Password material is dropped by the deploy that follows cutover.** The columns are
`NOT NULL`, so inserts write `''` until then. Dropping `users.password_hash`, `users.password_salt`
and `password_reset_tokens` is the next PR's migration, registered at implementation as debt
`password-material`.

*Why*: a migration runs before the code it ships with, and the code being replaced still reads them.
This is the same path as `specs/001-retire-affiliates` → `specs/002-drop-affiliate-tables`.

**D16 — Migration `0071_better_auth.sql` is additive.** It takes the next free number at
implementation; it is 0071 today, after `0070_delete_legacy_affiliates.sql`. It adds:
- the tables of D4;
- `users.email_verified` (`NOT NULL DEFAULT 0`), backfilled to 1 where `status = 'active'`;
- `users.image` (nullable, never written).

It also lowercases `users.email` and `invitations.identity`.

*Why*: Better Auth looks up emails lowercased (R11). Old code ignores the new columns. A case
collision fails the unique index inside the migration, before any code ships, and the pre-merge gate
checks for it first (D19).

**D17 — Tests get a session the way production does.**
- **Business suites**:
  - The setup file (`test/helpers/apply-migrations.ts`) installs a test-only trigger, never a
    migration, that gives each inserted user a `sessions` row whose token is derived from the email.
  - `test/helpers/session.ts` exports a synchronous `sessionCookie(email)`. It signs that token with
    the pinned test secret through `@noble/hashes`, producing Better Auth's exact cookie.
  - The 61 business suites change only their import and their cookie line.
- **`test/auth/`**: rewritten, with real ceremonies driven by a software authenticator (WebCrypto
  P-256, attestation `none`).
- **App tests**: MSW answers the Better Auth endpoints, and WebAuthn is mocked at
  `navigator.credentials`.
- **End to end**: Playwright's virtual authenticator.

*Why*: constitution VI (a real D1 and a real Better Auth). An asynchronous helper would have touched
every call site. (R12, R13)

**D18 — Amend the constitution in this pull request**, through `/speckit-constitution`
(v1.1.1 → v1.2.0, MINOR):
- **Principle IV**: `/api/auth/*` is served by Better Auth's handler, with its validation, its
  `{ code, message }` and its codes. Every other route keeps `routes/<resource>/` and the `ApiError`
  envelope. Sessions are Better Auth's, still HttpOnly on `.turistearya.com`; its answers may echo
  the token, and the app never reads it.
- **Principle VI**: the `AGNOSTIC_AUTH_API` stand-in leaves; the test config pins
  `BETTER_AUTH_SECRET`.
- **Principle VIII**: Agnostic Auth leaves the list of services we do not own, and Resend's place on
  the sign-in path is recorded.
- **Stack table**: the "Auth" row becomes Better Auth with its passkey and email-OTP plugins; the
  "Runtime" row adds `nodejs_als`.

CLAUDE.md's local-login caveat is rewritten to match.
*Why*: Governance asks for amendments to land in the pull request that needs them.
**Done 2026-10-07** (`f8ff722`), before implementation, so no task runs against the old text
(`/speckit-analyze` C1).

**D19 — A pre-merge gate.** Before merging into `develop`, which deploys dev at once:
1. Set `BETTER_AUTH_SECRET` as a Worker secret in dev and in prod, with different values.
2. Run the email-case collision query against both databases.
3. Record both results in the PR.

*Why*: without the secret, every sign-in on dev fails. A collision would fail migration 0071.

## Technical Context

**Language/Version**: TypeScript (ESM), Node 22

**Primary Dependencies**:
- API: Hono 4, Drizzle ORM 0.45, Zod 4, Better Auth 1.7.7 with `@better-auth/passkey` and
  `@better-auth/drizzle-adapter`, `@noble/hashes` (tests).
- App: React 19, MUI 9, TanStack Query 5, React Router 7, and the Better Auth 1.7.7 client with its
  passkey and email-OTP plugins.

**Storage**: Cloudflare D1, migration `0071_better_auth.sql` (D16); the follow-up drop (D15).

**Testing**:
- API: Vitest 4 with `@cloudflare/vitest-pool-workers`, against a real D1 and a real Better Auth.
- App: jsdom with Testing Library, MSW and axe.
- End to end: Playwright with the CDP virtual authenticator.

**Target Platform**: Cloudflare Workers (`compatibility_date` 2025-08-03, plus `nodejs_als`);
evergreen mobile browsers.

**Project Type**: web service and web app (pnpm workspace).

**Performance Goals**: a passkey sign-in completes in under 10 s from screen to home (SC-001). An
authenticated request costs one session lookup and at most one daily renewal write.

**Constraints**:
- No external authentication service (SC-003).
- Revocation takes effect at the next request (no cookie cache).
- Business suites change only how they get a session.
- Migrations stay additive.

**Scale/Scope**:
- Two roles; a handful of organizations.
- About 15 API files and 25 app files; 61 test files get a two-line edit; 1 migration.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design. It passes both times.
Principle IV was amended to v1.2.0 before implementation (D18).*

| Principle | Gate | Result |
| --- | --- | --- |
| I. Spec-driven, cited | The spec is amended in place, with dated Clarifications (2026-10-06, 2026-10-07). D1–D19 carry their why. The scope boundary is a mechanical test (D17) | PASS |
| II. Money law | No money path changes | PASS |
| III. Tenant isolation | New tables are scoped through `user_id` (D4). Codes, counters and passkeys are keyed by user or by globally unique keys. `organizationId`, `role` and `status` are `input: false` on Better Auth's routes (D2). The admin restore that would have crossed organizations is out of scope. Better Auth's reads by session token, credential id or verification identifier, and by the signed-in user's `user_id`, are the exempt reads that constitution v1.2.0 III names | PASS |
| IV. The server decides | Suspension is refused in the API (D6). Our routes live in `routes/onboarding/` with `zValidator` and the envelope. `/api/auth/*` follows Better Auth's contract, under the amendment that lands in this PR (D18) | PASS — constitution v1.2.0 gives `/api/auth/*` to Better Auth |
| V. Capacity guarded by the DB | No capacity path changes | PASS |
| VI. Proven where enforced | Real D1, real Better Auth and real ceremonies in workerd (D17). Resend is stood in for at its origin. Every new test cites `passkey-auth US<n>`. Component tests assert axe | PASS |
| VII. Elegant Field Minimalism | "Llave de acceso" and "código por correo". `FormSheet` and `ConfirmSheet`, no new tokens, targets of at least 48 px | PASS |
| VIII. Services we do not own | Agnostic Auth leaves (D13). Notices go after the write, in the background (D7, D12). The secret differs per environment (D5, D19) | PASS |

## Project Structure

### Documentation (this feature)

```text
specs/004-passkey-auth/
├── spec.md
├── plan.md              # this file
├── research.md          # R1–R13, measured in Better Auth 1.7.7's published tarballs
├── data-model.md        # Better Auth's schema on D1
├── contracts/
│   └── api.md           # the Better Auth endpoints the app uses, and /api/onboarding/*
├── quickstart.md        # pre-merge gate, local run, proof, cutover
├── checklists/
│   └── requirements.md
└── tasks.md
```

### Source Code (repository root)

```text
api-turistear/
├── migrations/0071_better_auth.sql             # D4, D16
├── wrangler.jsonc                              # −AGNOSTIC_AUTH_*, +nodejs_als, +AUTH_COOKIE_PREFIX, +OTP_LOG_TO_CONSOLE (local)
├── vitest.config.ts                            # −AGNOSTIC_AUTH_API stand-in, +BETTER_AUTH_SECRET pinned
├── src/
│   ├── auth/index.ts                           # getAuth(env): the whole Better Auth configuration (D3, D5–D9, D12)
│   ├── index.tsx                               # mounts /api/auth/* (D2); CORS exposes X-Retry-After (D9)
│   ├── db/schema.ts                            # +sessions, accounts, verifications, passkeys, rateLimits; users +emailVerified, image
│   ├── middleware/auth.ts                      # getSession; suspended refusal (D6)
│   ├── routes/onboarding/{index,handler,schema}.ts   # register, invitations (D10, D11)
│   ├── routes/auth/                            # deleted
│   ├── services/resend.ts                      # −magic link, −reset; +sign-in code, +passkey notice
│   ├── services/agnosticAuth.ts                # deleted
│   ├── utils/{jwt,cookies}.ts                  # deleted
│   └── types/errors.ts                         # −INVALID_CREDENTIALS, −EMAIL_NOT_VERIFIED
└── test/
    ├── helpers/{apply-migrations,session,authenticator}.ts   # D17
    └── auth/                                   # rewritten

app-turistear/
├── e2e/setup/auth.setup.ts                     # virtual authenticator
└── src/
    ├── services/authClient.ts                  # Better Auth client (D14)
    ├── services/authService.ts                 # −login/verify/forgot/reset; +onboarding calls
    ├── test/handlers/auth.ts                   # MSW for the Better Auth endpoints the app uses
    ├── features/auth/                          # sign-in, code, offer, security, legacy link
    ├── layout/AccountMenu.tsx                  # link to /seguridad
    └── pages/                                  # LoginPage, RegisterPage, InviteAcceptPage, SecurityPage, LegacyLinkPage
```

**Structure Decision**: the existing workspace, plus two API folders:
- `src/auth/`: one file, Better Auth's configuration. It is neither a route nor middleware.
- `src/routes/onboarding/`: the two flows Better Auth cannot know.

## Complexity Tracking

| Departure | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| `/api/auth/*` follows Better Auth's contract instead of Principle IV's route and error rules (amended by D18) | The developer chose Better Auth's standards (spec Clarifications, 2026-10-07). Its client and endpoints work unchanged | Wrapping it in our own routes (the 2026-10-06 plan) keeps Principle IV untouched, but rewrites a contract Better Auth already provides. The developer rejected it |
| A new dependency on the auth path, in place of the stack table's Agnostic Auth | The developer chose Better Auth | A hand-built WebAuthn stack means our own CBOR, COSE and attestation handling |
| The Worker compatibility flag `nodejs_als` | Better Auth keeps its request context in `AsyncLocalStorage` (R3) | The full `nodejs_compat` adds polyfills that no runtime import needs |
| A test-only database trigger in the setup file (D17) | It gives 61 suites a session with a two-line edit each | An asynchronous helper changes every call site; a test bypass would be a back door in production code |
