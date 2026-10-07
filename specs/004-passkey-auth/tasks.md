---

description: "Task list for passkey sign-in with email code backup, on Better Auth's standards"
---

# Tasks: Passkey Sign-In with Email Code Backup

**Input**: Design documents from `specs/004-passkey-auth/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/api.md, quickstart.md

**Tests**: required by constitution VI.
- API rules are proven in workerd against a real D1 and a real Better Auth (D17).
- The app proves its screens with MSW serving Better Auth's endpoints, plus axe.
- Every new test file opens by citing `passkey-auth US<n>`.
- Every non-obvious rule in code cites `passkey-auth D<n>`.

**Feature-wide rules**:
- Better Auth is configured, never wrapped (D2).
- Copy is es-MX: "llave de acceso" and "código por correo".
- Edits and confirmations use `FormSheet` and `ConfirmSheet`.
- Emails are lowercased at our edge (R11).
- Glossary: the "offer" is the dismissible "Crear llave de acceso" step after an email-code sign-in.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an unfinished task)
- **[Story]**: the spec's user story the task serves (US1–US5)

---

## Phase 1: Setup (shared infrastructure)

- [ ] T001 Add the dependencies (D1, R1), then run `pnpm install` so `pnpm-lock.yaml` updates:
  - `api-turistear/package.json`: `better-auth`, `@better-auth/passkey` and `@better-auth/drizzle-adapter`, each at exactly `1.7.7` (no caret), plus dev dependency `@noble/hashes` `^2.2.0`.
  - `app-turistear/package.json`: `better-auth` and `@better-auth/passkey`, each at exactly `1.7.7`.
- [ ] T002 In `api-turistear/wrangler.jsonc`:
  - add `"compatibility_flags": ["nodejs_als"]` at the top level, which named environments inherit (D3, R3);
  - add `AUTH_COOKIE_PREFIX` to each profile's `vars`: `gm-local` (top level), `gm-dev` (`env.dev`), `gm` (`env.production`) (D5);
  - add `OTP_LOG_TO_CONSOLE: "true"` to the top-level (local) profile only (D7, FR-064).

  Do not remove the Agnostic Auth binding yet; T039 does.
- [ ] T003 [P] Document local setup in `api-turistear/.dev.vars.example`:
  - add `BETTER_AUTH_SECRET=<32+ random chars>`, with a comment that it is a Worker secret in dev and prod, different in each environment;
  - note that `APP_BASE_URL` must stay `http://localhost:5174`, because the llave de acceso's domain comes from it (D8, SC-011).

  Run `pnpm cf-typegen:api` so `api-turistear/worker-configuration.d.ts` gains `BETTER_AUTH_SECRET`, `AUTH_COOKIE_PREFIX` and `OTP_LOG_TO_CONSOLE`, and mirror them in `api-turistear/src/bindings.d.ts`.
- [ ] T004 [P] In `api-turistear/vitest.config.ts`, pin these miniflare bindings, so `.dev.vars` never leaks into a suite (constitution VI):
  - `BETTER_AUTH_SECRET: 'test_better_auth_secret_0123456789abcdef'`
  - `AUTH_COOKIE_PREFIX: 'gm-test'`
  - `COOKIE_DOMAIN: ''`
  - `OTP_LOG_TO_CONSOLE: ''`
- [ ] T005 [P] In the CORS middleware of `api-turistear/src/index.tsx`, add `exposeHeaders: ['X-Retry-After']`, so the app can read Better Auth's rate-limit wait (D9, FR-012).

---

## Phase 2: Foundational (blocking prerequisites)

**⚠️ Note**: T010 unmounts the old password routes and T011 stops reading `gm_access`. From there,
sign-in works only through Better Auth, so land Phase 2 together with US1.

- [ ] T006 Write `api-turistear/migrations/0071_better_auth.sql` (D16; use the next free number if `develop` has moved). Follow data-model.md exactly:
  - the tables `sessions`, `accounts`, `verifications`, `passkeys` and `rate_limits`, with `ON DELETE CASCADE` on every `user_id`, and their indexes;
  - `users.email_verified INTEGER NOT NULL DEFAULT 0`, backfilled to 1 where `status = 'active'`, and `users.image TEXT`;
  - `UPDATE users SET email = lower(email)` and `UPDATE invitations SET identity = lower(identity)`;
  - a header comment stating each child table's transitive scope (constitution III).

  Do not touch the password columns (D15).
