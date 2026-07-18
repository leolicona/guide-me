# Feature: Admin Registration

## Context

A system administrator registers in Turistear Ya! to create their organization. Upon completing registration, they receive a magic link by email. Their account is activated and the session is established only after they verify it.

**User Stories:** US-A01, US-A02  
**Endpoints:** `POST /api/auth/register`, `GET /api/auth/verify?token=xxx`  
**Full Reference:** `docs/auth/user-story-admin-registration.md`

---

## Scenarios

### Scenario 1 — Successful Registration

**Given** that no user exists with email `"leo@empresa.com"`  
**When** a `POST /api/auth/register` request is made with body:
```json
{
  "name": "Leo Licona",
  "email": "leo@empresa.com",
  "password": "S3cur3Pass!",
  "company_name": "Empresa S.A.",
  "phone": "+52 55 1234 5678"
}
```
**Then**
- Status `201 Created`
- Body: `{ "message": "Registro exitoso. Revisa tu correo para verificar tu cuenta." }`
- A record is created in `organizations` with `name = "Empresa S.A."`
- A record is created in `users` with `email = "leo@empresa.com"`, `role = "admin"`, `status = "unverified"`, `plan = "free"`
- The `password_hash` is not equal to the plain text password
- An email is sent via Resend to the registered email
- **No cookies** `gm_access` or `gm_refresh` are set

---

### Scenario 2 — Email Already Registered

**Given** a user already exists with email `"leo@empresa.com"`  
**When** a `POST /api/auth/register` request is made with that same email  
**Then**
- Status `409 Conflict`
- Body: `{ "error": { "code": "EMAIL_ALREADY_EXISTS", "message": "..." } }`
- No record is created in D1

---

### Scenario 3 — Missing Fields

**Given** any system state  
**When** a `POST /api/auth/register` request is made missing any required fields (`name`, `email`, `password`, `company_name`, `phone`)  
**Then**
- Status `400 Bad Request`
- Body: `{ "error": { "code": "VALIDATION_ERROR", "message": "..." } }`
- No record is created in D1

---

### Scenario 4 — Invalid Email Format

**Given** any system state  
**When** a `POST /api/auth/register` request is made with `email = "no-es-un-email"`  
**Then**
- Status `400 Bad Request`
- Body: `{ "error": { "code": "VALIDATION_ERROR" } }`

---

### Scenario 5 — Successful Email Verification

**Given** a user exists with `status = "unverified"` and a valid token (< 10 min) exists in Agnostic Auth  
**When** a `GET /api/auth/verify?token=<token_valido>` request is made  
**Then**
- Status `200 OK`
- Body: `{ "user": { "name": "Leo Licona", "role": "admin" } }`
- The cookie `gm_access` is set with attributes `HttpOnly; Secure; SameSite=Lax; Path=/`
- The cookie `gm_refresh` is set with attributes `HttpOnly; Secure; SameSite=Lax; Path=/api/auth/refresh`
- The user in D1 has `status = "active"`
- The token values **do not appear** in the response body

---

### Scenario 6 — Invalid or Expired Verification Token

**Given** any system state  
**When** a `GET /api/auth/verify?token=<token_inexistente_o_expirado>` request is made  
**Then**
- Status `400 Bad Request`
- Body: `{ "error": { "code": "INVALID_TOKEN", "message": "..." } }`
- No records are modified in D1
- No cookies are set

---

### Scenario 7 — Verification Token Already Consumed (Single-Use)

**Given** a token has already been successfully verified  
**When** `GET /api/auth/verify?token=<mismo_token>` is requested a second time  
**Then**
- Status `400 Bad Request`
- Body: `{ "error": { "code": "INVALID_TOKEN" } }`

---

## Definition of Done

- [ ] All scenarios have passing tests (`test/auth/admin-registration.test.ts`)
- [ ] Migration `0001_create_organizations.sql` applied
- [ ] Migration `0002_create_users.sql` applied
- [ ] Password is never stored in plain text (PBKDF2 verified in test)
- [ ] Endpoint is mounted in the `src/index.tsx` router
- [ ] Cookies are set with correct attributes (verified in test)
- [ ] Resend is called with the correct email (mock in test)
