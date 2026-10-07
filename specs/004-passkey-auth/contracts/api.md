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
- Better Auth's sign-in answers echo `token` in the body. The app never reads or stores it.

**Rate limits**: a refused call answers `429 { "message": "Too many requests…" }` with an
`X-Retry-After` header in seconds, which CORS exposes (D9).

---

## Better Auth endpoints the app uses

These are the standard 1.7.7 contracts. The app calls them through `authClient` (D14), and MSW
mirrors exactly this list.

### Email code: US1, US3, US4

| Client call | HTTP | Body | Success |
|---|---|---|---|
| `authClient.emailOtp.sendVerificationOtp({ email, type: 'sign-in' })` | `POST /api/auth/email-otp/send-verification-otp` | `{ email, type: "sign-in" }` | `200 { success: true }`, the same for unknown emails |
| `authClient.signIn.emailOtp({ email, otp })` | `POST /api/auth/sign-in/email-otp` | `{ email, otp }` | `200 { token, user }` plus the session cookie |

Failures of `sign-in/email-otp`:
- `400 INVALID_OTP`: wrong, used or superseded.
- `400 OTP_EXPIRED`
- `403 TOO_MANY_ATTEMPTS`: 3 wrong attempts.
- `403 ACCOUNT_SUSPENDED`: from our session-create hook (D6).

### Passkey: US2, US5

| Client call | HTTP | Notes |
|---|---|---|
| `authClient.signIn.passkey({ autoFill })` | `GET /api/auth/passkey/generate-authenticate-options`, then `POST /api/auth/passkey/verify-authentication { response }` | A discoverable sign-in. `200 { session, user }` plus the cookie. `401 PASSKEY_NOT_FOUND`; `400 AUTHENTICATION_FAILED` / `CHALLENGE_NOT_FOUND`; `403 ACCOUNT_SUSPENDED` |
| `authClient.passkey.addPasskey({ name })` | `GET /api/auth/passkey/generate-register-options`, then `POST /api/auth/passkey/verify-registration { response, name }` | Needs a fresh session (1 day). Without one: `403 SESSION_NOT_FRESH`, after which the app signs in again. `200` answers the passkey. A notice email follows (D12) |
| `authClient.passkey.listUserPasskeys()` | `GET /api/auth/passkey/list-user-passkeys` | `200 Passkey[]` |
| `authClient.passkey.updatePasskey({ id, name })` | `POST /api/auth/passkey/update-passkey` | `200 { passkey }` |
| `authClient.passkey.deletePasskey({ id })` | `POST /api/auth/passkey/delete-passkey` | `200`, followed by a notice email (D12) |

The options both ceremonies return carry `rpId` set to the host of `APP_BASE_URL` and
`userVerification: "required"`. Registration also carries `residentKey: "required"`.

### Sessions: US1, US5

| Client call | HTTP | Notes |
|---|---|---|
| `authClient.signOut()` | `POST /api/auth/sign-out` | Deletes the session and expires the cookie (FR-023) |
| `authClient.revokeSessions()` | `POST /api/auth/revoke-sessions` | Deletes every session of the user (FR-024) |

### Exposed but not used by the app

- **Reachable**: `/get-session`, `/list-sessions`, `/revoke-session`, `/revoke-other-sessions` and
  `/update-user`. The last accepts `name` only, because the tenant fields are `input: false`.
- **Disabled**: email-and-password, `changeEmail` and `deleteUser`.

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
