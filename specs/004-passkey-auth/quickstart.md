# Quickstart: Passkey Sign-In with Email Code Backup

**Plan**: [plan.md](./plan.md) · **Contract**: [contracts/api.md](./contracts/api.md) ·
**Data**: [data-model.md](./data-model.md)

This guide proves the feature works and walks through the cutover. It is a validation guide; the
implementation lives in `tasks.md`.

## 1. Prerequisites

- Node 22, pnpm 10, and a worktree from `origin/main` (CLAUDE.md § Local workflow).
- `pnpm install`. The lockfile gains Better Auth 1.7.7 (server and client), `@better-auth/passkey`,
  `@better-auth/drizzle-adapter` and `@noble/hashes` (API dev dependency).
- A Chromium-based browser. `localhost` is a secure context, so WebAuthn works over
  `http://localhost:5174`.

## 2. Pre-merge gate (D19): before the PR merges into `main`

Opening the pull request builds its preview, which applies migration 0071 to dev's database
(`specs/005-delivery-pipeline` D3); merging deploys dev. Do both steps first and record the results
in the PR.

**Secrets.** `BETTER_AUTH_SECRET` is managed in the GitHub environments `dev` and `production`,
**a different value in each** (`openssl rand -base64 48`), never committed (constitution VIII,
v1.4.0). Every dev deploy and prod release plants it on its API Worker with the version it ships
(`wrangler deploy --secrets-file`, additive), and stops before migrating when it is missing or
shorter than 32 characters; the API itself refuses to start without one (`src/auth/index.ts`). A
pull request's preview takes the `dev` environment's value, or a throwaway its note names.

Rotating the secret signs everyone out and invalidates every pending code. It never touches the
passkeys.

**Email-case collisions (read-only).** Migration 0071 lowercases emails (D16). Two addresses that
differ only in case would fail its unique index.

```bash
pnpm --filter api-turistear exec wrangler d1 execute guideme-db --env dev --remote --command \
  "SELECT lower(email) AS e, COUNT(*) AS n FROM users GROUP BY lower(email) HAVING n > 1;"
pnpm --filter api-turistear exec wrangler d1 execute guideme-db-prod --env production --remote --command \
  "SELECT lower(email) AS e, COUNT(*) AS n FROM users GROUP BY lower(email) HAVING n > 1;"
```

Expected: no rows. If a row appears, the developer decides which account keeps the address.

## 3. Run it locally (SC-011)

`api-turistear/.dev.vars` already carries the local origins: `APP_BASE_URL=http://localhost:5174`
and an empty `COOKIE_DOMAIN`. It needs one more line:

```bash
BETTER_AUTH_SECRET=<any 32+ characters>
```

Then:

```bash
pnpm db:migrate:local      # applies 0071
pnpm seed:local            # seeds an admin and an agent; no passwords
pnpm dev                   # API :5173, app :5174
```

1. Open `http://localhost:5174/login`, enter the seeded admin's email, and tap "Recibir código".
2. Read the code from the API console: `[otp] admin@… 482913` (`OTP_LOG_TO_CONSOLE`).
3. Enter it. You land in the app, offered "Crear llave de acceso", with an "Ahora no" option.
4. Accept, and confirm with the device. The browser's own authenticator works, and so does
   DevTools → WebAuthn → virtual authenticator.
5. Sign out, then tap "Entrar con llave de acceso". You are in, without an email.

No external worker or `DEV_AUTH_SERVICE_URL` is involved.

## 4. Automated proof

```bash
pnpm test:api      # workerd + real D1 + real Better Auth (software authenticator)
pnpm test:app      # jsdom + MSW + axe
pnpm lint:app && pnpm build:api && pnpm build:app
```

