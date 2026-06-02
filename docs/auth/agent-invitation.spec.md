# Feature: Agent Invitation & Onboarding

## Context

The admin invites a sales agent by sending a link via email. The agent clicks on the link, views their invitation details, and completes their profile by setting their name and password. Upon completion, they are logged in immediately with session cookies set.

**User Stories:** US-A05, US-AG01  
**Endpoints:** `POST /api/agents/invite`, `GET /api/auth/invite/accept?token=xxx`, `POST /api/auth/invite/complete`  
**Full Reference:** `docs/auth/user-story-admin-registration.md`

---

## Scenarios

### Scenario 1 — Admin Invites Agent Successfully

**Given** an authenticated user exists with `role = "admin"` in the organization `"Empresa S.A."`  
**And** no user or pending invitation exists with `identity = "agente@empresa.com"`  
**When** a `POST /api/agents/invite` request is made with a valid `gm_access` cookie and body:
```json
{ "identity": "agente@empresa.com" }
```
**Then**
- Status `201 Created`
- Body: `{ "message": "Invitación enviada." }`
- A record is created in `invitations` with `status = "pending"`, `identity_type = "email"`, `expires_at = now + 7 days`
- `invited_by` points to the `user_id` of the authenticated admin
- `organization_id` is the admin's organization
- An email is sent via Resend with the invitation link (verifying email ownership)
- The link contains the generated token: `.../api/auth/invite/accept?token=<token>`

---

### Scenario 3 — Unauthenticated Agent Tries to Invite

**Given** the request does not have a `gm_access` cookie  
**When** a `POST /api/agents/invite` request is made  
**Then**
- Status `401 Unauthorized`
- Body: `{ "error": { "code": "UNAUTHORIZED" } }`

---

### Scenario 4 — User with Role `agent` Tries to Invite

**Given** an authenticated user exists with `role = "agent"`  
**When** a `POST /api/agents/invite` request is made  
**Then**
- Status `403 Forbidden`
- Body: `{ "error": { "code": "FORBIDDEN" } }`
- No record is created in D1

---

### Scenario 5 — Identity Already Registered as Active User

**Given** an active user exists with `identity = "agente@empresa.com"`  
**When** a `POST /api/agents/invite` request is made with that identity  
**Then**
- Status `409 Conflict`
- Body: `{ "error": { "code": "IDENTITY_ALREADY_EXISTS" } }`
- No invitation is created and no email is sent

---

### Scenario 6 — Previous Pending Invitation is Invalidated When Creating a New One

**Given** a pending invitation already exists for `"agente@empresa.com"`  
**When** a `POST /api/agents/invite` request is made with that same identity  
**Then**
- Status `201 Created`
- The previous invitation becomes `"expired"` (or is deleted)
- A new invitation is created with a new token and a new expiration date
- Only one active invitation exists per identity

---

### Scenario 7 — Agent Retrieves Valid Invitation Details

**Given** an invitation exists with `status = "pending"` and a non-expired token  
**When** a `GET /api/auth/invite/accept?token=<token_valido>` request is made  
**Then**
- Status `200 OK`
- Body:
```json
{
  "invitation": {
    "identity": "agente@empresa.com",
    "identity_type": "email",
    "organization_name": "Empresa S.A."
  }
}
```
- No records are modified in D1
- No cookies are set

---

### Scenario 8 — Agent Retrieves Expired or Inexistent Invitation

**Given** any system state  
**When** a `GET /api/auth/invite/accept?token=<token_expirado_o_invalido>` request is made  
**Then**
- Status `400 Bad Request`
- Body: `{ "error": { "code": "INVALID_TOKEN" } }`

---

### Scenario 9 — Agent Completes Registration Successfully

**Given** an invitation exists with `status = "pending"` and a non-expired token  
**When** a `POST /api/auth/invite/complete` request is made with body:
```json
{ "token": "a3f9c2...", "name": "Carlos López", "password": "agentPassword123!" }
```
**Then**
- Status `200 OK`
- Body: `{ "user": { "name": "Carlos López", "role": "agent" } }`
- A user is created in D1: `role = "agent"`, `status = "active"`, with `organization_id` matching the invitation, and the `password_hash` corresponding to the provided password
- The invitation status is updated to `"accepted"`
- The cookie `gm_access` is set (HttpOnly, Secure, SameSite=Lax, Path=/, Max-Age=900)
- The cookie `gm_refresh` is set (HttpOnly, Secure, SameSite=Lax, Path=/api/auth/refresh, Max-Age=604800)
- The tokens **do not appear** in the response body

---

### Scenario 10 — Agent Tries to Complete with Already Used Token

**Given** an invitation has already been accepted (`status = "accepted"`)  
**When** a `POST /api/auth/invite/complete` request is made with that same token  
**Then**
- Status `400 Bad Request`
- Body: `{ "error": { "code": "INVALID_TOKEN" } }`
- No user is created

---

### Scenario 11 — Missing Name or Password When Completing Registration

**Given** a valid invitation exists  
**When** a `POST /api/auth/invite/complete` request is made without the `name` or without the `password` field  
**Then**
- Status `400 Bad Request`
- Body: `{ "error": { "code": "VALIDATION_ERROR" } }`

---

## Definition of Done

- [ ] All scenarios have passing tests (`test/auth/agent-invitation.test.ts`)
- [ ] Migration `0003_create_invitations.sql` applied
- [ ] The admin can only invite within their own organization (verified in test)
- [ ] Resend is called with the invitation link (mock verified)
- [ ] Onboarding processes the password and stores its PBKDF2 hash (verified in test)
- [ ] Upon completing registration, cookies are set correctly (verified in test)
- [ ] An invitation token cannot be used twice (Scenario 10 covered)
