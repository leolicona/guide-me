---

description: "Task list for passkey sign-in with email code recovery, built on Better Auth"
---

# Tasks: Passkey Sign-In with Email Code Recovery

**Input**: Design documents from `specs/003-passkey-auth/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/api.md, quickstart.md

**Tests**: required by constitution VI.
- Each story is proven at the layer that enforces it. API rules are proven in workerd against a real
  D1 and a real Better Auth (D18). The app proves the mirror and the screens, with axe.
- Every new test file opens with a comment citing what it proves: `passkey-auth US<n>`.
- Every non-obvious rule in code cites `passkey-auth D<n>`.

**Feature-wide rules** (apply to every task):
- Copy is es-MX: "llave de acceso" and "código por correo", never "passkey" in the UI.
- Edits and confirmations are `FormSheet` and `ConfirmSheet`, never a `Dialog`.
- Emails are lowercased at every entry point (R11).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an unfinished task)
- **[Story]**: the spec's user story the task serves (US1–US6)

---

## Phase 1: Setup (shared infrastructure)

**Purpose**: dependencies, runtime flag, configuration and error codes that every story uses.

- [ ] T001 Add `better-auth`, `@better-auth/passkey` and `@better-auth/drizzle-adapter` at exactly `1.7.7` (no caret) plus dev dependency `@noble/hashes` `^2.2.0` to `api-turistear/package.json`, and `@simplewebauthn/browser` `^13.3.0` to `app-turistear/package.json`. Run `pnpm install` so `pnpm-lock.yaml` updates; `zod` stays `^4` (D1, R1).
- [ ] T002 In `api-turistear/wrangler.jsonc`:
  - add `"compatibility_flags": ["nodejs_als"]` at the top level; named environments inherit it (D3, R3);
  - add `AUTH_COOKIE_PREFIX` to `vars` in each profile: `gm-local` (top level), `gm-dev` (`env.dev`), `gm` (`env.production`);
  - in the top-level (local) profile only, set `COOKIE_DOMAIN` to `""` and add `OTP_LOG_TO_CONSOLE: "true"` (D5, D7).

  Do **not** remove the Agnostic Auth binding yet (T060).
- [ ] T003 [P] Add `BETTER_AUTH_SECRET=<32+ random chars>` to `api-turistear/.dev.vars.example` with a comment: a Worker secret in dev and prod, different in each environment (constitution VIII). Then run `pnpm cf-typegen:api` so `api-turistear/worker-configuration.d.ts` gains `BETTER_AUTH_SECRET`, `AUTH_COOKIE_PREFIX` and `OTP_LOG_TO_CONSOLE`, and update the hand-written declarations in `api-turistear/src/bindings.d.ts` to match.
- [ ] T004 [P] In `api-turistear/vitest.config.ts`, pin these miniflare bindings:
  - `BETTER_AUTH_SECRET: 'test_better_auth_secret_0123456789abcdef'`
  - `AUTH_COOKIE_PREFIX: 'gm-test'`
  - `COOKIE_DOMAIN: ''`
  - `OTP_LOG_TO_CONSOLE: ''`

  `.dev.vars` must never leak into a suite (constitution VI).
- [ ] T005 [P] In `api-turistear/src/types/errors.ts`, add the codes and the retry field (FR-070, contracts/api.md § Conventions):
  - Add the ten FR-070 codes to `ErrorCode`: `PASSKEY_NOT_RECOGNIZED`, `PASSKEY_VERIFICATION_FAILED`, `PASSKEY_ENROLLMENT_REQUIRED`, `PASSKEY_LAST_ONE`, `PASSKEY_LIMIT_REACHED`, `OTP_INVALID`, `OTP_ATTEMPTS_EXCEEDED`, `OTP_RATE_LIMITED`, `OTP_DELIVERY_FAILED` and `REAUTH_REQUIRED`.
  - Give `ApiError` an optional `retryAfterSeconds`.

  In `api-turistear/src/middleware/errorHandler.ts`, set a `Retry-After` header when `retryAfterSeconds` is present, and widen the status cast to include `429` and `503`.

---

## Phase 2: Foundational (blocking prerequisites)

**Purpose**: the schema, the Better Auth instance, the session-reading middleware and the test
harness. No story can start before this phase is done.

**⚠️ Note**: once T011 lands, the old password login no longer yields a usable session, because the
new middleware does not read `gm_access`. US1 restores sign-in, so land Phase 2 and US1 together.

- [ ] T006 Write `api-turistear/migrations/0070_better_auth.sql` exactly as `data-model.md` specifies:
  - the tables `sessions`, `accounts`, `verifications`, `passkeys` (with `last_used_at`) and `auth_rate_limits`;
  - `ON DELETE CASCADE` on every `user_id`;
  - the indexes;
  - `users.email_verified INTEGER NOT NULL DEFAULT 0`, backfilled to 1 where `status = 'active'`, and `users.image TEXT`;
  - `UPDATE users SET email = lower(email)` and `UPDATE invitations SET identity = lower(identity)`;
  - a header comment stating each table's transitive scope through `user_id` (constitution III).

  Do not touch the password columns (D4, D16, D17).
- [ ] T007 Map the new tables in `api-turistear/src/db/schema.ts` as Drizzle tables: `sessions`, `accounts`, `verifications`, `passkeys` and `authRateLimits`, with snake_case columns and `integer(..., { mode: 'timestamp' })` timestamps. Add `emailVerified` (`integer({ mode: 'boolean' })`) and `image` to `users`. Export their types (D4).
- [ ] T008 Create `api-turistear/src/auth/plugin.ts`, a local Better Auth plugin (`BetterAuthPlugin`), with two pieces (D6, D12, R5, R10):
  - **Session fields** in `schema.session.fields`: `authMethod` (`auth_method`), `authenticatedAt` (`authenticated_at`), `passkeyRequired` (`passkey_required`) and `passkeyUnsupported` (`passkey_unsupported`).
  - **`issueInvitationSession`**, a server-only endpoint (`createAuthEndpoint.serverOnly`, from `better-auth/api`). It takes `{ userId, passkeyRequired }`, calls `ctx.context.internalAdapter.createSession(userId, undefined, { authMethod: 'invitation', authenticatedAt: new Date(), passkeyRequired, passkeyUnsupported: !passkeyRequired })`, then `setSessionCookie` (from `better-auth/cookies`), and returns `{ session, user }`.
- [ ] T009 Create `api-turistear/src/auth/index.ts`, exporting `getAuth(env)` memoized in a `WeakMap<CloudflareBindings, Auth>`. Configure `betterAuth` with:
  - **Database (D3)**: `drizzleAdapter(getDb(env), { provider: 'sqlite', schema, transaction: false })`, mapping `user`→`users`, `session`→`sessions`, `account`→`accounts` and `verification`→`verifications` through `modelName` and snake_case `fields`. The `users` columns `organizationId`, `role`, `status`, `phone` and `plan` become `user.additionalFields` with `input: false`.
  - **Core settings (D5)**:
    - `secret: env.BETTER_AUTH_SECRET`, `baseURL: env.API_BASE_URL` and `trustedOrigins: [env.APP_BASE_URL]`;
    - `advanced.database.generateId: 'uuid'`, `useSecureCookies: true`, `cookiePrefix: env.AUTH_COOKIE_PREFIX`, `crossSubDomainCookies: { enabled: !!env.COOKIE_DOMAIN, domain: env.COOKIE_DOMAIN }` and `ipAddress.ipAddressHeaders: ['cf-connecting-ip']`;
    - `session: { expiresIn: Number(env.SESSION_REFRESH_TTL_SECONDS) || 5184000, updateAge: 86400, freshAge: 0, cookieCache: { enabled: false } }`;
    - `telemetry: { enabled: false }`.
  - **Email codes (D7, R6)**: `emailOTP({ otpLength: 6, expiresIn: 600, allowedAttempts: 5, disableSignUp: true, storeOTP: { hash } })`, where `hash` is HMAC-SHA256 keyed by `BETTER_AUTH_SECRET`, base64url (WebCrypto). Its `sendVerificationOTP` throws, because it must never run.
  - **Passkeys (D10, R9)**: `passkey({ rpID: new URL(env.APP_BASE_URL).hostname, rpName: 'Turistear Ya!', origin: env.APP_BASE_URL, authenticatorSelection: { residentKey: 'required', userVerification: 'required' }, schema })`, mapping `passkey`→`passkeys`. Both `registration.afterVerification` and `authentication.afterVerification` throw `APIError` (`AUTHENTICATION_FAILED`) when `userVerified` is false.
  - **Session-create hook (D6, R5)**: `databaseHooks.session.create.before`
    - loads the user;
    - **throws** `APIError` `FORBIDDEN` with code `ACCOUNT_SUSPENDED` when the user is suspended or the role is not `admin`/`agent` (`retire-affiliates D3`);
    - otherwise returns the data with `authMethod` (from `ctx.path`: `/passkey/verify-authentication` → `passkey`, `/sign-in/email-otp` → `email_code`, an override keeps its own) and `authenticatedAt: new Date()`;
    - sets `passkeyRequired: true` for `email_code`, failing closed.
  - **Plugins**: the local plugin from T008.
- [ ] T010 [P] Create `api-turistear/src/auth/errors.ts` with two exports (D2, D10, R6):
  - `toApiError(e)`, which maps Better Auth's `APIError` codes:

    | Better Auth code | Our code |
    |---|---|
    | `INVALID_OTP`, `OTP_EXPIRED` | `OTP_INVALID` 401 |
    | `TOO_MANY_ATTEMPTS` | `OTP_ATTEMPTS_EXCEEDED` 429 |
    | `PASSKEY_NOT_FOUND` | `PASSKEY_NOT_RECOGNIZED` 401 |
    | `CHALLENGE_NOT_FOUND`, `AUTHENTICATION_FAILED`, `FAILED_TO_VERIFY_REGISTRATION` | `PASSKEY_VERIFICATION_FAILED` 401 |
    | `ACCOUNT_SUSPENDED` | 403 |

    Anything else is rethrown.
  - `forwardSetCookies(c, headers)`, which appends every `Set-Cookie` from a `returnHeaders` result to the Hono response.
- [ ] T011 Rewrite `api-turistear/src/middleware/auth.ts` (D6):
  - Read the session with `getAuth(c.env).api.getSession({ headers: c.req.raw.headers, returnHeaders: true })` and forward its renewal cookies.
  - No session → `401 UNAUTHORIZED`.
  - Suspended user, or a role other than `admin`/`agent` → `403 ACCOUNT_SUSPENDED` (`retire-affiliates D3`).
  - Set `c.var.user` to today's `UserPayload` and `c.var.session` to `{ id, token, authMethod, authenticatedAt, passkeyRequired }`.
  - Export `authMiddleware`, which also answers `403 PASSKEY_ENROLLMENT_REQUIRED` when `passkeyRequired`, and `authMiddlewareAllowingEnrollment`, which does not.

  Drop every import of `utils/jwt.ts`, `utils/cookies.ts` and `services/agnosticAuth.ts`. Add `session` to `AppVariables` in `api-turistear/src/types/context.ts`.
- [ ] T012 In `api-turistear/src/index.tsx`, mount `GET /api/me` behind `authMiddlewareAllowingEnrollment`, answering `{ user, session: { auth_method, passkey_required } }` (contracts/api.md § `GET /api/me`).
- [ ] T013 [P] Create `api-turistear/src/auth/rateLimit.ts`, exporting `consumeLimit(db, key, limit, windowSeconds)`. It runs the single guarded `INSERT … ON CONFLICT DO UPDATE … WHERE … RETURNING` from data-model.md § auth_rate_limits and throws `ApiError('OTP_RATE_LIMITED', 429, …)` with `retryAfterSeconds` when no row returns (D9, constitution V).
- [ ] T014 Build the test harness in `api-turistear/test/helpers/apply-migrations.ts` and `api-turistear/test/helpers/session.ts` (D18, R12):
  - In `api-turistear/test/helpers/apply-migrations.ts`, after migrations, install the test-only trigger: `CREATE TRIGGER test_user_session AFTER INSERT ON users BEGIN INSERT INTO sessions (id, user_id, token, expires_at, created_at, updated_at, auth_method, authenticated_at, passkey_required, passkey_unsupported) VALUES (lower(hex(randomblob(16))), NEW.id, 'test-session-' || NEW.email, unixepoch() + 31536000, unixepoch(), unixepoch(), 'passkey', unixepoch(), 0, 0); END`.
  - Create `api-turistear/test/helpers/session.ts`, exporting a synchronous `sessionCookie(email)`. It returns `__Secure-gm-test.session_token=` followed by `encodeURIComponent(token + '.' + base64(hmac(sha256, secret, token)))` from `@noble/hashes`, and a `sessionCookieFor(token)` variant for tests that build their own sessions.
- [ ] T015 Mechanically switch the business suites to the new helper: every file under `api-turistear/test/` outside `test/auth/` and `test/helpers/` that imports `buildFakeJwt` (65 files).
  - Replace the import with `import { sessionCookie } from '../helpers/session'`.
  - Replace each `gm_access=${buildFakeJwt(x)}` with `${sessionCookie(x)}`.
  - Drop the Agnostic Auth `/auth/refresh` stub from `api-turistear/test/staff/staff-management.test.ts`.
  - Edit nothing else. Verify with `git diff --stat` that only those lines changed (spec § Scope Boundary).
- [ ] T016 [P] Create `api-turistear/test/helpers/authenticator.ts`, a software authenticator on WebCrypto ECDSA P-256 (R13):
  - `createCredential(options, { userVerified, counter })` returns a `RegistrationResponseJSON` with a `none` attestation, `authData` holding the rpIdHash, flags `UP|UV|AT` and a COSE EC2 key, and `clientDataJSON` with the expected origin.
  - `getAssertion(options, credential, { userVerified, counter })` returns an `AuthenticationResponseJSON` signed with ES256 (DER-encoded).
  - The authenticator holds `credentialId`, `userHandle` and the private key, so a later sign-in can reuse it.
- [ ] T017 Write `api-turistear/test/auth/sessions.test.ts`, citing `passkey-auth US1 (scenario 8), FR-020–FR-025, SC-005`. It covers:
  - a valid `sessionCookie` reaches a protected route;
  - an altered signature, a cookie signed with another secret, an unknown token and an expired session each answer `401 UNAUTHORIZED`;
  - a suspended user and a stored `affiliate` role each answer `403 ACCOUNT_SUSPENDED`;
  - a renewal after `updateAge` extends `expires_at` and keeps `token` unchanged;
  - 5 parallel requests during a renewal all answer 200 (BUG-014);
  - a `passkey_required` session gets `403 PASSKEY_ENROLLMENT_REQUIRED` on `/api/folios` and `200` on `/api/me`.

**Checkpoint**: `pnpm test:api` is green, apart from the old `test/auth/*` password suites, which are rewritten in their stories and deleted in T060.

---

## Phase 3: User Story 1 — sign in with an email code (P1) 🎯 MVP part 1

**Goal**: every existing admin and agent can sign in by a 6-digit code, with no password and no Agnostic Auth.

**Independent Test**: with no passkey, an active agent on a browser without WebAuthn requests a code, enters it and reaches home. The session renews and ends on sign-out.

- [ ] T018 [P] [US1] Add `sendSignInCodeEmail(env, { to, name, code })` to `api-turistear/src/services/resend.ts`, in es-MX product copy:
  - it states the code, says it lasts 10 minutes, and says Turistear Ya! never asks for it by phone or WhatsApp (FR-014);
  - when `env.OTP_LOG_TO_CONSOLE === 'true'`, it logs `[otp] <email> <code>` and sends nothing (FR-064);
  - a non-2xx answer from Resend throws.
- [ ] T019 [P] [US1] Add `emailCodeRequestSchema` (`email`, trimmed and lowercased) and `emailCodeVerifySchema` (`email`, `code` matching `/^\d{6}$/`, `passkey_support` of `'available' | 'none'`) to `api-turistear/src/routes/auth/schema.ts`.
- [ ] T020 [US1] In `api-turistear/src/routes/auth/handler.ts`, add `issueSignInCode(c, email)`, which runs these steps in order (D7, D9, R6):
  1. `consumeLimit` on `otp:ip:<cf-connecting-ip>` (20 per 3,600 s), then on `otp:min:<email>` (1 per 60 s), then on `otp:hour:<email>` (5 per 3,600 s).
  2. Look up a user by email whose role is `admin`/`agent` and who is not suspended.
  3. If one is found, run `getAuth(c.env).api.createVerificationOTP({ body: { email, type: 'sign-in' } })`, then `await sendSignInCodeEmail(...)`. A send failure becomes `ApiError('OTP_DELIVERY_FAILED', 503)`.
  4. If none is found, return without sending.

  Add the handler `requestEmailCode`, which calls `issueSignInCode` and answers the generic 200 message (FR-013).
- [ ] T021 [US1] In `api-turistear/src/routes/auth/handler.ts`, add `verifyEmailCode`. It calls `auth.api.signInEmailOTP({ body: { email, otp: code }, headers, returnHeaders: true })` with errors through `toApiError`, then:
  - sets `passkey_required = 0` and `passkey_unsupported = 1` on the new session when `passkey_support === 'none'` (FR-009);
  - runs `UPDATE users SET status = 'active' WHERE id = ? AND status = 'unverified'` (FR-015);
  - revokes the request's previous session if it belonged to the same user (D8).

  It forwards the cookies and answers `{ user: { name, role }, session: { passkey_required } }`. Also rewrite `logout` to call `auth.api.signOut({ headers, returnHeaders: true })`: answer 200 even with no session, forward the cookie expiry, and drop `revokeToken` (FR-023).
- [ ] T022 [US1] Wire `POST /api/auth/email-code/request` and `POST /api/auth/email-code/verify` with `zValidator`, and keep `POST /api/auth/logout` without middleware, in `api-turistear/src/routes/auth/index.ts`.
- [ ] T023 [US1] Write `api-turistear/test/auth/email-code.test.ts`, citing `passkey-auth US1`, with Resend stubbed at its origin as `test/email/` does today. It covers:
  - Story 1, scenarios 1–7, plus scenario 8 for the retired role;
  - unknown email → same 200 and no Resend call;
  - newest code wins;
  - 6th try → `OTP_ATTEMPTS_EXCEEDED`;
  - 2nd request within 60 s → `429` with `Retry-After`;
  - 6th request in an hour → `429`;
  - 21 requests from one IP → `429`;
  - Resend 500 → `503 OTP_DELIVERY_FAILED`;
  - the stored `verifications.value` does not contain the code (FR-016);
  - an `unverified` admin becomes `active` with `email_verified` set;
  - no `sessions` row is created for a suspended user.
- [ ] T024 [P] [US1] In `app-turistear/src/services/authService.ts`:
  - add `requestEmailCode(email)` and `verifyEmailCode({ email, code, passkey_support })` per contracts/api.md;
  - extend `getMe` to return `session`;
  - make the `request()` interceptor send a `403 PASSKEY_ENROLLMENT_REQUIRED` from any non-`/api/auth/` path to `ROUTES.PASSKEY_ENROLL` (D6, D15).

  Add matching MSW handlers in `app-turistear/src/test/handlers/auth.ts`, mirroring the service one to one (constitution IV).
- [ ] T025 [P] [US1] Create `app-turistear/src/features/auth/passkeySupport.ts`, exporting `passkeySupport(): 'available' | 'none'`, which is `typeof window.PublicKeyCredential === 'function'` (D15). Add `emailCodeRequestSchema` and `emailCodeVerifySchema` to `app-turistear/src/features/auth/schemas.ts`, and `SessionInfo` to `app-turistear/src/features/auth/types.ts`.
- [ ] T026 [US1] Create the hooks `useRequestEmailCode.ts` and `useVerifyEmailCode.ts` in `app-turistear/src/features/auth/hooks/`. On success, verify sets the `['me']` query, then navigates to `ROUTES.PASSKEY_ENROLL` when `passkey_required`, otherwise to the redirect or home.
- [ ] T027 [US1] Create `app-turistear/src/features/auth/components/EmailCodeForm.tsx`: an email step ("Recibir código"), then a 6-digit code step with `inputmode="numeric"` and `autocomplete="one-time-code"`, "Reenviar código" disabled until `Retry-After` elapses, and errors keyed on `code`. Then create `app-turistear/src/features/auth/components/SignInScreen.tsx`, which hosts `EmailCodeForm` (US2 adds the passkey button above it). Render `SignInScreen` in `app-turistear/src/pages/LoginPage.tsx` in place of `LoginForm`, keeping the `reason=suspended` notice.
- [ ] T028 [US1] Write `app-turistear/src/features/auth/components/EmailCodeForm.test.tsx`, citing `passkey-auth US1`: request, verify, `OTP_INVALID` message, `OTP_RATE_LIMITED` countdown, `OTP_DELIVERY_FAILED` message, and `expectNoA11yViolations`. Update `app-turistear/src/services/authService.test.ts` for the new calls and the enrollment interceptor.

**Checkpoint**: US1 works end to end locally (quickstart § 4, steps 1–2) on a browser without WebAuthn.

---

## Phase 4: User Story 2 — create a llave de acceso and sign in with it (P1) 🎯 MVP part 2

**Goal**: passkeys are the sign-in. Creating one is mandatory after any email-code sign-in from a capable device.

**Independent Test**: sign in by code → forced to the creation step → create → sign out → sign in with the passkey and no email. A dev passkey is not recognized by another environment's `rpID`.

- [ ] T029 [P] [US2] Add `passkeySignInVerifySchema` (`response`: a record) and `passkeyRegisterVerifySchema` (`response`: a record, `name`: optional, trimmed, 1–60 characters) to `api-turistear/src/routes/auth/schema.ts`.
- [ ] T030 [P] [US2] Add `sendPasskeyNoticeEmail(env, { to, name, action: 'added' | 'removed', passkeyName })` to `api-turistear/src/services/resend.ts`, in es-MX copy (FR-041).
- [ ] T031 [US2] In `api-turistear/src/routes/auth/handler.ts`, add `passkeySignInOptions` and `passkeySignInVerify` (D8, D10, FR-001, FR-004):
  - `passkeySignInOptions` calls `auth.api.generatePasskeyAuthenticationOptions` with `returnHeaders` and forwards the challenge cookie.
  - `passkeySignInVerify` calls `auth.api.verifyPasskeyAuthentication` with `returnHeaders`. On success it sets `passkeys.last_used_at = unixepoch()` where `credential_id = body.response.id`, and revokes the request's previous same-user session. It answers `{ user, session: { passkey_required: false } }`.
- [ ] T032 [US2] In `api-turistear/src/routes/auth/handler.ts`, add `passkeyRegisterOptions` and `passkeyRegisterVerify` (D8, D10, FR-005, FR-041):
  - **`passkeyRegisterOptions`**:
    - refuses with `PASSKEY_LIMIT_REACHED` when the user has 10 passkeys;
    - unless `c.var.session.passkeyRequired`, refuses with `REAUTH_REQUIRED` when `now − authenticatedAt > 900 s`;
    - calls `auth.api.generatePasskeyRegistrationOptions` with the request headers and forwards the challenge cookie.
  - **`passkeyRegisterVerify`** calls `auth.api.verifyPasskeyRegistration`, then sets `passkey_required = 0` on `c.var.session.id`. It sends the "added" notice under `c.executionCtx.waitUntil` with failures caught (constitution VIII), and answers `201 { passkey }`.
- [ ] T033 [US2] Wire the passkey routes in `api-turistear/src/routes/auth/index.ts`:
  - `POST /passkeys/sign-in/options` and `/passkeys/sign-in/verify`, public;
  - `POST /passkeys/register/options` and `/passkeys/register/verify`, behind `authMiddlewareAllowingEnrollment`.

  Mount `POST /logout` behind no middleware (from T022).
- [ ] T034 [US2] Write `api-turistear/test/auth/passkeys.test.ts`, citing `passkey-auth US2`, using `test/helpers/authenticator.ts`. It covers:
  - register, then a discoverable sign-in with no email;
  - user verification missing at registration or at sign-in → `401 PASSKEY_VERIFICATION_FAILED`;
  - a replayed or lowered counter → `401 PASSKEY_VERIFICATION_FAILED`;
  - a removed credential → `401 PASSKEY_NOT_RECOGNIZED`;
  - an assertion for another `rpID` or origin → `401` (FR-003);
  - the 11th registration → `409 PASSKEY_LIMIT_REACHED`;
  - `last_used_at` set after sign-in;
  - a suspended owner → `403` with no session row.
- [ ] T035 [US2] Write `api-turistear/test/auth/enrollment-gate.test.ts`, citing `passkey-auth US2 (scenarios 1, 4), FR-007, FR-009, SC-008`. It covers:
  - after an email-code sign-in with `passkey_support: 'available'`, only `/api/me`, `/passkeys/register/*` and `/logout` answer;
  - every other route → `403 PASSKEY_ENROLLMENT_REQUIRED`;
  - after registering, the same session reaches `/api/folios`;
  - with `passkey_support: 'none'`, no gate applies;
  - a registration outside enrollment with `authenticated_at` older than 15 minutes → `403 REAUTH_REQUIRED`.
- [ ] T036 [P] [US2] Add `passkeySignInOptions`, `passkeySignInVerify`, `passkeyRegisterOptions` and `passkeyRegisterVerify` to `app-turistear/src/services/authService.ts`, with their MSW handlers in `app-turistear/src/test/handlers/auth.ts`.
- [ ] T037 [US2] Create the hooks `usePasskeySignIn.ts` and `useCreatePasskey.ts` in `app-turistear/src/features/auth/hooks/` (D15):
  - `usePasskeySignIn` gets options, calls `startAuthentication({ optionsJSON, useBrowserAutofill })` from `@simplewebauthn/browser`, then verifies.
  - `useCreatePasskey` gets options, calls `startRegistration({ optionsJSON })`, then verifies.
  - Both map a user cancel (`NotAllowedError`) to a silent return (Story 2, scenario 8).
- [ ] T038 [US2] Create `app-turistear/src/features/auth/components/PasskeySignInButton.tsx` ("Entrar con llave de acceso", primary, 48 px) and add it above `EmailCodeForm` in `SignInScreen.tsx`. Enable conditional UI on the email input (`autocomplete="username webauthn"`) when `PublicKeyCredential.isConditionalMediationAvailable()` resolves true. Hide the button when `passkeySupport() === 'none'`.
- [ ] T039 [US2] Create the mandatory step `app-turistear/src/features/auth/components/PasskeyEnrollmentStep.tsx`, with the title "Crea tu llave de acceso", a short why, and the "Crear llave de acceso" and "Cerrar sesión" buttons, and no skip. Create `app-turistear/src/pages/PasskeyEnrollPage.tsx` (`AuthLayout`). Add `PASSKEY_ENROLL: '/crear-llave'` to `app-turistear/src/config/routes.ts` and its route in `app-turistear/src/App.tsx`. In `app-turistear/src/features/auth/components/AuthGuard.tsx`, send any `me.session.passkey_required` session to it (FR-007).
- [ ] T040 [US2] Write `app-turistear/src/features/auth/components/PasskeyEnrollmentStep.test.tsx` and `PasskeySignInButton.test.tsx`, citing `passkey-auth US2`. Mock `@simplewebauthn/browser` at the module boundary (R13). They cover: success navigates home; a cancel stays silent; a `PASSKEY_NOT_RECOGNIZED` message offers the code; the enrollment page has no skip; and `expectNoA11yViolations`.

**Checkpoint**: MVP. US1 + US2 replace password sign-in completely (quickstart § 4, steps 1–4).

---

## Phase 5: User Story 3 — a new admin registers without a password (P2)

**Goal**: an organization signs up with name, email, company and phone; the code verifies it, then enrollment follows.

**Independent Test**: a new email registers, confirms the code, creates a passkey and lands as the admin of a new organization that has the D17 default policy.

- [ ] T041 [US3] In `api-turistear/src/routes/auth/schema.ts`, drop `password` from `registerSchema` and lowercase `email`. In `api-turistear/src/routes/auth/handler.ts`, rewrite `register`:
  - write the organization (`cancellationPolicy: DEFAULT_CANCELLATION_POLICY`) and the `unverified` admin, with `passwordHash` and `passwordSalt` set to `''` (D16), in one `db.batch`;
  - then `await issueSignInCode(c, email)`;
  - answer `201`;
  - drop `hashPassword`, `initiateMagicLink` and `sendMagicLinkEmail` (D11).
- [ ] T042 [US3] Write `api-turistear/test/auth/registration.test.ts`, citing `passkey-auth US3`, covering Story 3, scenarios 1–4:
  - no password field is accepted or needed;
  - the code arrives;
  - verifying it activates the admin, which then hits the enrollment gate;
  - the organization has its cancellation policy;
  - a duplicate email → `409 EMAIL_ALREADY_EXISTS`;
  - a mixed-case email is stored lowercased.
- [ ] T043 [P] [US3] In `app-turistear/src/features/auth/components/RegisterForm.tsx`, `app-turistear/src/features/auth/hooks/useRegister.ts`, `app-turistear/src/features/auth/schemas.ts` and `app-turistear/src/pages/RegisterPage.tsx`, remove the password field and `PasswordStrength`. On 201, go to the code step of `SignInScreen` with the email prefilled. Update `RegisterForm`'s test, or create `RegisterForm.test.tsx` citing `passkey-auth US3`, with axe.

---

## Phase 6: User Story 4 — an invited agent joins without a password (P2)

**Goal**: invitation completion takes a name and leads to the same enrollment step.

**Independent Test**: an admin invites. The agent opens the link, enters a name, creates a passkey and is signed in, and the invitation is accepted.

- [ ] T044 [US4] In `api-turistear/src/routes/agents/schema.ts`, lowercase the invited email (R11). In `api-turistear/src/routes/auth/schema.ts`, change `completeInviteSchema` to `{ token, name, passkey_support }`. In `api-turistear/src/routes/auth/handler.ts`, rewrite `completeInvite` (D12, FR-031):
  - write the agent (`active`, `emailVerified: true`, password columns `''`) and mark the invitation `accepted`, in one `db.batch`;
  - refuse with `409 EMAIL_ALREADY_EXISTS` when the address now has an account;
  - call `auth.api.issueInvitationSession({ body: { userId, passkeyRequired: passkey_support !== 'none' }, returnHeaders: true })`;
  - forward its cookies and answer `{ user, session }`;
  - drop `hashPassword` and `verifyPassword`.
- [ ] T045 [US4] Write `api-turistear/test/auth/invitation.test.ts`, citing `passkey-auth US4`, which replaces `test/auth/agent-invitation.test.ts`. It restates scenarios 1–8 (invite, `401`/`403` guards, `IDENTITY_ALREADY_EXISTS`, previous-invite invalidation, accept lookup) on `sessionCookie`, and adds Story 4, scenarios 1–4:
  - completion signs in with `passkey_required` set;
  - `passkey_support: 'none'` → no gate;
  - an invitation created before migration 0070's lowercasing still resolves;
  - a used or expired token → `400 INVALID_TOKEN`.
- [ ] T046 [P] [US4] In `app-turistear/src/features/auth/components/InviteCompleteForm.tsx`, `app-turistear/src/features/auth/hooks/useInviteComplete.ts` and `app-turistear/src/pages/InviteAcceptPage.tsx`, remove the password field. Send `passkey_support`, and on success go to `ROUTES.PASSKEY_ENROLL`, or home with the "crea tu llave desde un navegador completo" note when the support is `none` (Story 4, scenario 2). Update `authService` and the MSW handler, and add a component test citing `passkey-auth US4`, with axe.

---

## Phase 7: User Story 5 — manage my llaves de acceso and sessions (P2)

**Goal**: list, rename and remove passkeys (never the last one), and sign out of every device.

**Independent Test**: with two passkeys, remove one: it no longer signs in, the other does, and a notice is sent. Removing the last one is refused. "Cerrar sesión en todos los dispositivos" ends another browser's session.

- [ ] T047 [US5] In `api-turistear/src/routes/auth/handler.ts` and `schema.ts`, add four handlers (D8, D10, FR-005, FR-008, FR-024, FR-040, FR-041):
  - **`listPasskeys`**: our own `SELECT … WHERE user_id = ? ORDER BY created_at DESC`, answering contracts/api.md's `Passkey` shape.
  - **`renamePasskey`**: `UPDATE … WHERE id = ? AND user_id = ? RETURNING`, with `404 NOT_FOUND` when no row returns.
  - **`deletePasskey`**: `REAUTH_REQUIRED` when `now − authenticatedAt > 900 s`, then the guarded `DELETE … AND (SELECT COUNT(*) …) > 1 RETURNING id`. When no row returns, distinguish `404` (not the user's) from `409 PASSKEY_LAST_ONE`. Send the "removed" notice under `waitUntil`.
  - **`revokeAllSessions`**: `auth.api.revokeSessions` with `returnHeaders`, then expire the cookie.
- [ ] T048 [US5] Wire `GET /api/auth/passkeys`, `PATCH /api/auth/passkeys/:id`, `DELETE /api/auth/passkeys/:id` and `POST /api/auth/sessions/revoke-all` behind `authMiddleware` in `api-turistear/src/routes/auth/index.ts`.
- [ ] T049 [US5] Write `api-turistear/test/auth/passkey-management.test.ts`, citing `passkey-auth US5`, covering Story 5, scenarios 1–6:
  - list order and fields;
  - rename, and another user's id → `404`;
  - delete with stale `authenticated_at` → `REAUTH_REQUIRED`;
  - delete one of two → `200`, and the removed one no longer signs in;
  - delete the last → `409 PASSKEY_LAST_ONE`;
  - two parallel deletes of a user's two passkeys leave exactly one (D10);
  - revoke-all ends a second session at its next request;
  - the notice email is sent, and its failure does not undo the change.
- [ ] T050 [P] [US5] Add `listPasskeys`, `renamePasskey`, `deletePasskey` and `revokeAllSessions` to `app-turistear/src/services/authService.ts`, with their MSW handlers, and the hooks `usePasskeys.ts`, `useRenamePasskey.ts`, `useDeletePasskey.ts` and `useRevokeAllSessions.ts` in `app-turistear/src/features/auth/hooks/`. A `REAUTH_REQUIRED` answer reruns `usePasskeySignIn`, then retries once (D8).
- [ ] T051 [US5] Create the security surface in `app-turistear/src/features/auth/components/` and `app-turistear/src/pages/SecurityPage.tsx`:
  - `app-turistear/src/features/auth/components/PasskeyList.tsx`: `SectionCard` rows with the name, "Creada", "Último uso" and a synced/key icon paired with text;
  - `RenamePasskeySheet.tsx` (`FormSheet`);
  - `RemovePasskeySheet.tsx` (`ConfirmSheet`, which explains the last one cannot be removed);
  - `SignOutEverywhereSheet.tsx` (`ConfirmSheet`);
  - `app-turistear/src/pages/SecurityPage.tsx`, with "Agregar llave de acceso" through `useCreatePasskey`.

  Add `SECURITY: '/seguridad'` to `app-turistear/src/config/routes.ts` and its route in `app-turistear/src/App.tsx` (both roles), and a "Seguridad" entry in `app-turistear/src/layout/AccountMenu.tsx`.
- [ ] T052 [US5] Write `PasskeyList.test.tsx`, `RemovePasskeySheet.test.tsx` and `SignOutEverywhereSheet.test.tsx` in `app-turistear/src/features/auth/components/`, citing `passkey-auth US5`: rename, remove, the last-one refusal message, revoke-all, and `expectNoA11yViolations`. Test the components, never `SecurityPage` itself (constitution VI: no tests of `pages/`).

---

## Phase 8: User Story 6 — an admin restores an agent's access (P3)

**Goal**: a lost phone is cut off in one action, scoped to the admin's organization.

**Independent Test**: the admin restores access. The agent's session and passkey stop working. Another organization's admin gets `404`.

- [ ] T053 [P] [US6] Add `sendAccessRestoredEmail(env, { to, name })` to `api-turistear/src/services/resend.ts`, in es-MX copy explaining that access was reset and that the agent must sign in with a code (FR-041).
- [ ] T054 [US6] Add `restoreAgentAccess` to `api-turistear/src/routes/agents/handler.ts`, and `POST /:id/restore-access` to `api-turistear/src/routes/agents/index.ts`, behind the router's existing `authMiddleware` and `requireRole('admin')` (D13, FR-042, constitution III):
  - look up the agent by `id`, `organization_id = c.var.user.organizationId` and `role = 'agent'`, with `404` when absent;
  - in one `db.batch`, delete its `passkeys` and `sessions`;
  - send the notice under `waitUntil`;
  - answer 200.
- [ ] T055 [US6] Write `api-turistear/test/auth/restore-access.test.ts`, citing `passkey-auth US6`, built on `seedTwoOrgs`. It covers:
  - org A's admin restores org A's agent: the agent's next request → `401`, its passkey → `401 PASSKEY_NOT_RECOGNIZED`, and a notice is sent;
  - org B's admin on the same id → `404`, with nothing deleted;
  - an agent caller → `403 FORBIDDEN`;
  - an admin's id → `404`.
- [ ] T056 [P] [US6] Add `restoreAgentAccess(id)` to `app-turistear/src/services/agentsService.ts` (with an MSW handler), `app-turistear/src/features/agents/hooks/useRestoreAgentAccess.ts`, and `app-turistear/src/features/agents/components/RestoreAccessSheet.tsx` (`ConfirmSheet`: "¿Restablecer el acceso de <nombre>?", explaining that their llaves de acceso and sessions end). Open it from `app-turistear/src/features/agents/components/AgentRow.tsx`, and add a component test citing `passkey-auth US6`, with axe.

---

## Phase 9: Retirement, migration of tooling, and polish

**Purpose**: Agnostic Auth and passwords leave the code (D14). Tooling, docs and the constitution follow.

- [ ] T057 [P] Delete the password and Agnostic Auth leftovers under `api-turistear/src/` (D14, FR-060):
  - `api-turistear/src/services/agnosticAuth.ts`, `api-turistear/src/utils/jwt.ts` and `api-turistear/src/utils/cookies.ts`;
  - the `login`, `verify`, `forgotPassword` and `resetPassword` handlers, schemas and routes in `api-turistear/src/routes/auth/{handler,schema,index}.ts`;
  - `sendMagicLinkEmail` and `sendPasswordResetEmail` in `api-turistear/src/services/resend.ts`;
  - `INVALID_CREDENTIALS` and `EMAIL_NOT_VERIFIED` from `api-turistear/src/types/errors.ts` (FR-071);
  - the `passwordResetTokens` mapping in `api-turistear/src/db/schema.ts`. Add a comment there naming `password_hash`, `password_salt` and `password_reset_tokens` as dropped by the follow-up (D16).
- [ ] T058 [P] Delete the password files under `app-turistear/src/` (D15, FR-060):
  - `LoginForm.tsx`, `PasswordInput.tsx`, `PasswordStrength.tsx`, `ForgotPasswordForm.tsx` and `ResetPasswordForm.tsx` in `app-turistear/src/features/auth/components/`;
  - `useLogin.ts`, `useForgotPassword.ts`, `useResetPassword.ts` and `useVerify.ts` in `app-turistear/src/features/auth/hooks/`;
  - `VerifyPage.tsx`, `ForgotPasswordPage.tsx` and `ResetPasswordPage.tsx` in `app-turistear/src/pages/`;
  - the password schemas in `app-turistear/src/features/auth/schemas.ts`, and their tests;
  - `login`, `verify`, `forgotPassword` and `resetPassword` from `app-turistear/src/services/authService.ts`;
  - the exports in `app-turistear/src/features/auth/index.ts`.
- [ ] T059 Create `app-turistear/src/pages/LegacyLinkPage.tsx` and its component `app-turistear/src/features/auth/components/LegacyLinkNotice.tsx`. The notice says: "Ya no usamos contraseñas. Entra con tu llave de acceso o con un código por correo.", with a button to `ROUTES.LOGIN`. Route `ROUTES.VERIFY`, `ROUTES.FORGOT_PASSWORD` and `ROUTES.RESET_PASSWORD` to it in `app-turistear/src/App.tsx` (FR-063). Add a component test citing `passkey-auth FR-063`, with axe.
- [ ] T060 Remove Agnostic Auth from `api-turistear/wrangler.jsonc`, `api-turistear/vitest.config.ts`, `api-turistear/src/bindings.d.ts` and `api-turistear/.dev.vars.example` (FR-062, SC-003):
  - In `api-turistear/wrangler.jsonc`, remove the `AGNOSTIC_AUTH_API` service binding, `AGNOSTIC_AUTH_APP_ID` and any `DEV_AUTH_SERVICE_URL` mention from all three profiles, and delete the "Shared auth realm" comment.
  - Remove `serviceBindings.AGNOSTIC_AUTH_API` and `DEV_AUTH_SERVICE_URL` from `api-turistear/vitest.config.ts`.
  - Remove the same keys from `api-turistear/src/bindings.d.ts` and `api-turistear/.dev.vars.example`.
  - Run `pnpm cf-typegen:api`.
- [ ] T061 Delete `api-turistear/test/helpers/jwt.ts` and the replaced suites in `api-turistear/test/auth/`: `admin-login-session.test.ts`, `admin-registration.test.ts`, `agent-invitation.test.ts` and `password-recovery.test.ts`. research.md § Withdrawn scenarios records where each went.
- [ ] T062 [P] Rewrite `api-turistear/scripts/seed-local.mjs` (SC-011):
  - drop the agnostic-auth hashing and the password argument;
  - insert users with `password_hash` and `password_salt` set to `''` and `email_verified = 1`;
  - print "Entra en http://localhost:5174/login con <email>; el código aparece en la consola del API".
- [ ] T063 [P] Move end-to-end sign-in to the virtual authenticator in `app-turistear/e2e/setup/auth.setup.ts` (D18, R13):
  - In `app-turistear/e2e/setup/auth.setup.ts`, sign in each account through the browser with a CDP `WebAuthn.addVirtualAuthenticator` and `WebAuthn.addCredential`, using `E2E_AGENT_PASSKEY` and `E2E_ADMIN_PASSKEY` (JSON: `credentialId`, `privateKey`, `userHandle`, `rpId`), then save `storageState`.
  - Add `app-turistear/e2e/enroll-passkey.ts`, which the developer runs once per account against dev to enroll and print the secret.
  - Update `app-turistear/e2e/README.md` and `.github/workflows/e2e.yml`, replacing the `E2E_*_PASSWORD` secrets with `E2E_*_PASSKEY`.
- [ ] T064 Amend the constitution with `/speckit-constitution` (v1.1.0 → v1.2.0, MINOR) exactly as plan D19 lists:
  - Principle IV: the cookie name and issuer;
  - Principle VI: the stand-in and the pinned secret;
  - Principle VIII: Agnostic Auth out, and Resend on the recovery path;
  - the stack table: the "Auth" row (Better Auth with its passkey and email-OTP plugins) and the "Runtime" row (`nodejs_als`).
- [ ] T065 [P] Update `CLAUDE.md`. Replace the "Running the app locally" caveat (`.dev.vars`, cookie domain, external auth worker) with: the local sign-in is an email code printed in the API console, then a passkey on `localhost`. Change the Agnostic Auth mention under `docs/integrations/` to say it is historical (D19, SC-011).
- [ ] T066 Register debt `password-material` with `/speckit-debt-log`: `users.password_hash`, `users.password_salt` and `password_reset_tokens` remain in D1 unread. Paying it means the next deploy's migration 0071 drops them (D16, spec FR-061 and SC-006).
- [ ] T067 Run the proof in `specs/003-passkey-auth/quickstart.md` § 5:
  - `pnpm test:api`, `pnpm test:app`, `pnpm lint:app`, `pnpm build:api` and `pnpm build:app` are all green;
  - the scope-boundary `git diff --stat` shows only the session lines in the 65 business suites;
  - `git grep -nIE "AGNOSTIC_AUTH|agnosticAuth|Agnostic Auth|DEV_AUTH_SERVICE_URL" -- api-turistear app-turistear .github` is empty, apart from archive citations;
  - `/speckit-analyze` reports no CRITICAL finding.

---

## Dependencies & Execution Order

### Phase dependencies

| Phase | Depends on | Notes |
|---|---|---|
| Setup (T001–T005) | nothing | T003–T005 are parallel after T001 and T002 |
| Foundational (T006–T017) | Setup | Blocks every story. Ship it together with US1, because the old login stops producing a usable session at T011 |
| US1 (T018–T028) | Foundational | |
| US2 (T029–T040) | Foundational | API work is independent of US1. The app's `SignInScreen` (T038) builds on T027. US1 + US2 is the MVP |
| US3 (T041–T043) | US1 (`issueSignInCode`) | |
| US4 (T044–T046) | Foundational (plugin T008); its app redirect uses US2's enrollment page (T039) | |
| US5 (T047–T052) | US2 (passkeys exist, `useCreatePasskey`, `usePasskeySignIn`) | |
| US6 (T053–T056) | Foundational | Independent of the other stories |
| Retirement & polish (T057–T067) | every story | T057 needs US1, US3 and US4 to have replaced the old handlers. T061 needs T045 and the US1–US5 suites |

### Within each story

1. Schemas and email templates ([P])
2. Handlers
3. Routes
4. API tests
5. App service and MSW ([P] with the API work)
6. Hooks
7. Components and pages
8. Component tests

### Parallel opportunities

- **Setup**: T003, T004 and T005.
- **Foundational**: T010, T013 and T016 alongside T008 and T009. T015 (the codemod) runs as soon as T014 exists.
- **US1**: T018, T019, T024 and T025 together. The app track (T024–T028) runs in parallel with the API track (T018–T023).
- **US2**: T029, T030 and T036 together, then the API (T031–T035) and the app (T037–T040) as two tracks.
- **Across stories**: US6 (T053–T056) can run in parallel with US3, US4 and US5 once Foundational is done.
- **Retirement**: T057, T058, T062, T063 and T065 together.

### Parallel example: User Story 1

```text
Track API: T018 sendSignInCodeEmail ─┐
           T019 schemas ─────────────┴─▶ T020 issueSignInCode ─▶ T021 verifyEmailCode + logout ─▶ T022 routes ─▶ T023 email-code.test.ts
Track app: T024 authService + MSW ─┐
           T025 passkeySupport ────┴─▶ T026 hooks ─▶ T027 EmailCodeForm + SignInScreen ─▶ T028 tests
```

### Parallel example: User Story 2

```text
Track API: T029 schemas, T030 notice email ─▶ T031 sign-in ─▶ T032 register ─▶ T033 routes ─▶ T034 + T035 tests
Track app: T036 authService + MSW ─▶ T037 hooks ─▶ T038 button + T039 enrollment page ─▶ T040 tests
```

---

## Implementation Strategy

### MVP first (US1 + US2)

1. Phase 1, then Phase 2. The harness and the business-suite codemod are in place, so `pnpm test:api` passes outside `test/auth`.
2. US1. Every user can sign in by code. **Do not deploy here**: a capable device would be told to enroll, with no enrollment yet.
3. US2. Passkeys and the mandatory step. **This is the MVP**: quickstart § 4 runs end to end.

### Incremental delivery

4. US3 and US4: new organizations and new agents, without passwords.
5. US5: self-service security.
6. US6: the admin's restore.
7. Phase 9: retire Agnostic Auth and passwords, amend the constitution, and run the full proof.

All of it ships as **one pull request** into `develop` (CLAUDE.md § Local workflow). Cutover follows
quickstart § 6. The column drop is the next PR (T066, D16).

### Notes

- Never edit a business assertion to get green. If a business suite fails after T015, the
  middleware contract (T011) is wrong, not the test.
- Commit after each task or logical group, with Conventional Commits scoped `auth`
  (`feat(auth): …`), or `agents` for US6.
- Stop at any checkpoint to validate the story on its own.