| Proof | Where | Spec |
|---|---|---|
| Code issue and sign-in; same answer for unknown email; 3 attempts; newest code wins; 5-minute expiry; `unverified → active`; a suspended user gets no session row (fixture rows excluded); the stored code is not the code; `429` with `X-Retry-After` after 3 sends a minute and after 3 sign-in attempts a minute | `test/auth/email-code.test.ts` | US1, FR-010–FR-016, SC-010 |
| Passkey registration and discoverable sign-in; a removed key is refused; a backwards use count is refused; another `rpID` or origin is refused; adding without a fresh session → `SESSION_NOT_FRESH`; list, rename, delete; notices sent | `test/auth/passkeys.test.ts` | US2, US5, FR-001–FR-006, FR-040, FR-041 |
| Altered, foreign-secret and unknown-token cookies refused; renewal keeps the token; parallel requests survive renewal; sign-out and revoke-sessions end sessions at the next request; suspended refused; no `/api/auth/*` answer carries a token, and `/get-session`, `/list-sessions` and every password route answer `404` (BFF, FR-060); a foreign-Origin POST is refused | `test/auth/sessions.test.ts` | FR-020–FR-025, FR-060, SC-005 |
| Register without password, then code, then signed in as admin; D17 policy present; duplicate refused | `test/onboarding/register.test.ts` | US3 |
| Invitation lookup; accept with name, then code, then signed in as agent; pre-cutover invitation; used or expired token refused | `test/onboarding/invitations.test.ts` | US4 |
| `/api/auth/update-user` cannot change `organizationId`, `role` or `status` | `test/auth/sessions.test.ts` | constitution III, D2 |
| Business suites pass with only their session lines changed | `git diff origin/main... -- api-turistear/test ':!api-turistear/test/auth' ':!api-turistear/test/onboarding' ':!api-turistear/test/helpers'` touches 61 files, and only their import, cookie and session-mechanism lines (spec § Amended by the implementation) | Scope Boundary |
| No Agnostic Auth left | `git grep -nIE "AGNOSTIC_AUTH\|agnosticAuth\|Agnostic Auth\|DEV_AUTH_SERVICE_URL" -- api-turistear app-turistear .github` is empty, apart from archive citations | FR-062, SC-003 |

## 5. Cutover (dev, then prod)

1. The gate (§2) is done and recorded. The pull request's preview (`app-guideme-pr-<n>` on
   `workers.dev`, dev's data, 0071 applied) is the first place to try it: sign in by code there.
2. Merge into `main`. CI deploys dev: the gate, then dev's migrations (0071 already applied by the
   preview), then the API, then the app.
3. On `app-dev.turistearya.com`:
   - Sign in by code with a real mailbox, create a passkey on a phone, sign out, and sign in with
     it.
   - Check that the dev passkey is **not offered** on `app.turistearya.com` (FR-003).
4. Enroll each end-to-end account once against dev (`e2e/enroll-passkey.ts`). Store the
   credentials as `E2E_AGENT_PASSKEY` and `E2E_ADMIN_PASSKEY` in the GitHub `dev` environment, and
   delete the four `E2E_*_EMAIL` / `E2E_*_PASSWORD` secrets. The same credential serves every
   preview, which runs on dev's database. Run the `e2e` label on a PR.
5. Put `BETTER_AUTH_SECRET` in the GitHub `production` environment (§2), then release: a `v*` tag on the `main` commit
   whose dev deploy is green (`specs/005-delivery-pipeline` D10).
6. On prod, every active admin and agent can sign in by code (SC-007), and no screen asks for a
   password (SC-006).

**Measuring SC-009 after 30 days**: Better Auth's standard schema does not record how a session
was signed in, so it is measured from the Worker's request logs. Over the period, count status-200
`POST /api/auth/passkey/verify-authentication` against status-200 `POST /api/auth/sign-in/email-otp`.

## 6. The follow-up deploys (D15, after cutover)

The drop takes two pull requests, because a migration runs before the code it ships with and must
be compatible with the code already deployed (constitution, Additional constraints). The cutover's
own code still inserted users through the password columns, so it could not run against the drop.

1. **The code stops depending on them** (2026-10-15). `users` maps neither column, and a new user is
   insertable on both sides of the drop. `test/auth/password-material.test.ts` drops the columns
   and the table from its own database and proves registration, invitations and both sign-ins
   still work. Release it: a `v*` tag on a `main` commit that carries it.
2. **The drop**, once that release is live in prod. Drop `users.password_hash`,
   `users.password_salt` and `password_reset_tokens` in migration 0072 (the next free number),
   remove the step-1 fallback, and pay debt `password-material` with `/speckit-debt-pay`. Proof:

```bash
wrangler d1 execute … --command "SELECT name FROM pragma_table_info('users') WHERE name LIKE 'password%';"
```

Expected: no rows (SC-006).
