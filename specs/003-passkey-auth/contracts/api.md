# Contract: Authentication API

**Plan**: [../plan.md](../plan.md) · **Codes**: spec FR-070

## Conventions

- **Errors**: every failure answers `{ "error": { "code", "message" } }` (constitution IV). Clients
  branch on `code`. A `429` also carries a `Retry-After` header in seconds (FR-012); the envelope
  does not change.
- **Session cookie**: the session lives in one HttpOnly, Secure, `SameSite=Lax` cookie,
  `__Secure-<AUTH_COOKIE_PREFIX>.session_token`, on `COOKIE_DOMAIN` (D5). A short-lived signed
  challenge cookie accompanies each passkey ceremony. No token ever appears in a body.
- **Validation**: every body is validated with `zValidator` before its handler runs. An invalid
  body answers `400 VALIDATION_ERROR`.
- **Email addresses**: lowercased at the edge (R11).
- **Field names**: request and response fields are snake_case. `user` in `/api/me` keeps today's
  `UserPayload` shape.
- **`passkey_support`**: `"available" | "none"`. The app sends `"none"` only when
  `PublicKeyCredential` does not exist (D15).

### Who can call what

| Access | Endpoints |
|---|---|
| Public | `register`, `email-code/*`, `passkeys/sign-in/*`, `invite/*` |
| Session, including one owing enrollment (D6) | `GET /api/me`, `passkeys/register/*`, `logout` |
| Session, enrolled | everything else |

A session that owes enrollment and calls any other route answers
`403 PASSKEY_ENROLLMENT_REQUIRED`.

---

## Public

### `POST /api/auth/register`: US3, FR-030

```json
{ "name": "Ana", "email": "ana@ejemplo.mx", "company_name": "Tours Ana", "phone": "+52…" }
```

- **201** `{ "message": "Te enviamos un código a tu correo." }`
  - Creates the organization (with its D17 default policy) and its `unverified` admin.
  - Issues a sign-in code, as the code request below does.
- **409** `EMAIL_ALREADY_EXISTS`
- **429** `OTP_RATE_LIMITED`
- **503** `OTP_DELIVERY_FAILED`: the account exists, the code was not sent, and the client offers
  "Reenviar código".

### `POST /api/auth/email-code/request`: US1, FR-010–FR-014

```json
{ "email": "ana@ejemplo.mx" }
```

- **200** `{ "message": "Si el correo está registrado, recibirás un código." }`
  - The answer is identical for unknown, suspended or retired-role addresses, and nothing is sent
    to them (FR-013).
- **429** `OTP_RATE_LIMITED` + `Retry-After`. The limits are 1 per minute and 5 per hour per
  email, plus 20 per hour per IP (D9).
- **503** `OTP_DELIVERY_FAILED`

### `POST /api/auth/email-code/verify`: US1, FR-007, FR-009, FR-015

```json
{ "email": "ana@ejemplo.mx", "code": "482913", "passkey_support": "available" }
```

- **200**, setting the session cookie:

  ```json
  { "user": { "name": "Ana", "role": "admin" }, "session": { "passkey_required": true } }
  ```

  - `passkey_required` is false only when `passkey_support` is `"none"`.
  - An `unverified` account becomes `active`.
- **401** `OTP_INVALID`: wrong, expired, used or superseded.
- **429** `OTP_ATTEMPTS_EXCEEDED`: 5 wrong attempts on this code.
- **403** `ACCOUNT_SUSPENDED`: suspended, or a retired role. No session is created (D6).

### `POST /api/auth/passkeys/sign-in/options`: US2, FR-001

No body.

- **200** `{ "options": PublicKeyCredentialRequestOptionsJSON }`, plus the challenge cookie.
  - The options carry `rpId` set to the environment's app host and `userVerification: "required"`,
    with no `allowCredentials`, which makes it a discoverable sign-in.

### `POST /api/auth/passkeys/sign-in/verify`: US2, FR-001, FR-002, FR-006

```json
{ "response": AuthenticationResponseJSON }
```

- **200**, setting the session cookie and revoking the request's previous session of the same user
  (D8):

  ```json
  { "user": { "name": "Ana", "role": "agent" }, "session": { "passkey_required": false } }
  ```

- **401** `PASSKEY_NOT_RECOGNIZED`: the credential is unknown or was removed.
- **401** `PASSKEY_VERIFICATION_FAILED`: the challenge is missing or expired, the origin is wrong,
  the signature is invalid, there was no user verification, or the use count went backwards.
- **403** `ACCOUNT_SUSPENDED`

### `GET /api/auth/invite/accept?token=…`: unchanged

- **200** `{ "invitation": { "identity", "identity_type", "organization_name" } }`
- **400** `INVALID_TOKEN`

### `POST /api/auth/invite/complete`: US4, FR-031

```json
{ "token": "…", "name": "Luis", "passkey_support": "available" }
```

- **200**, setting the session cookie with `auth_method` set to `invitation`:

  ```json
  { "user": { "name": "Luis", "role": "agent" }, "session": { "passkey_required": true } }
  ```

  - Creates the agent as `active` with `email_verified` set, and accepts the invitation.
