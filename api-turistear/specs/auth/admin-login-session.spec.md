# Feature: Admin Login & Session Management

## Contexto

El admin accede a la plataforma con email y contraseña. `api-turistear` actúa como BFF: obtiene los tokens de Agnostic Auth y los guarda en cookies HttpOnly. La UI nunca ve los tokens. La renovación de sesión ocurre de forma transparente en el middleware cuando `gm_access` expira.

**User Stories:** US-A03  
**Endpoints:** `POST /api/auth/login`, `POST /api/auth/refresh`, `POST /api/auth/logout`  
**Referencia completa:** `docs/auth/user-story-admin-registration.md`

---

## Escenarios

### Escenario 1 — Login exitoso

**Given** que existe un usuario con `email = "leo@empresa.com"`, `status = "active"`, y `password_hash` que corresponde a `"S3cur3Pass!"`  
**When** `POST /api/auth/login` con body:
```json
{ "email": "leo@empresa.com", "password": "S3cur3Pass!" }
```
**Then**
- Status `200 OK`
- Body: `{ "user": { "name": "Leo Licona", "role": "admin" } }`
- Se establece cookie `gm_access` (`HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=900`)
- Se establece cookie `gm_refresh` (`HttpOnly; Secure; SameSite=Lax; Path=/api/auth/refresh; Max-Age=604800`)
- Los tokens **no aparecen** en el response body

---

### Escenario 2 — Contraseña incorrecta

**Given** que existe un usuario con `email = "leo@empresa.com"`  
**When** `POST /api/auth/login` con `password = "ContraseñaIncorrecta"`  
**Then**
- Status `401 Unauthorized`
- Body: `{ "error": { "code": "INVALID_CREDENTIALS" } }`
- No se establecen cookies
- El mensaje de error **no indica** si el email o la contraseña es lo incorrecto

---

### Escenario 3 — Email no registrado

**Given** que no existe ningún usuario con `email = "noexiste@empresa.com"`  
**When** `POST /api/auth/login` con ese email  
**Then**
- Status `401 Unauthorized`
- Body: `{ "error": { "code": "INVALID_CREDENTIALS" } }`
- Mismo error que contraseña incorrecta (no filtra existencia)

---

### Escenario 4 — Cuenta sin verificar

**Given** que existe un usuario con `email = "leo@empresa.com"`, `status = "unverified"`  
**When** `POST /api/auth/login` con credenciales correctas  
**Then**
- Status `403 Forbidden`
- Body: `{ "error": { "code": "EMAIL_NOT_VERIFIED" } }`
- No se establecen cookies

---

### Escenario 5 — Campos faltantes

**Given** cualquier estado del sistema  
**When** `POST /api/auth/login` sin `email` o sin `password`  
**Then**
- Status `400 Bad Request`
- Body: `{ "error": { "code": "VALIDATION_ERROR" } }`

---

### Escenario 6 — Acceso a ruta protegida con sesión válida

**Given** que el cliente tiene una cookie `gm_access` con JWT válido (no expirado)  
**When** hace un request a cualquier endpoint protegido (ej. `GET /api/services`)  
**Then**
- El middleware extrae el `sub` del JWT
- Hace lookup del usuario en D1 por `identity`
- Adjunta `{ user_id, role, organization_id }` al contexto Hono
- El handler recibe el request con el usuario en contexto
- No se establecen cookies nuevas

---

### Escenario 7 — Renovación transparente de sesión (middleware)

**Given** que el cliente tiene `gm_access` expirado y `gm_refresh` válido  
**When** hace un request a cualquier endpoint protegido  
**Then**
- El middleware detecta el JWT expirado
- Llama `POST /auth/refresh` en Agnostic Auth con el `gm_refresh` cookie
- Agnostic Auth retorna nuevo par de tokens (RTR: el refresh viejo queda invalidado)
- Se sobreescriben `gm_access` y `gm_refresh` en la respuesta
- El handler se ejecuta normalmente
- La UI recibe la respuesta de datos + las cookies nuevas (flujo transparente)

---

### Escenario 8 — Acceso con JWT expirado y refresh token inválido

**Given** que el cliente tiene `gm_access` expirado y `gm_refresh` inválido o ausente  
**When** hace un request a cualquier endpoint protegido  
**Then**
- Status `401 Unauthorized`
- Body: `{ "error": { "code": "UNAUTHORIZED" } }`
- Se limpian ambas cookies (`Max-Age=0`)

---

### Escenario 9 — Acceso a ruta protegida sin sesión

**Given** que el cliente no tiene cookie `gm_access`  
**When** hace un request a cualquier endpoint protegido  
**Then**
- Status `401 Unauthorized`
- No se intenta ningún refresh

---

### Escenario 10 — Acceso a ruta de rol incorrecto

**Given** que el cliente está autenticado con `role = "agent"`  
**When** hace un request a un endpoint que requiere `role = "admin"` (ej. `POST /api/agents/invite`)  
**Then**
- Status `403 Forbidden`
- Body: `{ "error": { "code": "FORBIDDEN" } }`

---

### Escenario 11 — Logout exitoso

**Given** que el cliente tiene cookies `gm_access` y `gm_refresh` válidas  
**When** `POST /api/auth/logout` (sin body — lee cookies automáticamente)  
**Then**
- Status `200 OK`
- Body: `{ "message": "Sesión cerrada correctamente." }`
- Cookie `gm_access` limpiada (`Max-Age=0`)
- Cookie `gm_refresh` limpiada (`Max-Age=0`)
- El refresh token queda revocado en Agnostic Auth (no puede reutilizarse)

---

### Escenario 12 — Logout sin sesión activa

**Given** que el cliente no tiene cookie `gm_refresh`  
**When** `POST /api/auth/logout`  
**Then**
- Status `200 OK` (idempotente — no es un error cerrar sesión sin tener una)
- Las cookies se limpian de todas formas

---

## Definition of Done

- [ ] Todos los escenarios tienen test que pasa (`test/auth/admin-login-session.test.ts`)
- [ ] El middleware de auth está implementado y probado de forma aislada
- [ ] El middleware de roles está implementado y probado de forma aislada
- [ ] Los tokens nunca aparecen en ningún response body (verificado en tests)
- [ ] La renovación transparente (Escenario 7) está cubierta con test de integración
- [ ] El logout revoca el token en Agnostic Auth (mock verificado en test)
