# Feature: Admin Registration

## Contexto

Un administrador de sistema se registra en GuideMe para crear su organización. Al completar el registro recibe un magic link por email. Solo tras verificarlo su cuenta queda activa y se establece sesión.

**User Stories:** US-A01, US-A02  
**Endpoints:** `POST /api/auth/register`, `GET /api/auth/verify?token=xxx`  
**Referencia completa:** `docs/auth/user-story-admin-registration.md`

---

## Escenarios

### Escenario 1 — Registro exitoso

**Given** que no existe ningún usuario con el email `"leo@empresa.com"`  
**When** `POST /api/auth/register` con body:
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
- Se crea un registro en `organizations` con `name = "Empresa S.A."`
- Se crea un registro en `users` con `email = "leo@empresa.com"`, `role = "admin"`, `status = "unverified"`, `plan = "free"`
- El `password_hash` no es igual al password en texto plano
- Se envía un email via Resend al correo registrado
- **No se establecen cookies** `gm_access` ni `gm_refresh`

---

### Escenario 2 — Email ya registrado

**Given** que ya existe un usuario con el email `"leo@empresa.com"`  
**When** `POST /api/auth/register` con ese mismo email  
**Then**
- Status `409 Conflict`
- Body: `{ "error": { "code": "EMAIL_ALREADY_EXISTS", "message": "..." } }`
- No se crea ningún registro en D1

---

### Escenario 3 — Campos faltantes

**Given** cualquier estado del sistema  
**When** `POST /api/auth/register` sin alguno de los campos requeridos (`name`, `email`, `password`, `company_name`, `phone`)  
**Then**
- Status `400 Bad Request`
- Body: `{ "error": { "code": "VALIDATION_ERROR", "message": "..." } }`
- No se crea ningún registro en D1

---

### Escenario 4 — Email con formato inválido

**Given** cualquier estado del sistema  
**When** `POST /api/auth/register` con `email = "no-es-un-email"`  
**Then**
- Status `400 Bad Request`
- Body: `{ "error": { "code": "VALIDATION_ERROR" } }`

---

### Escenario 5 — Verificación de email exitosa

**Given** que existe un usuario con `status = "unverified"` y un token válido (< 10 min) en Agnostic Auth  
**When** `GET /api/auth/verify?token=<token_valido>`  
**Then**
- Status `200 OK`
- Body: `{ "user": { "name": "Leo Licona", "role": "admin" } }`
- Se establece cookie `gm_access` con atributos `HttpOnly; Secure; SameSite=Lax; Path=/`
- Se establece cookie `gm_refresh` con atributos `HttpOnly; Secure; SameSite=Lax; Path=/api/auth/refresh`
- El usuario en D1 tiene `status = "active"`
- Los valores de los tokens **no aparecen** en el response body

---

### Escenario 6 — Token de verificación inválido o expirado

**Given** cualquier estado del sistema  
**When** `GET /api/auth/verify?token=<token_inexistente_o_expirado>`  
**Then**
- Status `400 Bad Request`
- Body: `{ "error": { "code": "INVALID_TOKEN", "message": "..." } }`
- No se modifican registros en D1
- No se establecen cookies

---

### Escenario 7 — Token de verificación ya consumido (single-use)

**Given** que un token ya fue verificado exitosamente  
**When** `GET /api/auth/verify?token=<mismo_token>` por segunda vez  
**Then**
- Status `400 Bad Request`
- Body: `{ "error": { "code": "INVALID_TOKEN" } }`

---

## Definition of Done

- [ ] Todos los escenarios tienen test que pasa (`test/auth/admin-registration.test.ts`)
- [ ] Migration `0001_create_organizations.sql` aplicada
- [ ] Migration `0002_create_users.sql` aplicada
- [ ] El password nunca se almacena en texto plano (PBKDF2 verificado en test)
- [ ] El endpoint está montado en el router de `src/index.tsx`
- [ ] Las cookies se establecen con los atributos correctos (verificado en test)
- [ ] Resend es llamado con el email correcto (mock en test)
