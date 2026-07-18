# Feature: Agent Invitation & Onboarding

## Contexto

El admin invita a un agente de ventas enviando un link por email o WhatsApp. El agente hace clic en el link, ve los datos de su invitación y completa su perfil (nombre). Al completar queda logueado de inmediato con cookies de sesión establecidas.

**User Stories:** US-A05, US-AG01  
**Endpoints:** `POST /api/agents/invite`, `GET /api/auth/invite/accept?token=xxx`, `POST /api/auth/invite/complete`  
**Referencia completa:** `docs/auth/user-story-admin-registration.md`

---

## Escenarios

### Escenario 1 — Admin invita agente por email exitosamente

**Given** que existe un usuario autenticado con `role = "admin"` en la organización `"Empresa S.A."`  
**And** que no existe ningún usuario ni invitación pendiente con `identity = "agente@empresa.com"`  
**When** `POST /api/agents/invite` con cookie `gm_access` válida y body:
```json
{ "identity": "agente@empresa.com", "channel": "email" }
```
**Then**
- Status `201 Created`
- Body: `{ "message": "Invitación enviada." }`
- Se crea un registro en `invitations` con `status = "pending"`, `channel = "email"`, `identity_type = "email"`, `expires_at = now + 7 días`
- `invited_by` apunta al `user_id` del admin autenticado
- `organization_id` es la organización del admin
- Se envía email via Resend con el link de invitación
- El link contiene el token generado: `.../api/auth/invite/accept?token=<token>`

---

### Escenario 2 — Admin invita agente por WhatsApp exitosamente

**Given** que existe un usuario autenticado con `role = "admin"`  
**And** que no existe ningún usuario ni invitación pendiente con `identity = "+52 55 1234 0000"`  
**When** `POST /api/agents/invite` con body:
```json
{ "identity": "+52 55 1234 0000", "channel": "whatsapp" }
```
**Then**
- Status `201 Created`
- Se crea registro en `invitations` con `channel = "whatsapp"`, `identity_type = "phone"`
- Se envía mensaje via `whatsapp-worker` (Service Binding) con el link de invitación
- Resend **no** es llamado

---

### Escenario 3 — Agente sin autenticación intenta invitar

**Given** que el request no tiene cookie `gm_access`  
**When** `POST /api/agents/invite`  
**Then**
- Status `401 Unauthorized`
- Body: `{ "error": { "code": "UNAUTHORIZED" } }`

---

### Escenario 4 — Usuario con rol `agent` intenta invitar

**Given** que existe un usuario autenticado con `role = "agent"`  
**When** `POST /api/agents/invite`  
**Then**
- Status `403 Forbidden`
- Body: `{ "error": { "code": "FORBIDDEN" } }`
- No se crea ningún registro en D1

---

### Escenario 5 — Identity ya registrado como usuario activo

**Given** que existe un usuario activo con `identity = "agente@empresa.com"`  
**When** `POST /api/agents/invite` con ese identity  
**Then**
- Status `409 Conflict`
- Body: `{ "error": { "code": "IDENTITY_ALREADY_EXISTS" } }`
- No se crea invitación ni se envía email

---

### Escenario 6 — Invitación previa pendiente se invalida al crear una nueva

**Given** que ya existe una invitación en estado `"pending"` para `"agente@empresa.com"`  
**When** `POST /api/agents/invite` con ese mismo identity  
**Then**
- Status `201 Created`
- La invitación anterior queda en estado `"expired"` (o es eliminada)
- Se crea una nueva invitación con nuevo token y nueva expiración
- Solo existe una invitación activa por identity

---

### Escenario 7 — Agente consulta su invitación válida

**Given** que existe una invitación con `status = "pending"` y token no expirado  
**When** `GET /api/auth/invite/accept?token=<token_valido>`  
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
- No se modifica ningún registro en D1
- No se establecen cookies

---

### Escenario 8 — Agente consulta invitación expirada o inexistente

**Given** cualquier estado del sistema  
**When** `GET /api/auth/invite/accept?token=<token_expirado_o_invalido>`  
**Then**
- Status `400 Bad Request`
- Body: `{ "error": { "code": "INVALID_TOKEN" } }`

---

### Escenario 9 — Agente completa su registro exitosamente

**Given** que existe una invitación con `status = "pending"` y token no expirado  
**When** `POST /api/auth/invite/complete` con body:
```json
{ "token": "a3f9c2...", "name": "Carlos López" }
```
**Then**
- Status `200 OK`
- Body: `{ "user": { "name": "Carlos López", "role": "agent" } }`
- Se crea un usuario en D1: `role = "agent"`, `status = "active"`, `organization_id` de la invitación
- La invitación queda en `status = "accepted"`
- Se establece cookie `gm_access` (HttpOnly, Secure, SameSite=Lax, Path=/, Max-Age=900)
- Se establece cookie `gm_refresh` (HttpOnly, Secure, SameSite=Lax, Path=/api/auth/refresh, Max-Age=604800)
- Los tokens **no aparecen** en el response body

---

### Escenario 10 — Agente intenta completar con token ya usado

**Given** que una invitación ya fue aceptada (`status = "accepted"`)  
**When** `POST /api/auth/invite/complete` con ese mismo token  
**Then**
- Status `400 Bad Request`
- Body: `{ "error": { "code": "INVALID_TOKEN" } }`
- No se crea ningún usuario

---

### Escenario 11 — Nombre faltante al completar registro

**Given** que existe una invitación válida  
**When** `POST /api/auth/invite/complete` sin el campo `name`  
**Then**
- Status `400 Bad Request`
- Body: `{ "error": { "code": "VALIDATION_ERROR" } }`

---

## Definition of Done

- [ ] Todos los escenarios tienen test que pasa (`test/auth/agent-invitation.test.ts`)
- [ ] Migration `0003_create_invitations.sql` aplicada
- [ ] El admin solo puede invitar dentro de su propia organización (verificado en test)
- [ ] Resend es llamado solo cuando `channel = "email"` (mock verificado)
- [ ] `whatsapp-worker` Service Binding es llamado solo cuando `channel = "whatsapp"` (mock verificado)
- [ ] Al completar el registro, las cookies se establecen correctamente (verificado en test)
- [ ] Un token de invitación no puede usarse dos veces (Escenario 10 cubierto)
