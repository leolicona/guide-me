# Feature: Agent Magic Link Login

## Contexto

Los agentes de ventas no usan contraseña. Para iniciar sesión solicitan un magic link que llega a su email o WhatsApp (según el `identity_type` registrado). Al hacer clic en el link se establece sesión mediante cookies HttpOnly. El endpoint `GET /api/auth/verify` es compartido con el flujo de verificación de registro del admin.

**User Stories:** US-AG02  
**Endpoints:** `POST /api/auth/magic-link`, `GET /api/auth/verify?token=xxx`  
**Referencia completa:** `docs/auth/user-story-admin-registration.md`

---

## Escenarios

### Escenario 1 — Agente solicita magic link por email exitosamente

**Given** que existe un usuario con `identity = "agente@empresa.com"`, `identity_type = "email"`, `role = "agent"`, `status = "active"`  
**When** `POST /api/auth/magic-link` con body:
```json
{ "identity": "agente@empresa.com" }
```
**Then**
- Status `200 OK`
- Body: `{ "message": "Si el identity está registrado, recibirás un enlace de acceso." }`
- Se llama `POST /auth/initiate` en Agnostic Auth con `{ appId, identity: "agente@empresa.com" }`
- Se envía email via Resend con el magic link
- `whatsapp-worker` **no** es llamado
- No se establecen cookies

---

### Escenario 2 — Agente solicita magic link por WhatsApp exitosamente

**Given** que existe un usuario con `identity = "+52 55 9876 5432"`, `identity_type = "phone"`, `role = "agent"`, `status = "active"`  
**When** `POST /api/auth/magic-link` con body:
```json
{ "identity": "+52 55 9876 5432" }
```
**Then**
- Status `200 OK`
- Body: `{ "message": "Si el identity está registrado, recibirás un enlace de acceso." }`
- Se llama `POST /auth/initiate` en Agnostic Auth con `{ appId, identity: "+52 55 9876 5432" }`
- Se envía mensaje via `whatsapp-worker` (Service Binding) con el magic link
- Resend **no** es llamado
- No se establecen cookies

---

### Escenario 3 — Identity no registrado en el sistema

**Given** que no existe ningún usuario con `identity = "noexiste@empresa.com"`  
**When** `POST /api/auth/magic-link` con ese identity  
**Then**
- Status `200 OK`
- Body: `{ "message": "Si el identity está registrado, recibirás un enlace de acceso." }`
- **Mismo response que Escenario 1** — no se filtra existencia
- Agnostic Auth **no** es llamado
- No se envía ningún mensaje ni email

---

### Escenario 4 — Usuario existe pero no tiene rol `agent` ni `client`

**Given** que existe un usuario con `identity = "leo@empresa.com"` y `role = "admin"`  
**When** `POST /api/auth/magic-link` con ese identity  
**Then**
- Status `200 OK`
- Body: `{ "message": "Si el identity está registrado, recibirás un enlace de acceso." }`
- El magic link **no** es enviado (el admin usa login con contraseña, no magic link)
- Respuesta idéntica para no filtrar el rol del usuario

---

### Escenario 5 — Usuario con cuenta suspendida

**Given** que existe un usuario con `identity = "agente@empresa.com"`, `role = "agent"`, `status = "suspended"`  
**When** `POST /api/auth/magic-link` con ese identity  
**Then**
- Status `200 OK`
- Body: `{ "message": "Si el identity está registrado, recibirás un enlace de acceso." }`
- El magic link **no** es enviado
- Respuesta idéntica para no filtrar el estado del usuario

---

### Escenario 6 — Campo identity faltante

**Given** cualquier estado del sistema  
**When** `POST /api/auth/magic-link` con body vacío o sin campo `identity`  
**Then**
- Status `400 Bad Request`
- Body: `{ "error": { "code": "VALIDATION_ERROR" } }`

---

### Escenario 7 — Agente verifica magic link exitosamente

**Given** que existe un token válido (< 10 min) generado para `"agente@empresa.com"` con `role = "agent"`, `status = "active"`  
**When** `GET /api/auth/verify?token=<token_valido>`  
**Then**
- Status `200 OK`
- Body: `{ "user": { "name": "Carlos López", "role": "agent" } }`
- Se establece cookie `gm_access` (HttpOnly, Secure, SameSite=Lax, Path=/, Max-Age=900)
- Se establece cookie `gm_refresh` (HttpOnly, Secure, SameSite=Lax, Path=/api/auth/refresh, Max-Age=604800)
- Los tokens **no aparecen** en el response body
- El usuario en D1 no se modifica (ya estaba `active`)

---

### Escenario 8 — Token de magic link expirado (> 10 minutos)

**Given** que existe un token generado hace más de 10 minutos  
**When** `GET /api/auth/verify?token=<token_expirado>`  
**Then**
- Status `400 Bad Request`
- Body: `{ "error": { "code": "INVALID_TOKEN" } }`
- No se establecen cookies

---

### Escenario 9 — Token de magic link ya consumido (single-use)

**Given** que un token ya fue verificado exitosamente  
**When** `GET /api/auth/verify?token=<mismo_token>` por segunda vez  
**Then**
- Status `400 Bad Request`
- Body: `{ "error": { "code": "INVALID_TOKEN" } }`
- No se establecen cookies

---

### Escenario 10 — Token inexistente

**Given** cualquier estado del sistema  
**When** `GET /api/auth/verify?token=tokenquenuncaexistio`  
**Then**
- Status `400 Bad Request`
- Body: `{ "error": { "code": "INVALID_TOKEN" } }`

---

## Nota sobre el endpoint `/api/auth/verify`

Este endpoint es **compartido** entre tres flujos:

| Flujo | Qué hace al verificar |
|---|---|
| Verificación de email admin | Cambia `status` de `unverified` → `active`, luego establece sesión |
| Magic link de agente | El usuario ya está `active`, solo establece sesión |
| Magic link de cliente | El usuario ya está `active`, establece sesión (Fase 2) |

El comportamiento post-verificación se determina consultando el `status` y `role` del usuario en D1 usando el `sub` (identity) del JWT retornado por Agnostic Auth.

---

## Definition of Done

- [ ] Todos los escenarios tienen test que pasa (`test/auth/agent-magic-link.test.ts`)
- [ ] El response de `POST /api/auth/magic-link` es idéntico independientemente de si el identity existe (Escenarios 1, 3, 4, 5 — verificado en test)
- [ ] El canal de entrega (Resend vs whatsapp-worker) se determina por `identity_type` (verificado con mocks)
- [ ] El token de magic link es single-use (Escenario 9 cubierto)
- [ ] El endpoint `/api/auth/verify` maneja correctamente los tres flujos según `role` y `status` del usuario
