# Feature: Password Recovery

## Contexto

Solo el administrador usa contraseña en Turistear Ya! Cuando la olvida puede solicitar un reset por email. El flujo consta de dos pasos: solicitar el link y confirmar la nueva contraseña. Al completar el reset **no se establece sesión** — el admin debe hacer login con la nueva contraseña.

**User Stories:** US-A04  
**Endpoints:** `POST /api/auth/forgot-password`, `POST /api/auth/reset-password`  
**Referencia completa:** `docs/auth/user-story-admin-registration.md`

---

## Escenarios

### Escenario 1 — Solicitud de reset para email registrado

**Given** que existe un usuario con `email = "leo@empresa.com"` y `role = "admin"`  
**When** `POST /api/auth/forgot-password` con body:
```json
{ "email": "leo@empresa.com" }
```
**Then**
- Status `200 OK`
- Body: `{ "message": "Si el correo está registrado, recibirás instrucciones." }`
- Se crea un registro en `password_reset_tokens` para ese usuario con `expires_at = now + 1h`
- Se envía email via Resend con el link de reset
- No se establecen cookies

---

### Escenario 2 — Solicitud de reset para email NO registrado

**Given** que no existe ningún usuario con `email = "noexiste@empresa.com"`  
**When** `POST /api/auth/forgot-password` con ese email  
**Then**
- Status `200 OK`
- Body: `{ "message": "Si el correo está registrado, recibirás instrucciones." }`
- **Mismo response que el Escenario 1** — no se filtra si el email existe o no
- No se crea ningún registro en D1
- No se envía email

---

### Escenario 3 — Token previo se invalida al solicitar uno nuevo

**Given** que ya existe un token de reset activo para `"leo@empresa.com"`  
**When** `POST /api/auth/forgot-password` con ese email por segunda vez  
**Then**
- Status `200 OK`
- El token anterior es eliminado de `password_reset_tokens`
- Se crea un nuevo token con nueva expiración
- Solo existe un token activo por usuario en todo momento

---

### Escenario 4 — Reset de contraseña exitoso

**Given** que existe un token válido (< 1h) en `password_reset_tokens` para el usuario `"leo@empresa.com"`  
**When** `POST /api/auth/reset-password` con body:
```json
{
  "token": "a3f9c2d1e8b7...",
  "password": "NuevaS3cur3Pass!"
}
```
**Then**
- Status `200 OK`
- Body: `{ "message": "Contraseña actualizada correctamente." }`
- El `password_hash` del usuario en D1 se actualiza
- El nuevo hash no es igual a la contraseña en texto plano
- El token se elimina de `password_reset_tokens` (single-use)
- **No se establecen cookies** — el admin debe hacer login

---

### Escenario 5 — Token de reset inválido o inexistente

**Given** cualquier estado del sistema  
**When** `POST /api/auth/reset-password` con un token que no existe en D1  
**Then**
- Status `400 Bad Request`
- Body: `{ "error": { "code": "INVALID_TOKEN" } }`
- No se modifica ningún `password_hash`

---

### Escenario 6 — Token de reset expirado (> 1 hora)

**Given** que existe un token en `password_reset_tokens` con `expires_at` en el pasado  
**When** `POST /api/auth/reset-password` con ese token  
**Then**
- Status `400 Bad Request`
- Body: `{ "error": { "code": "INVALID_TOKEN" } }`
- No se modifica ningún `password_hash`

---

### Escenario 7 — Token de reset ya consumido

**Given** que un token fue usado exitosamente (ya no existe en D1)  
**When** `POST /api/auth/reset-password` con el mismo token  
**Then**
- Status `400 Bad Request`
- Body: `{ "error": { "code": "INVALID_TOKEN" } }`

---

### Escenario 8 — Campos faltantes en reset

**Given** cualquier estado del sistema  
**When** `POST /api/auth/reset-password` sin `token` o sin `password`  
**Then**
- Status `400 Bad Request`
- Body: `{ "error": { "code": "VALIDATION_ERROR" } }`

---

## Definition of Done

- [ ] Todos los escenarios tienen test que pasa (`test/auth/password-recovery.test.ts`)
- [ ] Migration `0004_create_password_reset_tokens.sql` aplicada
- [ ] El reset nunca establece cookies (verificado en test)
- [ ] Solo existe un token de reset activo por usuario (Escenario 3 cubierto)
- [ ] Resend es llamado solo cuando el email existe (mock verificado)
- [ ] El response del Escenario 1 y 2 es idéntico (timing-safe, no filtra existencia)