- [ ] T007 In `api-turistear/src/db/schema.ts`:
  - add Drizzle tables `sessions`, `accounts`, `verifications`, `passkeys` and `rateLimits`, with snake_case columns, `integer(..., { mode: 'timestamp' })` timestamps and `rate_limits.last_request` as a plain integer (milliseconds);
  - add `emailVerified` (`integer({ mode: 'boolean' })`) and `image` to `users`.

  Export the types (D4).
- [ ] T008 [P] Add two senders to `api-turistear/src/services/resend.ts` (D7, D12):
  - `sendSignInCodeEmail(env, { to, code })`, in es-MX copy: the code, "vence en 5 minutos", and "Turistear Ya! nunca te pedirá este código por teléfono ni WhatsApp" (FR-014). When `env.OTP_LOG_TO_CONSOLE === 'true'` it logs `[otp] <email> <code>` and sends nothing (FR-064).
  - `sendPasskeyNoticeEmail(env, { to, action: 'added' | 'removed' })` (FR-041).
- [ ] T009 Create `api-turistear/src/auth/index.ts`, exporting `getAuth(env)` memoized in a `WeakMap<CloudflareBindings, Auth>`. Configure `betterAuth` with:
  - **Database (D3, D4)**: `database: drizzleAdapter(getDb(env), { provider: 'sqlite', schema, transaction: false })`, with `modelName` and snake_case `fields` for `user`→`users`, `session`→`sessions`, `account`→`accounts` and `verification`→`verifications`. `user.additionalFields` for `organizationId`, `role`, `status`, `phone` and `plan`, all with `input: false` (D2, constitution III).
  - **Core**: `secret: env.BETTER_AUTH_SECRET`, `baseURL: env.API_BASE_URL`, `basePath: '/api/auth'`, `trustedOrigins: [env.APP_BASE_URL]` and `telemetry: { enabled: false }`.
  - **`advanced` (D5, D7)**: `{ database: { generateId: 'uuid' }, useSecureCookies: true, cookiePrefix: env.AUTH_COOKIE_PREFIX, crossSubDomainCookies: { enabled: !!env.COOKIE_DOMAIN, domain: env.COOKIE_DOMAIN }, ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] }, backgroundTasks: { handler: waitUntil } }`, with `waitUntil` imported from `cloudflare:workers`.
  - **Sessions (D5)**: leave Better Auth's defaults; no `cookieCache`.
  - **Rate limit (D9)**: `rateLimit: { enabled: true, storage: 'database', modelName: 'rate_limits', fields: { lastRequest: 'last_request' } }`.
  - **Email codes (D7)**: `emailOTP({ disableSignUp: true, storeOTP: 'encrypted', sendVerificationOTP: ({ email, otp }) => sendSignInCodeEmail(env, { to: email, code: otp }) })`, keeping its default length, expiry and attempts.
  - **Passkeys (D8)**: `passkey({ rpID: new URL(env.APP_BASE_URL).hostname, rpName: 'Turistear Ya!', origin: env.APP_BASE_URL, authenticatorSelection: { residentKey: 'required', userVerification: 'required' }, schema })`, mapping `passkey`→`passkeys` in snake_case.
  - **Session-create hook (D6, R5)**: `databaseHooks.session.create.before` loads the user. It **throws** `APIError.from('FORBIDDEN', { code: 'ACCOUNT_SUSPENDED', message: 'Account suspended' })` when the user is suspended. When `status === 'unverified'`, it sets `status = 'active'` (FR-015).
  - **Notices (D12)**: `hooks.after = createAuthMiddleware(...)`. On `/passkey/verify-registration` or `/passkey/delete-passkey` with a successful result, it sends `sendPasskeyNoticeEmail` in the background, with errors caught (constitution VIII).

  Email-and-password stays disabled; `user.changeEmail` and `user.deleteUser` stay at their disabled defaults.
- [ ] T010 In `api-turistear/src/index.tsx`:
  - replace `app.route('/api/auth', authRouter)` with `app.on(['GET', 'POST'], '/api/auth/*', (c) => getAuth(c.env).handler(c.req.raw))` (D2);
  - keep `GET /api/me` behind `authMiddleware`.
