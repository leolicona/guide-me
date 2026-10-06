# Quickstart: Passkey Sign-In with Email Code Recovery

**Plan**: [plan.md](./plan.md) · **Contract**: [contracts/api.md](./contracts/api.md) ·
**Data**: [data-model.md](./data-model.md)

This guide proves the feature works and walks through the cutover. It is a validation guide; the
implementation lives in `tasks.md`.

## 1. Prerequisites

- Node 22, pnpm 10, and a fresh worktree from `develop` (CLAUDE.md § Local workflow).
- `pnpm install`. The lockfile gains `better-auth`, `@better-auth/passkey` and
  `@better-auth/drizzle-adapter` at 1.7.7, `@noble/hashes` (API dev dependency) and
  `@simplewebauthn/browser` (app).
- A Chromium-based browser for the local passkey ceremony. `localhost` is a secure context, so
  WebAuthn works over `http://localhost:5174`.

## 2. Secrets (once per environment, before the first deploy)

`BETTER_AUTH_SECRET` is a Worker secret. It is **different in every environment** (constitution
VIII) and never committed.

```bash
openssl rand -base64 48 | pnpm --filter api-turistear exec wrangler secret put BETTER_AUTH_SECRET --env dev
openssl rand -base64 48 | pnpm --filter api-turistear exec wrangler secret put BETTER_AUTH_SECRET --env production
```

Local: add `BETTER_AUTH_SECRET=<any 32+ chars>` to `api-turistear/.dev.vars` (git-ignored).
`RESEND_API_KEY` is not needed locally, because the code is printed to the console instead
(`OTP_LOG_TO_CONSOLE`, FR-064).

Rotating the secret signs everyone out and invalidates every pending code. It never touches the
passkeys.

## 3. Pre-flight (read-only, before the migration reaches each database)

Migration 0070 lowercases emails (D17). A pair of addresses that differ only in case would fail its
unique index, safely, before any code ships. Check first:

```bash
pnpm --filter api-turistear exec wrangler d1 execute guideme-db --env dev --remote --command \
  "SELECT lower(email) AS e, COUNT(*) AS n FROM users GROUP BY lower(email) HAVING n > 1;"
pnpm --filter api-turistear exec wrangler d1 execute guideme-db-prod --env production --remote --command \
  "SELECT lower(email) AS e, COUNT(*) AS n FROM users GROUP BY lower(email) HAVING n > 1;"
```

Expected: no rows. If a row appears, the developer decides which account keeps the address before
the deploy.

## 4. Run it locally (SC-011)

```bash
pnpm db:migrate:local      # applies 0070
pnpm seed:local            # seeds an admin; no password any more
pnpm dev                   # API :5173, app :5174
```

1. Open `http://localhost:5174/login`, enter the seeded admin's email, and tap "Recibir código".
2. Read the 6-digit code from the API's console (`[otp] admin@… 482913`).
3. Enter it. You land on the **mandatory** "Crea tu llave de acceso" step (US2, scenario 1).
   Confirm with the device. The browser's built-in authenticator or a virtual authenticator in
   DevTools → WebAuthn both work.
4. Sign out, then tap "Entrar con llave de acceso". You are in without typing an email (US2,
   scenario 5).

No external worker, `DEV_AUTH_SERVICE_URL` or cookie-domain override is involved.

## 5. Automated proof

```bash
pnpm test:api      # workerd + real D1 + real Better Auth (software authenticator, D18)
pnpm test:app      # jsdom + MSW + axe
pnpm lint:app && pnpm build:api && pnpm build:app
```

What must be true, mapped to the spec:

| Proof | Where | Spec |
|---|---|---|
| Code issue and redeem; same answer for unknown email; 5 attempts; newest code wins; 10-min expiry; per-email and per-IP limits with `Retry-After`; `unverified → active`; suspended and retired role refused with no session row | `test/auth/email-code.test.ts` | US1, FR-010–FR-016, SC-010 |
| Registration with UV; discoverable sign-in; UV missing refused; backwards use count refused; removed key refused; 10-key limit; `last_used_at` | `test/auth/passkeys.test.ts` | US2, FR-001–FR-006 |
| A code session reaches only `/api/me`, the passkey registration routes and logout until it enrolls; `passkey_support: "none"` skips the gate | `test/auth/enrollment-gate.test.ts` | FR-007, FR-009, SC-008 |
| Altered, foreign-secret and unknown-token cookies refused; renewal extends without rotating; parallel requests survive renewal; logout and revoke-all end sessions at the next request | `test/auth/sessions.test.ts` | FR-020–FR-025, SC-005 |
| Register without password, then code, then enrollment; D17 policy present | `test/auth/registration.test.ts` | US3 |
| Invitation without password; pre-cutover invitation still valid; no-WebAuthn completion | `test/auth/invitation.test.ts` | US4 |
| Step-up (`REAUTH_REQUIRED` after 15 min); last passkey kept; rename; revoke-all | `test/auth/passkeys.test.ts` | US5 |
| Restore access; another organization gets `404` (`seedTwoOrgs`); an agent gets `403` | `test/auth/restore-access.test.ts` | US6, FR-042 |
| Every business suite passes with only its session lines changed | `git diff --stat develop -- api-turistear/test ':!api-turistear/test/auth' ':!api-turistear/test/helpers'` shows two lines per file | Scope Boundary |
| No reference to Agnostic Auth remains | `git grep -nIE "AGNOSTIC_AUTH\|agnosticAuth\|Agnostic Auth\|DEV_AUTH_SERVICE_URL" -- api-turistear app-turistear .github` is empty, apart from archive citations in comments | FR-062, SC-003 |

## 6. Cutover (dev, then prod)

1. Merge the feature PR into `develop`. CI deploys dev: tests, then migration 0070, then the API,
   then the app.
2. On `app-dev.turistearya.com`:
   - Sign in by code with a real mailbox, and enroll a passkey on a phone.
   - Sign out, then sign in with the passkey.
   - Check that a passkey created on dev is **not offered** on `app.turistearya.com` (FR-003).
3. Enroll each end-to-end account once through Playwright's virtual authenticator. Store its
   private key as `E2E_AGENT_PASSKEY` and `E2E_ADMIN_PASSKEY` (GitHub secrets), and delete
   `E2E_*_PASSWORD`. Run the `e2e` label on a PR.
4. Release `develop → main` (a merge commit) once a required reviewer approves the `production`
   environment.
5. On prod: every active admin and agent can sign in by code on cutover day (SC-007). Password
   screens are gone (SC-006).

## 7. The follow-up deploy (D16, the next PR after cutover)

Drop `users.password_hash`, `users.password_salt` and `password_reset_tokens` in migration 0071,
and pay debt `password-material` with `/speckit-debt-pay`. Proof:

```bash
wrangler d1 execute … --command "SELECT name FROM pragma_table_info('users') WHERE name LIKE 'password%';"
```

Expected: no rows (SC-006).
