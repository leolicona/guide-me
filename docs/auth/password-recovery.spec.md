# Feature: Password Recovery for Admins and Agents

## Context

Both administrators and sales agents use passwords in Turistear Ya! When they forget it, they can request a reset via email. The flow consists of two steps: requesting the link and confirming the new password. Upon completing the reset, **no session is established** — the user must log in using the new password.

**User Stories:** US-A04, US-AG18  
**Endpoints:** `POST /api/auth/forgot-password`, `POST /api/auth/reset-password`  
**Full Reference:** `docs/auth/user-story-admin-registration.md`

---

## Scenarios

### Scenario 1 — Reset Request for Registered Email (Admin or Agent)

**Given** a user exists with `email = "usuario@empresa.com"` (role is `"admin"` or `"agent"`)  
**When** a `POST /api/auth/forgot-password` request is made with body:
```json
{ "email": "usuario@empresa.com" }
```
**Then**
- Status `200 OK`
- Body: `{ "message": "Si el correo está registrado, recibirás instrucciones." }`
- A record is created in `password_reset_tokens` for that user with `expires_at = now + 1h`
- An email is sent via Resend with the reset link
- No cookies are set

---

### Scenario 2 — Reset Request for Unregistered Email

**Given** no user exists with `email = "noexiste@empresa.com"`  
**When** a `POST /api/auth/forgot-password` request is made with that email  
**Then**
- Status `200 OK`
- Body: `{ "message": "Si el correo está registrado, recibirás instrucciones." }`
- **Same response as Scenario 1** — does not leak whether the email exists
- No record is created in D1
- No email is sent

---

### Scenario 3 — Previous Token is Invalidated When Requesting a New One

**Given** an active reset token already exists for `"leo@empresa.com"`  
**When** a `POST /api/auth/forgot-password` request is made with that email a second time  
**Then**
- Status `200 OK`
- The previous token is deleted from `password_reset_tokens`
- A new token is created with a new expiration date
- Only one active token exists per user at any time

---

### Scenario 4 — Successful Password Reset

**Given** a valid token (< 1h) exists in `password_reset_tokens` for the user `"leo@empresa.com"`  
**When** a `POST /api/auth/reset-password` request is made with body:
```json
{
  "token": "a3f9c2d1e8b7...",
  "password": "NuevaS3cur3Pass!"
}
```
**Then**
- Status `200 OK`
- Body: `{ "message": "Contraseña actualizada correctamente." }`
- The user's `password_hash` in D1 is updated
- The new hash is not equal to the plain text password
- The token is deleted from `password_reset_tokens` (single-use)
- **No cookies are set** — the admin must log in

---

### Scenario 5 — Invalid or Inexistent Reset Token

**Given** any system state  
**When** a `POST /api/auth/reset-password` request is made with a token that does not exist in D1  
**Then**
- Status `400 Bad Request`
- Body: `{ "error": { "code": "INVALID_TOKEN" } }`
- No `password_hash` is modified

---

### Scenario 6 — Expired Reset Token (> 1 hour)

**Given** a token exists in `password_reset_tokens` with an `expires_at` timestamp in the past  
**When** a `POST /api/auth/reset-password` request is made with that token  
**Then**
- Status `400 Bad Request`
- Body: `{ "error": { "code": "INVALID_TOKEN" } }`
- No `password_hash` is modified

---

### Scenario 7 — Reset Token Already Consumed

**Given** a token has been used successfully (no longer exists in D1)  
**When** a `POST /api/auth/reset-password` request is made with the same token  
**Then**
- Status `400 Bad Request`
- Body: `{ "error": { "code": "INVALID_TOKEN" } }`

---

### Scenario 8 — Missing Fields in Reset

**Given** any system state  
**When** a `POST /api/auth/reset-password` request is made without `token` or without `password`  
**Then**
- Status `400 Bad Request`
- Body: `{ "error": { "code": "VALIDATION_ERROR" } }`

---

## Definition of Done

- [ ] All scenarios have passing tests (`test/auth/password-recovery.test.ts`)
- [ ] Migration `0004_create_password_reset_tokens.sql` applied
- [ ] Resetting never sets cookies (verified in test)
- [ ] Only one active reset token exists per user (Scenario 3 covered)
- [ ] Resend is called only when the email exists (mock verified)
- [ ] The response of Scenario 1 and 2 is identical (timing-safe, does not leak existence)
