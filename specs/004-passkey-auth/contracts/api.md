# Contract: Authentication API

**Plan**: [../plan.md](../plan.md) · **Spec**: FR-070

There are two families of routes, with two conventions.

| Prefix | Owner | Format | Validation |
|---|---|---|---|
| `/api/auth/*` | Better Auth 1.7.7 (D2) | `{ "code", "message" }` on failure; its own success shapes | its own |
| `/api/onboarding/*`, `/api/me` and every business route | us | `{ "error": { "code", "message" } }` (constitution IV) | `zValidator` |

**The session cookie**:
- It is `__Secure-<AUTH_COOKIE_PREFIX>.session_token`: HttpOnly, Secure and `SameSite=Lax`, on
  `COOKIE_DOMAIN` (D5).
- The app sends it with `credentials: 'include'`.
- No answer carries the session token (constitution IV, v1.2.1). The API strips `token` from the
  sign-in answers, and `/get-session` and `/list-sessions` answer `404` (`disabledPaths`). The app
  reads its user from `/api/me`.

**Rate limits**: a refused call answers `429 { "message": "Too many requests. Please try again later." }`
with an `X-Retry-After` header in seconds, which CORS exposes (D9). Per client IP: code sends and
`sign-in/email-otp` 3 per 60 s each (the emailOTP plugin's rules), every other route 100 per 60 s.

---

## Better Auth endpoints the app uses

These are the standard 1.7.7 contracts. The app calls them through `authClient` (D14), and MSW
mirrors exactly this list.

### Email code: US1, US3, US4

| Client call | HTTP | Body | Success |
|---|---|---|---|
| `authClient.emailOtp.sendVerificationOtp({ email, type: 'sign-in' })` | `POST /api/auth/email-otp/send-verification-otp` | `{ email, type: "sign-in" }` | `200 { success: true }`, the same for unknown emails |
| `authClient.signIn.emailOtp({ email, otp })` | `POST /api/auth/sign-in/email-otp` | `{ email, otp }` | `200 { user }` plus the session cookie (the API strips Better Auth's `token`) |

Failures of `sign-in/email-otp`:
- `400 INVALID_OTP`: wrong, used or superseded.
- `400 OTP_EXPIRED`
- `403 TOO_MANY_ATTEMPTS`: 3 wrong attempts.
- `403 ACCOUNT_SUSPENDED`: from our session-create hook (D6).

### Passkey: US2, US5

| Client call | HTTP | Notes |
|---|---|---|
| `authClient.signIn.passkey({ autoFill })` | `GET /api/auth/passkey/generate-authenticate-options`, then `POST /api/auth/passkey/verify-authentication { response }` | A discoverable sign-in. `200 { session, user }`, without `session.token`, plus the cookie. `401 PASSKEY_NOT_FOUND`; `400 AUTHENTICATION_FAILED` / `CHALLENGE_NOT_FOUND`; `403 ACCOUNT_SUSPENDED` |
| `authClient.passkey.addPasskey({ name })` | `GET /api/auth/passkey/generate-register-options`, then `POST /api/auth/passkey/verify-registration { response, name }` | Needs a fresh session (1 day). Without one: `403 SESSION_NOT_FRESH`, after which the app signs in again. `200` answers the passkey. A notice email follows (D12) |
| `authClient.passkey.listUserPasskeys()` | `GET /api/auth/passkey/list-user-passkeys` | `200 Passkey[]` |
| `authClient.passkey.updatePasskey({ id, name })` | `POST /api/auth/passkey/update-passkey` | `200 { passkey }` |
| `authClient.passkey.deletePasskey({ id })` | `POST /api/auth/passkey/delete-passkey` | `200`, followed by a notice email (D12) |

The options both ceremonies return carry `rpId` set to the host of `APP_BASE_URL`. Registration
carries `authenticatorSelection: { residentKey: "required", userVerification: "required" }`. The
sign-in options carry Better Auth 1.7.7's fixed `userVerification: "preferred"`, which asks every
device able to verify its user to do so (FR-002) and is not configurable (R15).

A registration that does not verify (another origin or rpID) answers Better Auth's own
`500 FAILED_TO_VERIFY_REGISTRATION`, and nothing is stored.

### Sessions: US1, US5

| Client call | HTTP | Notes |
|---|---|---|
| `authClient.signOut()` | `POST /api/auth/sign-out` | Deletes the session and expires the cookie (FR-023) |
| `authClient.revokeSessions()` | `POST /api/auth/revoke-sessions` | Deletes every session of the user (FR-024) |

### Exposed but not used by the app

- **Reachable**: `/revoke-session`, `/revoke-other-sessions` and `/update-user`. The last accepts
  `name` only, because the tenant fields are `input: false`.
- **Disabled (`404`)** through `disabledPaths` (R15):
  - `/get-session` and `/list-sessions`, which keeps the BFF;
  - every password route Better Auth or its emailOTP plugin registers, even with
    email-and-password off: `/sign-in/email`, `/sign-up/email`, `/change-password`,
    `/verify-password`, `/request-password-reset`, `/reset-password`,
    `/email-otp/request-password-reset`, `/forget-password/email-otp`, `/email-otp/reset-password`
    and `/email-otp/check-verification-otp` (FR-060);
  - email changes and out-of-band verification: `/change-email`, `/email-otp/request-email-change`,
    `/email-otp/change-email`, `/email-otp/verify-email`, `/send-verification-email`,
    `/verify-email`;
  - social and account routes and self-deletion: `/sign-in/social`, `/link-social`,
    `/unlink-account`, `/list-accounts`, `/account-info`, `/refresh-token`, `/get-access-token`,
    `/delete-user`, `/delete-user/callback`, `/update-session`.

**Cross-site requests**: Better Auth refuses (`403`) a cookie-bearing `POST` whose `Origin` is not
`APP_BASE_URL`. The app's browser always sends its own.

---

## Our endpoints

### `GET /api/me` (unchanged)

- **200** `{ "user": UserPayload }`
- **401** `UNAUTHORIZED`
- **403** `ACCOUNT_SUSPENDED`

### `POST /api/onboarding/register`: US3, FR-030

```json
{ "name": "Ana", "email": "ana@ejemplo.mx", "company_name": "Tours Ana", "phone": "+52…" }
```

- **201** `{ "message": "Te enviamos un código a tu correo." }`
  - Creates the organization with its D17 policy, and its `unverified` admin.
  - Sends a sign-in code (D10).
- **409** `EMAIL_ALREADY_EXISTS`
- **400** `VALIDATION_ERROR`

### `GET /api/onboarding/invitations/:token`: US4

Moved from `GET /api/auth/invite/accept?token=`.

- **200** `{ "invitation": { "identity", "identity_type", "organization_name" } }`
- **400** `INVALID_TOKEN`

### `POST /api/onboarding/invitations/:token/accept`: US4, FR-031

```json
{ "name": "Luis" }
```

- **200** `{ "email": "luis@ejemplo.mx" }`
  - Creates the agent (`active`, `email_verified`) and accepts the invitation.
  - Sends a sign-in code (D11).
  - The app then shows the code step for that email.
- **400** `INVALID_TOKEN`: expired, used or unknown.
- **409** `EMAIL_ALREADY_EXISTS`
- **400** `VALIDATION_ERROR`

---

## Removed

The app calls none of these any more.

- **Now Better Auth's `404`**: `POST /api/auth/login`, `GET` and `POST /api/auth/verify`,
  `POST /api/auth/forgot-password`, `POST /api/auth/reset-password`, `GET /api/auth/invite/accept`
  and `POST /api/auth/invite/complete`, because those paths fall under Better Auth's handler.
- **Retired codes**: `INVALID_CREDENTIALS` and `EMAIL_NOT_VERIFIED` (FR-071).