- [ ] T011 Rewrite `api-turistear/src/middleware/auth.ts` (D6):
  - read the session with `getAuth(c.env).api.getSession({ headers: c.req.raw.headers, returnHeaders: true })` and append its `Set-Cookie` headers to the response;
  - no session → `401 UNAUTHORIZED`;
  - `status === 'suspended'` → `403 ACCOUNT_SUSPENDED`;
  - otherwise set `c.var.user` to today's `UserPayload`.

  Drop every import of `utils/jwt.ts`, `utils/cookies.ts` and `services/agnosticAuth.ts`.
- [ ] T012 Build the test harness in `api-turistear/test/helpers/apply-migrations.ts` and `api-turistear/test/helpers/session.ts` (D17, R12):
  - The setup file, after migrations, installs `CREATE TRIGGER test_user_session AFTER INSERT ON users BEGIN INSERT INTO sessions (id, user_id, token, expires_at, created_at, updated_at) VALUES (lower(hex(randomblob(16))), NEW.id, 'test-session-' || NEW.email, unixepoch() + 31536000, unixepoch(), unixepoch()); END`.
  - `session.ts` exports a synchronous `sessionCookie(email)`. It returns `__Secure-gm-test.session_token=` followed by `encodeURIComponent(token + '.' + base64(hmac(sha256, secret, token)))`, using `@noble/hashes`, and pairs it with a `sessionCookieFor(token)` variant.
- [ ] T013 Mechanically switch the 61 business suites, meaning every file under `api-turistear/test/` outside `test/auth/` and `test/helpers/` that imports `buildFakeJwt`:
  - change the import to `import { sessionCookie } from '../helpers/session'`;
  - replace `gm_access=${buildFakeJwt(x)}` with `${sessionCookie(x)}`;
  - drop the Agnostic Auth `/auth/refresh` stub from `api-turistear/test/staff/staff-management.test.ts`.

  Edit nothing else, and verify with `git diff --stat` (spec § Scope Boundary).
- [ ] T014 [P] Create `api-turistear/test/helpers/authenticator.ts`, a WebCrypto ECDSA P-256 software authenticator (R13):
  - `createCredential(options, { userVerified, counter })` returns a `RegistrationResponseJSON` with a `none` attestation, rpIdHash, flags `UP|UV|AT` and a COSE EC2 key, plus `clientDataJSON` for the given origin.
  - `getAssertion(options, credential, { userVerified, counter, origin })` returns an ES256 `AuthenticationResponseJSON`.
- [ ] T015 Write `api-turistear/test/auth/sessions.test.ts`, citing `passkey-auth US1 (scenario 8), US5 (scenario 4), FR-020–FR-025, SC-005`. It covers:
  - a `sessionCookie` reaches `/api/folios`;
  - an altered signature, another secret, an unknown token and an expired row each answer `401`;
  - suspended → `403 ACCOUNT_SUSPENDED`;
  - a renewal after `updateAge` extends `expires_at` and keeps `token`;
  - 5 parallel requests during a renewal all answer 200 (BUG-014);
  - `POST /api/auth/sign-out` → the same cookie answers `401`;
  - `POST /api/auth/revoke-sessions` ends a second session;
  - `POST /api/auth/update-user` with `organizationId`, `role` or `status` changes none of them (D2, constitution III).

  Exclude `test-session-%` rows from any count.

**Checkpoint**: `pnpm test:api` is green outside the old `test/auth/*` password suites, which T040 deletes.

---

## Phase 3: User Story 1 — sign in with an email code (P1) 🎯 MVP part 1

**Goal**: every admin and agent signs in by a 6-digit code, with no password and no Agnostic Auth.

**Independent Test**: an active agent requests a code, enters it and reaches home. The session renews, and ends on sign-out.

