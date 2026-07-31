# Feature: Admin & Agent Login & Session Management

## Context

Both administrators and sales agents access the platform using their email and password. `api-turistear` acts as a BFF: it retrieves tokens from Agnostic Auth and stores them in HttpOnly cookies. The UI never sees the tokens. Session renewal occurs transparently in the middleware when `gm_access` expires.

**User Stories:** US-A03, US-AG02  
**Endpoints:** `POST /api/auth/login`, `POST /api/auth/refresh`, `POST /api/auth/logout`  
**Full Reference:** `docs/SPEC.md` (US-A01–US-A04)

---

## Scenarios

### Scenario 1 — Successful Login

**Given** a user exists with `email = "usuario@empresa.com"`, `status = "active"`, and a `password_hash` corresponding to `"S3cur3Pass!"`  
**When** a `POST /api/auth/login` request is made with body:
```json
{ "email": "usuario@empresa.com", "password": "S3cur3Pass!" }
```
**Then**
- Status `200 OK`
- Body: `{ "user": { "name": "Usuario Prueba", "role": "admin" } }` (or `"agent"` depending on the user's role)
- The cookie `gm_access` is set (`HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=SESSION_REFRESH_TTL_SECONDS`)
- The cookie `gm_refresh` is set (`HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=SESSION_REFRESH_TTL_SECONDS`)

> Both cookies share the idle-session window (`SESSION_REFRESH_TTL_SECONDS`, see `wrangler.jsonc`),
> which must match `refreshTokenTtlSeconds` in the agnostic-auth `APP_REGISTRY` entry for `guide-me`.
> `Path` is `/` for both — `gm_refresh` is read by `authMiddleware` on every route, not just refresh.
- The tokens **do not appear** in the response body

---

### Scenario 2 — Incorrect Password

**Given** a user exists with `email = "leo@empresa.com"`  
**When** a `POST /api/auth/login` request is made with `password = "ContraseñaIncorrecta"`  
**Then**
- Status `401 Unauthorized`
- Body: `{ "error": { "code": "INVALID_CREDENTIALS" } }`
- No cookies are set
- The error message **does not indicate** whether the email or the password was incorrect

---

### Scenario 3 — Email Not Registered

**Given** no user exists with `email = "noexiste@empresa.com"`  
**When** a `POST /api/auth/login` request is made with that email  
**Then**
- Status `401 Unauthorized`
- Body: `{ "error": { "code": "INVALID_CREDENTIALS" } }`
- Same error as incorrect password (does not leak email existence)

---

### Scenario 4 — Unverified Account

**Given** a user exists with `email = "leo@empresa.com"`, `status = "unverified"`  
**When** a `POST /api/auth/login` request is made with correct credentials  
**Then**
- Status `403 Forbidden`
- Body: `{ "error": { "code": "EMAIL_NOT_VERIFIED" } }`
- No cookies are set

---

### Scenario 5 — Missing Fields

**Given** any system state  
**When** a `POST /api/auth/login` request is made without `email` or without `password`  
**Then**
- Status `400 Bad Request`
- Body: `{ "error": { "code": "VALIDATION_ERROR" } }`

---

### Scenario 6 — Access Protected Route with Valid Session

**Given** the client has a `gm_access` cookie with a valid (non-expired) JWT  
**When** making a request to any protected endpoint (e.g. `GET /api/services`)  
**Then**
- The middleware extracts the `sub` from the JWT
- Performs a lookup for the user in D1 by `identity`
- Attaches `{ user_id, role, organization_id }` to the Hono context
- The handler receives the request with the user in context
- No new cookies are set

---

### Scenario 7 — Transparent Session Renewal (Middleware)

**Given** the client has an expired `gm_access` and a valid `gm_refresh`  
**When** making a request to any protected endpoint  
**Then**
- The middleware detects the expired JWT
- Calls `POST /auth/refresh` on Agnostic Auth with the `gm_refresh` cookie
- Agnostic Auth returns a new pair of tokens (RTR: the old refresh token is invalidated)
- `gm_access` and `gm_refresh` are overwritten in the response
- The handler executes normally
- The UI receives the data response + the new cookies (transparent flow)

---

### Scenario 8 — Access with Expired JWT and Invalid Refresh Token

**Given** the client has an expired `gm_access` and an invalid or absent `gm_refresh`  
**When** making a request to any protected endpoint  
**Then**
- Status `401 Unauthorized`
- Body: `{ "error": { "code": "UNAUTHORIZED" } }`
- Both cookies are cleared (`Max-Age=0`)

---

### Scenario 9 — Access Protected Route Without Session

**Given** the client has **neither** a `gm_access` **nor** a `gm_refresh` cookie
**When** making a request to any protected endpoint
**Then**
- Status `401 Unauthorized`
- No refresh is attempted

---

### Scenario 9b — Access Protected Route with Only a Refresh Cookie

**Given** the client has no `gm_access` cookie but a valid `gm_refresh`
**When** making a request to any protected endpoint
**Then**
- The middleware treats it exactly like an expired access token: it renews from `gm_refresh`
- Both cookies are re-issued and the handler runs normally — Status `200 OK`

> A missing `gm_access` is not a missing session. The cookie holds a 10-minute token and both
> session cookies carry the same (long) `Max-Age`, so `gm_access` is routinely stale and can be
> absent while `gm_refresh` is still valid. Refusing the request here made every idle gap an
> unrecoverable 401 and forced the user to re-enter their password.

---

### Scenario 10 — Access Route with Incorrect Role

**Given** the client is authenticated with `role = "agent"`  
**When** making a request to an endpoint requiring `role = "admin"` (e.g. `POST /api/agents/invite`)  
**Then**
- Status `403 Forbidden`
- Body: `{ "error": { "code": "FORBIDDEN" } }`

---

### Scenario 11 — Successful Logout

**Given** the client has valid `gm_access` and `gm_refresh` cookies  
**When** a `POST /api/auth/logout` request is made (no body — reads cookies automatically)  
**Then**
- Status `200 OK`
- Body: `{ "message": "Sesión cerrada correctamente." }`
- Cookie `gm_access` is cleared (`Max-Age=0`)
- Cookie `gm_refresh` is cleared (`Max-Age=0`)
- The refresh token is revoked in Agnostic Auth (cannot be reused)

---

### Scenario 12 — Logout Without Active Session

**Given** the client does not have a `gm_refresh` cookie  
**When** a `POST /api/auth/logout` request is made  
**Then**
- Status `200 OK` (idempotent — logging out without a session is not an error)
- Cookies are cleared anyway

---

## Definition of Done

- [ ] All scenarios have passing tests (`test/auth/admin-login-session.test.ts`)
- [ ] Auth middleware is implemented and tested in isolation
- [ ] Role middleware is implemented and tested in isolation
- [ ] Tokens never appear in any response body (verified in tests)
- [ ] Transparent renewal (Scenario 7) is covered by integration tests
- [ ] Logout revokes the token in Agnostic Auth (mock verified in test)