- **400** `INVALID_TOKEN`: expired, used or unknown.
- **409** `EMAIL_ALREADY_EXISTS`: an account with this address appeared after the invitation was
  sent.

---

## Session (enrollment allowed)

### `GET /api/me`

- **200**

  ```json
  {
    "user": UserPayload,
    "session": { "auth_method": "email_code", "passkey_required": true }
  }
  ```

- **401** `UNAUTHORIZED`
- **403** `ACCOUNT_SUSPENDED`

### `POST /api/auth/passkeys/register/options`: US2, US5, FR-004, FR-005

No body.

- **200** `{ "options": PublicKeyCredentialCreationOptionsJSON }`, plus the challenge cookie.
  - The options carry `residentKey: "required"` and `userVerification: "required"`, and
    `excludeCredentials` lists the user's existing passkeys.
- **403** `REAUTH_REQUIRED`: the session does not owe enrollment, and it authenticated more than
  15 minutes ago (D8).
- **409** `PASSKEY_LIMIT_REACHED`: the user already has 10.

### `POST /api/auth/passkeys/register/verify`: US2, FR-002, FR-041

```json
{ "response": RegistrationResponseJSON, "name": "Mi teléfono" }
```

- **201** `{ "passkey": Passkey }`
  - Clears `passkey_required` on this session.
  - Sends a notice email under `waitUntil`.
- **401** `PASSKEY_VERIFICATION_FAILED`: the challenge is missing or expired, the origin is wrong,
  or there was no user verification.

### `POST /api/auth/logout`: FR-023

No body.

- **200** `{ "message": "Sesión cerrada correctamente." }`
  - Deletes the session row and expires the cookie.
  - Answers the same with no session.

---

## Session (enrolled)

### `GET /api/auth/passkeys`: US5, FR-040

- **200** `{ "passkeys": Passkey[] }`, sorted newest first.

```ts
type Passkey = {
  id: string
  name: string | null
  device_type: 'singleDevice' | 'multiDevice'
  backed_up: boolean
  created_at: number            // epoch s
  last_used_at: number | null   // epoch s
}
```

### `PATCH /api/auth/passkeys/:id`: US5

```json
{ "name": "Teléfono de trabajo" }
```

`name` is 1–60 characters after trimming.

- **200** `{ "passkey": Passkey }`
- **404** `NOT_FOUND`: not this user's passkey.

### `DELETE /api/auth/passkeys/:id`: US5, FR-005, FR-008, FR-041

- **200** `{ "message": "Llave de acceso eliminada." }`, followed by a notice email under
  `waitUntil`.
- **403** `REAUTH_REQUIRED`
- **404** `NOT_FOUND`
- **409** `PASSKEY_LAST_ONE`

### `POST /api/auth/sessions/revoke-all`: US5, FR-024

No body.

- **200** `{ "message": "Cerraste sesión en todos tus dispositivos." }`
  - Deletes every session of the user, this one included, and expires the cookie.

---

## Admin

### `POST /api/agents/:id/restore-access`: US6, FR-042

The `agents` router requires the `admin` role.

- **200** `{ "message": "Acceso restablecido." }`
  - Deletes all of the agent's passkeys and sessions in one batch.
  - Sends a notice email to the agent under `waitUntil`.
- **403** `FORBIDDEN`: the caller is an agent.
- **404** `NOT_FOUND`: the id is not an agent of the caller's organization (constitution III).

---

## Removed (D14)

`POST /api/auth/login`, `GET` and `POST /api/auth/verify`, `POST /api/auth/forgot-password` and
`POST /api/auth/reset-password` now answer **404** (Hono not-found). The app no longer calls them.
Its `/verify`, `/forgot-password` and `/reset-password` pages render the legacy-link page instead
(FR-063).

## Codes in this contract

| Code | Status | Where |
|---|---|---|
| `VALIDATION_ERROR` | 400 | any body |
| `INVALID_TOKEN` | 400 | invite accept and complete |
| `UNAUTHORIZED` | 401 | no, expired, altered, foreign or revoked session (FR-021) |
| `OTP_INVALID` | 401 | email-code verify |
| `PASSKEY_NOT_RECOGNIZED` | 401 | passkey sign-in |
| `PASSKEY_VERIFICATION_FAILED` | 401 | passkey sign-in and register |
| `ACCOUNT_SUSPENDED` | 403 | sign-in, any request (suspended or retired role) |
| `FORBIDDEN` | 403 | role guard |
| `PASSKEY_ENROLLMENT_REQUIRED` | 403 | any non-enrollment route from a session owing enrollment |
| `REAUTH_REQUIRED` | 403 | register options (outside enrollment), delete |
| `NOT_FOUND` | 404 | passkey rename and delete, restore |
| `EMAIL_ALREADY_EXISTS` | 409 | register, invite complete |
| `PASSKEY_LIMIT_REACHED` | 409 | register options |
| `PASSKEY_LAST_ONE` | 409 | delete |
| `OTP_ATTEMPTS_EXCEEDED` | 429 | email-code verify |
| `OTP_RATE_LIMITED` | 429 | register, email-code request |
| `OTP_DELIVERY_FAILED` | 503 | register, email-code request |

Retired: `INVALID_CREDENTIALS` and `EMAIL_NOT_VERIFIED` (FR-071).