- [ ] T016 [US1] Write `api-turistear/test/auth/email-code.test.ts`, citing `passkey-auth US1`, with Resend stubbed at its origin as `test/email/` does. It covers Story 1, scenarios 1–7:
  - unknown email → `{ success: true }` and no Resend call;
  - newest code wins;
  - after 5 minutes → `OTP_EXPIRED`;
  - the 4th try → `TOO_MANY_ATTEMPTS`;
  - `unverified` → `active` with `email_verified` set;
  - suspended → `403 ACCOUNT_SUSPENDED` and no session row (fixture rows excluded);
  - `verifications.value` does not contain the code (FR-016);
  - the email states the code and "5 minutos" (FR-014);
  - the 4th send within 60 s from one IP → `429` with `X-Retry-After` (FR-012);
  - the 4th `sign-in/email-otp` within 10 s from one IP → `429` with `X-Retry-After` (FR-012; Better Auth's `/sign-in*` rule, 3 per 10 s);
  - a successful `sign-in/email-otp` answers `{ token, user }`, with `user.email` and `user.name`: the shape `test/handlers/auth.ts` copies (constitution IV).
- [ ] T017 [P] [US1] Create `app-turistear/src/services/authClient.ts` with `createAuthClient` from `better-auth/react`, configured with `baseURL` (`VITE_API_BASE_URL || window.location.origin`), `basePath: '/api/auth'`, `plugins: [emailOTPClient(), passkeyClient()]` and `fetchOptions: { credentials: 'include' }` (D14). Create `app-turistear/src/test/handlers/auth.ts` with MSW handlers for `email-otp/send-verification-otp`, `sign-in/email-otp` and `sign-out`, mirroring contracts/api.md, and register them in `app-turistear/src/test/server.ts`. Fixtures copy only shapes asserted in T016, T021 and T032 (constitution IV).
- [ ] T018 [US1] Create `app-turistear/src/features/auth/hooks/useEmailCodeSignIn.ts`, with TanStack mutations over `authClient.emailOtp.sendVerificationOtp` and `authClient.signIn.emailOtp`. On success it invalidates `['me']` and navigates to the redirect or home, with the passkey offer flag set (US2). Rewrite `app-turistear/src/features/auth/hooks/useLogout.ts` to use `authClient.signOut()`.
- [ ] T019 [US1] Create `app-turistear/src/features/auth/components/EmailCodeForm.tsx`:
  - an email step ("Recibir código");
  - a 6-digit step with `inputmode="numeric"` and `autocomplete="one-time-code"`;
  - "Reenviar código" disabled for the `X-Retry-After` seconds;
  - messages keyed on Better Auth's codes: `INVALID_OTP`, `OTP_EXPIRED`, `TOO_MANY_ATTEMPTS`, `ACCOUNT_SUSPENDED` and `429`.

  Create `app-turistear/src/features/auth/components/SignInScreen.tsx` hosting it, and render it in `app-turistear/src/pages/LoginPage.tsx` in place of `LoginForm`, keeping the `reason=suspended` notice.
- [ ] T020 [US1] Write `app-turistear/src/features/auth/components/EmailCodeForm.test.tsx`, citing `passkey-auth US1`: request, sign-in, each error message, the retry countdown, and `expectNoA11yViolations`.

**Checkpoint**: quickstart § 3, steps 1–2.

---

## Phase 4: User Story 2 — create a llave de acceso and sign in with it (P1) 🎯 MVP part 2

**Goal**: passkeys are the everyday sign-in. They are offered after an email-code sign-in, and never forced.

**Independent Test**: sign in by code → accept the offer → create → sign out → sign in with the passkey and no email. A dev passkey is not recognized by another `rpID`.

- [ ] T021 [US2] Write `api-turistear/test/auth/passkeys.test.ts`, citing `passkey-auth US2`, using `test/helpers/authenticator.ts`. It covers:
  - registration on a session less than a day old → 200;
  - a session older than `freshAge` → `403 SESSION_NOT_FRESH` (FR-005);
  - a discoverable sign-in with no email → session cookie;
  - a removed credential → `401 PASSKEY_NOT_FOUND`;
  - a replayed or lowered counter → refused (FR-006);
  - an assertion for another origin or `rpID` → refused (FR-003);
  - a suspended owner → `403` with no session row;
  - `generate-authenticate-options` and `generate-register-options` answer the options shape MSW copies (`challenge`, `rpId`, `userVerification`), and `verify-authentication` answers `{ session, user }`.
- [ ] T022 [P] [US2] Add MSW handlers for `passkey/generate-authenticate-options`, `passkey/verify-authentication`, `passkey/generate-register-options` and `passkey/verify-registration` to `app-turistear/src/test/handlers/auth.ts`. Fixtures copy only shapes asserted in T016, T021 and T032 (constitution IV).
- [ ] T023 [US2] Create `app-turistear/src/features/auth/components/PasskeySignInButton.tsx` ("Entrar con llave de acceso", primary, 48 px). It calls `authClient.signIn.passkey()` and is placed above `EmailCodeForm` in `SignInScreen.tsx`. Enable conditional UI on the email input (`autocomplete="username webauthn"`, `signIn.passkey({ autoFill: true })`) when `PublicKeyCredential.isConditionalMediationAvailable()` resolves true. Hide it when `typeof PublicKeyCredential !== 'function'`. A user cancel returns silently, and `PASSKEY_NOT_FOUND` offers the email code.
- [ ] T024 [US2] Create `app-turistear/src/features/auth/components/PasskeyOffer.tsx`, the offer (FR-007, SC-008):
  - it opens in a `BottomSheet` after an email-code sign-in when `typeof PublicKeyCredential === 'function'`;
  - "Crear llave de acceso" calls `authClient.passkey.addPasskey()`; "Ahora no" closes it;
  - `SESSION_NOT_FRESH` asks the user to sign in again.

  Mount it from `app-turistear/src/layout/AppLayout.tsx` on the flag set by T018.
- [ ] T025 [US2] Write `app-turistear/src/features/auth/components/PasskeySignInButton.test.tsx` and `PasskeyOffer.test.tsx`, citing `passkey-auth US2`, with `navigator.credentials` mocked. They cover: success, cancel, "Ahora no", and `expectNoA11yViolations`.

**Checkpoint**: MVP. US1 + US2 replace password sign-in (quickstart § 3, steps 1–5).

---

## Phase 5: User Story 3 — a new admin registers without a password (P2)

**Goal**: an organization signs up with name, email, company and phone; the code verifies it and signs it in.

**Independent Test**: a new email registers, enters the code, and lands as the admin of a new organization that has the D17 policy.

- [ ] T026 [US3] Create `api-turistear/src/routes/onboarding/schema.ts` with `registerSchema` (name, email trimmed and lowercased, company_name, phone; no password). Create `api-turistear/src/routes/onboarding/handler.ts` with `register` (D10):
  - refuse a taken email with `409 EMAIL_ALREADY_EXISTS`;
  - in one `db.batch`, write the organization (`cancellationPolicy: DEFAULT_CANCELLATION_POLICY`) and its `unverified` admin, with `emailVerified: false` and password columns `''`;
  - run `await getAuth(c.env).api.sendVerificationOTP({ body: { email, type: 'sign-in' } })`;
  - answer `201`.

  Create `api-turistear/src/routes/onboarding/index.ts` with `POST /register` behind `zValidator`, and mount `/api/onboarding` in `api-turistear/src/index.tsx`.
- [ ] T027 [US3] Write `api-turistear/test/onboarding/register.test.ts`, citing `passkey-auth US3`, covering Story 3, scenarios 1–4:
  - no password is needed;
  - a code is sent;
  - `sign-in/email-otp` with it → admin verified, `active` and signed in;
  - the organization has its policy;
  - a duplicate → `409`;
  - a mixed-case email is stored lowercased.
- [ ] T028 [P] [US3] In `app-turistear/src/features/auth/components/RegisterForm.tsx`, `app-turistear/src/features/auth/hooks/useRegister.ts`, `app-turistear/src/features/auth/schemas.ts`, `app-turistear/src/services/authService.ts` (call `/api/onboarding/register`) and `app-turistear/src/pages/RegisterPage.tsx`:
  - remove the password field and `PasswordStrength`;
  - on 201, show `EmailCodeForm` at its code step with the email filled in.

  Add or update a `RegisterForm.test.tsx` citing `passkey-auth US3`, with axe and an MSW handler.

---

## Phase 6: User Story 4 — an invited agent joins without a password (P2)

**Goal**: invitation acceptance takes a name, sends a code, and signs the agent in.

**Independent Test**: an admin invites; the agent opens the link, enters a name and then the code, and is signed in. The invitation is accepted.

- [ ] T029 [US4] In `api-turistear/src/routes/agents/schema.ts`, lowercase the invited email (R11). In `api-turistear/src/routes/onboarding/{schema,handler,index}.ts`, add (D11):
  - **`GET /invitations/:token`**: today's lookup, moved from `routes/auth`, answering `{ invitation: { identity, identity_type, organization_name } }`.
  - **`POST /invitations/:token/accept {name}`**:
    - in one `db.batch`, write the agent (`active`, `emailVerified: true`, password columns `''`) and mark the invitation accepted;
    - refuse with `409 EMAIL_ALREADY_EXISTS` when the address now has an account;
    - send a sign-in code via `getAuth(c.env).api.sendVerificationOTP`;
    - answer `{ email }`.
- [ ] T030 [US4] Write `api-turistear/test/onboarding/invitations.test.ts`, citing `passkey-auth US4`. It restates the old `test/auth/agent-invitation.test.ts` scenarios 1–8 (`POST /api/agents/invite`, the `401`/`403` guards, `IDENTITY_ALREADY_EXISTS`, previous-invite invalidation, the lookup) on `sessionCookie`, and adds Story 4, scenarios 1–4:
  - accept → code → signed in as an agent of the organization;
  - an invitation created before migration 0071's lowercasing still resolves;
  - a used or expired token → `400 INVALID_TOKEN`.
- [ ] T031 [P] [US4] In `app-turistear/src/features/auth/components/InviteCompleteForm.tsx`, `app-turistear/src/features/auth/hooks/{useInviteAccept,useInviteComplete}.ts`, `app-turistear/src/services/authService.ts` (the `/api/onboarding/invitations/*` calls) and `app-turistear/src/pages/InviteAcceptPage.tsx`:
  - remove the password field;
  - on accept, show `EmailCodeForm` at its code step for the returned email.

  Update MSW, and add a component test citing `passkey-auth US4`, with axe.

---

## Phase 7: User Story 5 — manage my llaves de acceso and sessions (P2)

**Goal**: list, rename and remove passkeys, and sign out of every device, with notices.

**Independent Test**: with two passkeys, remove one: it no longer signs in, the other does, and a notice is sent. "Cerrar sesión en todos los dispositivos" ends another browser's session.

- [ ] T032 [US5] Write `api-turistear/test/auth/passkey-management.test.ts`, citing `passkey-auth US5`, covering Story 5, scenarios 1–5:
  - `list-user-passkeys` returns name and creation date;
  - with `seedTwoOrgs`, `update-passkey` and `delete-passkey` using the id of a passkey owned by the other organization's user are refused and change nothing (constitution III); the user's own is renamed;
  - `delete-passkey` removes it, after which it no longer signs in, and removing the last one is allowed;
  - add and delete each send a notice, and a Resend failure does not undo the change;
  - `revoke-sessions` ends a second session;
  - `list-user-passkeys` answers an array of `{ id, name, createdAt, deviceType, backedUp }`.
- [ ] T033 [P] [US5] Add MSW handlers for `passkey/list-user-passkeys`, `passkey/update-passkey`, `passkey/delete-passkey` and `revoke-sessions` to `app-turistear/src/test/handlers/auth.ts`. Fixtures copy only shapes asserted in T016, T021 and T032 (constitution IV).
- [ ] T034 [US5] Create the security surface in `app-turistear/src/features/auth/components/` and `app-turistear/src/pages/SecurityPage.tsx`:
  - **`PasskeyList.tsx`**: `SectionCard` rows with the name, "Creada <fecha>", and a synced or security-key icon paired with text.
  - **`RenamePasskeySheet.tsx`** (`FormSheet`).
  - **`RemovePasskeySheet.tsx`** (`ConfirmSheet`).
  - **`SignOutEverywhereSheet.tsx`** (`ConfirmSheet`), using `authClient.revokeSessions()`.
  - **"Agregar llave de acceso"**, which reuses `PasskeyOffer`'s add flow, including `SESSION_NOT_FRESH`.

  Add `SECURITY: '/seguridad'` to `app-turistear/src/config/routes.ts` and its route to `app-turistear/src/App.tsx` (both roles), and a "Seguridad" entry to `app-turistear/src/layout/AccountMenu.tsx`.
- [ ] T035 [US5] Write `PasskeyList.test.tsx`, `RemovePasskeySheet.test.tsx` and `SignOutEverywhereSheet.test.tsx` in `app-turistear/src/features/auth/components/`, citing `passkey-auth US5`: rename, remove, revoke-all, and `expectNoA11yViolations`. Test components, never `SecurityPage` (constitution VI).

---

## Phase 8: Retirement, tooling and polish

- [ ] T036 [P] Delete the password and Agnostic Auth code under `api-turistear/src/` (D13, FR-060, FR-071):
  - `services/agnosticAuth.ts`, `utils/jwt.ts`, `utils/cookies.ts` and the whole `routes/auth/` folder;
  - `sendMagicLinkEmail` and `sendPasswordResetEmail` from `services/resend.ts`;
  - `INVALID_CREDENTIALS` and `EMAIL_NOT_VERIFIED` from `types/errors.ts`;
  - the `passwordResetTokens` mapping from `db/schema.ts`. Add a comment naming `password_hash`, `password_salt` and `password_reset_tokens` as dropped by the follow-up (D15).
- [ ] T037 [P] Delete the password files under `app-turistear/src/` (D14, FR-060):
  - the components `LoginForm.tsx`, `PasswordInput.tsx`, `PasswordStrength.tsx`, `ForgotPasswordForm.tsx` and `ResetPasswordForm.tsx`;
  - the hooks `useLogin.ts`, `useForgotPassword.ts`, `useResetPassword.ts` and `useVerify.ts`;
  - the pages `VerifyPage.tsx`, `ForgotPasswordPage.tsx` and `ResetPasswordPage.tsx`;
  - the password schemas and their tests;
  - `login`, `verify`, `forgotPassword`, `resetPassword` and the old invite calls in `services/authService.ts`;
  - the matching exports from `features/auth/index.ts`.
- [ ] T038 Create `app-turistear/src/features/auth/components/LegacyLinkNotice.tsx` ("Ya no usamos contraseñas. Entra con tu llave de acceso o con un código por correo.", with a button to `ROUTES.LOGIN`) and `app-turistear/src/pages/LegacyLinkPage.tsx`. Route `ROUTES.VERIFY`, `ROUTES.FORGOT_PASSWORD` and `ROUTES.RESET_PASSWORD` to it in `app-turistear/src/App.tsx` (FR-063). Add a component test citing `passkey-auth US1` (scenario 9), with axe.
- [ ] T039 Remove Agnostic Auth from `api-turistear/wrangler.jsonc`, `api-turistear/vitest.config.ts`, `api-turistear/src/bindings.d.ts` and `api-turistear/.dev.vars.example` (FR-062, SC-003):
  - delete the `AGNOSTIC_AUTH_API` service binding, `AGNOSTIC_AUTH_APP_ID`, `DEV_AUTH_SERVICE_URL` and `SESSION_REFRESH_TTL_SECONDS` from all three profiles, plus the "Shared auth realm" comment;
  - delete the stand-in and the keys from the vitest config;
  - run `pnpm cf-typegen:api`.
- [ ] T040 Delete `api-turistear/test/helpers/jwt.ts` and the replaced suites `api-turistear/test/auth/{admin-login-session,admin-registration,agent-invitation,password-recovery}.test.ts`. research.md § Withdrawn scenarios records where each went.
- [ ] T041 [P] Rewrite `api-turistear/scripts/seed-local.mjs` (SC-011):
  - drop the agnostic-auth hashing and the password argument;
  - insert users with password columns `''` and `email_verified = 1`;
  - print "Entra en http://localhost:5174/login con <email>; el código aparece en la consola del API".
- [ ] T042 [P] Move end-to-end sign-in to the virtual authenticator in `app-turistear/e2e/setup/auth.setup.ts` (D17, R13):
  - sign in each account through the browser with CDP `WebAuthn.addVirtualAuthenticator` and `WebAuthn.addCredential`, from the `E2E_AGENT_PASSKEY` and `E2E_ADMIN_PASSKEY` JSON secrets, then save `storageState`;
  - add `app-turistear/e2e/enroll-passkey.ts`, run once per account against dev;
  - update `app-turistear/e2e/README.md` and `.github/workflows/e2e.yml`, replacing `E2E_*_PASSWORD` with `E2E_*_PASSKEY`.
- [x] T043 Amend the constitution with `/speckit-constitution` (v1.1.1 → v1.2.0, MINOR), exactly as plan D18 lists. Done 2026-10-07 (`f8ff722`), before implementation:
  - Principle IV: `/api/auth/*` belongs to Better Auth; the cookie and the token echo;
  - Principle VI: the stand-in leaves and the secret is pinned;
  - Principle VIII: Agnostic Auth out, Resend on the sign-in path;
  - the stack table: the "Auth" row and `nodejs_als`.
- [ ] T044 [P] Update `CLAUDE.md`:
  - replace the "Running the app locally" caveat with: the local sign-in is an email code printed in the API console, and `.dev.vars` needs `BETTER_AUTH_SECRET` beside its local origins;
  - mark the Agnostic Auth mention under `docs/integrations/` as historical.
- [ ] T045 Register debt `password-material` with `/speckit-debt-log`. `users.password_hash`, `users.password_salt` and `password_reset_tokens` remain in D1, unread. Paying it is the next PR's migration (0072 or the next free number), which drops them (D15, FR-061, SC-006).
- [ ] T046 **Pre-merge gate, which blocks the merge** (D19, `specs/004-passkey-auth/quickstart.md` § 2):
  - set `BETTER_AUTH_SECRET` in dev and in prod, with different values;
  - run the email-case collision query on both databases;
  - record both results in the PR description.
- [ ] T047 Run the proof in `specs/004-passkey-auth/quickstart.md` § 4:
  - `pnpm test:api`, `pnpm test:app`, `pnpm lint:app`, `pnpm build:api` and `pnpm build:app` are all green;
  - the scope-boundary diff shows only the session lines in the 61 business suites;
  - the Agnostic Auth `git grep` is empty;
  - `/speckit-analyze` reports no CRITICAL finding.

---

## Dependencies & Execution Order

| Phase | Depends on | Notes |
|---|---|---|
| Setup (T001–T005) | nothing | T003–T005 run in parallel after T001 and T002 |
| Foundational (T006–T015) | Setup | T008 comes before T009. T013 needs T012. Ship it with US1, because T010 and T011 replace the old sign-in |
| US1 (T016–T020) | Foundational | |
| US2 (T021–T025) | Foundational | The app part builds on US1's `SignInScreen` (T019) and the flag from T018. US1 + US2 is the MVP |
| US3 (T026–T028) | Foundational | The app part reuses US1's `EmailCodeForm` |
| US4 (T029–T031) | US3 (`routes/onboarding/` exists) | |
| US5 (T032–T035) | US2 (`PasskeyOffer`'s add flow) | |
| Polish (T036–T047) | every story | T036 needs US3 and US4 to have replaced `routes/auth/`. T040 needs T030. T046 must be done before the merge |

### Parallel opportunities

- **Setup**: T003, T004 and T005.
- **Foundational**: T008 and T014 alongside T006 and T007.
- **US1**: the API test (T016) runs in parallel with the app track (T017–T020).
- **US2**: T021 and T022 together, then T023–T025.
- **Across stories**: US3 can run in parallel with US2. The app parts of US3 and US4 (T028, T031) can run in parallel with their API parts once the contract is fixed.
- **Polish**: T036, T037, T041, T042 and T044 together.

### Parallel example: User Story 1

```text
Track API: T016 email-code.test.ts
Track app: T017 authClient + MSW ─▶ T018 hooks ─▶ T019 EmailCodeForm + SignInScreen ─▶ T020 tests
```

---

## Implementation Strategy

1. **Setup and Foundational**: Better Auth is mounted, the business suites are green on
   `sessionCookie`, and the session tests pass.
2. **US1 and US2: the MVP.** Code sign-in plus passkeys; quickstart § 3 runs end to end.
3. **US3 and US4**: new organizations and invited agents, without passwords.
4. **US5**: self-service security.
5. **Polish**: retirement, constitution, the gate (T046) and the full proof (T047).

Everything ships as **one pull request** into `develop`. The password columns are dropped in the
next PR (T045, D15).

**Notes**:
- Never edit a business assertion to get green. If a business suite fails after T013, the
  middleware (T011) is wrong, not the test.
- Commit per task or logical group, with Conventional Commits scoped `auth` (`feat(auth): …`) or
  `onboarding`.
