# GuideMe — Arquitectura del Sistema

## Visión General

GuideMe se compone de cuatro servicios independientes que se comunican entre sí. La UI nunca interactúa directamente con los servicios internos ni manipula tokens — toda la lógica de sesión y autenticación ocurre en el servidor.

```
┌─────────────────────────────────────────────────────────────┐
│                        INTERNET                             │
│                                                             │
│   ┌──────────────────┐         ┌──────────────────────┐    │
│   │   UI (SPA)       │         │   Meta WhatsApp API  │    │
│   │ app.guideme.com  │         │  (webhook events)    │    │
│   └────────┬─────────┘         └──────────┬───────────┘    │
│            │ HTTPS + cookies               │ HTTPS POST     │
└────────────┼───────────────────────────────┼────────────────┘
             │                               │
    ┌────────▼───────────────────────────────▼────────┐
    │              CLOUDFLARE NETWORK                  │
    │                                                  │
    │  ┌──────────────────────┐  Service  ┌─────────┐ │
    │  │     api-guideme      │  Binding  │whatsapp │ │
    │  │   api.guideme.com    │◄──────────│ -worker │ │
    │  │   (Hono Worker/BFF)  │           └─────────┘ │
    │  └──────┬──────────┬────┘                        │
    │         │          │  Service Binding             │
    │         │          └──────────────────┐           │
    │         │                    ┌────────▼─────────┐ │
    │         │                    │  agnostic-auth   │ │
    │         │                    │  (Auth Worker)   │ │
    │         │                    └──────────────────┘ │
    │  ┌──────▼──────┐                                  │
    │  │Cloudflare D1│      ── Resend (HTTP externo)    │
    │  │  (SQLite)   │      ── Meta WhatsApp (HTTP ext) │
    │  └─────────────┘                                  │
    └──────────────────────────────────────────────────┘
```

---

## Servicios

### 1. UI — Aplicación Frontend (SPA)

- **Dominio:** `app.guideme.com`
- **Tecnología:** SPA (React / Next / Vite) — por definir
- **Responsabilidad:** Interfaz de usuario para admin y agentes. Mobile-first.
- **Comunicación:** Solo habla con `api-guideme`. Nunca llama a otros servicios directamente.
- **Manejo de sesión:** No almacena tokens. La sesión vive en cookies HttpOnly gestionadas por `api-guideme`. El frontend usa `credentials: 'include'` en todos los fetch.

### 2. api-guideme — Backend for Frontend (BFF)

- **Dominio:** `api.guideme.com`
- **Runtime:** Cloudflare Worker (Hono)
- **Responsabilidad:** Punto de entrada único para la UI. Gestiona sesión, autorización, lógica de negocio, acceso a D1 y orquestación de llamadas a servicios internos y externos.
- **Bindings:**

| Binding | Tipo | Propósito |
|---|---|---|
| `DB` | D1Database | Base de datos principal |
| `AGNOSTIC_AUTH_API` | Fetcher (Service Binding) | Emitir y renovar JWT |
| `WHATSAPP_WORKER` | Fetcher (Service Binding) | Enviar mensajes vía WhatsApp Worker |
| `RESEND_API_KEY` | Secret | Envío de emails transaccionales |
| `WHATSAPP_API_TOKEN` | Secret | Meta WhatsApp Cloud API |
| `WHATSAPP_PHONE_NUMBER_ID` | Secret | Número de WhatsApp registrado en Meta |
| `AGNOSTIC_AUTH_APP_ID` | Var | `"guide-me"` — appId registrado en Agnostic Auth |
| `QR_SECRET` | Secret | Clave HMAC para firmar/verificar códigos QR |
| `COOKIE_DOMAIN` | Var | `.guideme.com` |

### 3. agnostic-auth — Proveedor de Identidad (IdP)

- **Servicio:** `agnostic-auth` (Cloudflare Worker existente)
- **Acceso desde api-guideme:** Service Binding `AGNOSTIC_AUTH_API`
- **Responsabilidad:** Emitir JWT (access token) y refresh tokens. Gestionar magic links en KV. Rotar tokens (RTR).
- **api-guideme nunca expone estos tokens al frontend** — los lee de la respuesta de Agnostic Auth y los escribe como cookies.

### 4. whatsapp-worker — Webhook de Meta WhatsApp

- **Servicio:** Worker separado (repositorio independiente o en este monorepo)
- **Responsabilidad:**
  - Recibir eventos del webhook de Meta WhatsApp Cloud API (mensajes entrantes, status de entrega).
  - Validar la firma HMAC-SHA256 de Meta en cada request.
  - Reenviar eventos relevantes a `api-guideme` via Service Binding.
- **En Fase 1:** Solo recibe confirmaciones de entrega de los mensajes enviados (comprobantes, magic links). El procesamiento de mensajes entrantes es Fase 2.
- **Binding en api-guideme:** `WHATSAPP_WORKER: Fetcher` — api-guideme puede enviar mensajes usando este binding como proxy (opcional; también puede llamar a Meta directamente).

---

## Patrón BFF — Sesión con Cookies HttpOnly

### Por qué BFF con cookies

La UI nunca almacena el JWT en `localStorage` ni en memoria JavaScript expuesta. Todas las credenciales viven en cookies HttpOnly, que el navegador incluye automáticamente en cada request y que JavaScript no puede leer. Esto elimina el riesgo de robo de tokens por XSS.

### Cookies de sesión

| Cookie | Contenido | Duración | Configuración |
|---|---|---|---|
| `gm_access` | JWT emitido por Agnostic Auth | 15 min | `HttpOnly; Secure; SameSite=Lax; Domain=.guideme.com` |
| `gm_refresh` | Refresh token de Agnostic Auth | 7 días | `HttpOnly; Secure; SameSite=Lax; Domain=.guideme.com; Path=/api/auth/refresh` |

> `gm_refresh` se restringe al path `/api/auth/refresh` para que el navegador solo lo envíe cuando la app pida explícitamente un refresh, nunca en requests normales de datos.

### Configuración de dominio y CORS

- UI en `app.guideme.com`, API en `api.guideme.com` — mismo dominio raíz `.guideme.com`.
- Cookie con `Domain=.guideme.com` → válida para ambos subdominios.
- `SameSite=Lax` → el navegador envía la cookie automáticamente en requests same-site. No requiere `SameSite=None`.
- CORS en `api-guideme`: `Access-Control-Allow-Origin: https://app.guideme.com` + `Access-Control-Allow-Credentials: true`.

---

## Flujos de Comunicación

### Login / Obtención de tokens

```
UI                       api-guideme              agnostic-auth
│                             │                        │
│  POST /api/auth/login       │                        │
│  { email, password }        │                        │
│────────────────────────────►│                        │
│                             │  POST /auth/initiate   │
│                             │  { appId, identity }   │
│                             │───────────────────────►│
│                             │◄───────────────────────│
│                             │  { token }             │
│                             │                        │
│                             │  POST /auth/verify     │
│                             │  { appId, token }      │
│                             │───────────────────────►│
│                             │◄───────────────────────│
│                             │  { jwt, refreshToken } │
│                             │                        │
│◄────────────────────────────│                        │
│  200 OK                     │                        │
│  Set-Cookie: gm_access=jwt  │                        │
│  Set-Cookie: gm_refresh=... │                        │
```

### Request autenticado (middleware de api-guideme)

```
UI                        api-guideme
│                              │
│  GET /api/services           │
│  Cookie: gm_access=jwt       │
│─────────────────────────────►│
│                              │  1. Lee gm_access cookie
│                              │  2. Verifica JWT (firma + exp)
│                              │  3. Extrae sub (email/teléfono)
│                              │  4. Lookup usuario en D1
│                              │  5. Adjunta user al contexto Hono
│                              │  6. Ejecuta handler
│◄─────────────────────────────│
│  200 OK { services: [...] }  │
```

### Renovación transparente de sesión (token refresh)

```
UI                        api-guideme              agnostic-auth
│                              │                        │
│  GET /api/dashboard          │                        │
│  Cookie: gm_access=EXPIRADO  │                        │
│  Cookie: gm_refresh=rt_...   │                        │
│─────────────────────────────►│                        │
│                              │  JWT expirado → leer gm_refresh
│                              │  POST /auth/refresh    │
│                              │  { appId, refreshToken }
│                              │───────────────────────►│
│                              │◄───────────────────────│
│                              │  { jwt, refreshToken } │
│                              │  (RTR: refresh rotado) │
│◄─────────────────────────────│                        │
│  200 OK { dashboard }        │                        │
│  Set-Cookie: gm_access=nuevo │                        │
│  Set-Cookie: gm_refresh=nuevo│                        │
```

> El frontend **no sabe** que hubo un refresh. La respuesta llega con los datos y las cookies nuevas, de forma completamente transparente.

### Envío de mensaje WhatsApp (desde api-guideme)

```
api-guideme                  whatsapp-worker          Meta Cloud API
│                                  │                       │
│  Confirmar venta → generar QR    │                       │
│  → notificar cliente             │                       │
│                                  │                       │
│  Service Binding call            │                       │
│  POST /send { to, template, vars}│                       │
│─────────────────────────────────►│                       │
│                                  │  POST /messages       │
│                                  │  (Bearer token Meta)  │
│                                  │──────────────────────►│
│                                  │◄──────────────────────│
│                                  │  { message_id }       │
│◄─────────────────────────────────│                       │
│  { message_id }                  │                       │
```

### Webhook entrante de Meta WhatsApp

```
Meta Cloud API            whatsapp-worker           api-guideme
│                               │                        │
│  POST /webhook                │                        │
│  X-Hub-Signature-256: sha256= │                        │
│──────────────────────────────►│                        │
│                               │  1. Validar firma HMAC │
│                               │  2. Parsear evento     │
│                               │  3. (Fase 1: solo      │
│                               │     status updates)    │
│                               │                        │
│                               │  Service Binding call  │
│                               │  POST /internal/wa-event
│                               │───────────────────────►│
│                               │                        │  Actualizar estado
│                               │                        │  de mensaje en D1
│◄──────────────────────────────│                        │
│  200 OK                       │                        │
```

---

## Middleware de Autorización en api-guideme

Todo endpoint protegido pasa por el middleware de auth antes de llegar al handler:

```
Request
  │
  ├─► [auth middleware]
  │     ├─ Leer cookie gm_access
  │     ├─ Si no existe → 401 UNAUTHORIZED
  │     ├─ Verificar JWT (firma, exp)
  │     │   ├─ Válido → continuar
  │     │   └─ Expirado → intentar refresh con gm_refresh
  │     │       ├─ Refresh OK → renovar cookies → continuar
  │     │       └─ Refresh inválido → limpiar cookies → 401
  │     ├─ Extraer sub (identity) del JWT
  │     ├─ Lookup usuario en D1 por identity
  │     │   └─ No encontrado → 401
  │     └─ Adjuntar { user_id, role, organization_id } al contexto
  │
  └─► [role middleware] (en rutas que lo requieran)
        ├─ Verificar c.var.user.role === "admin" (o "agent")
        └─ Si no corresponde → 403 FORBIDDEN
  │
  └─► Handler de negocio
```

---

## Estructura de Workers en Cloudflare

```
Cuenta Cloudflare leolicona-dev
│
├── api-guideme              ← Este repositorio (api-guideme/)
│   ├── Binding D1: guideme-db
│   ├── Service Binding: AGNOSTIC_AUTH_API → agnostic-auth
│   └── (opcional) Service Binding: WHATSAPP_WORKER → whatsapp-worker
│
├── agnostic-auth            ← Worker existente (repositorio separado)
│   └── KV: tokens de verificación y refresh
│
└── whatsapp-worker          ← [PLACEHOLDER: Worker a crear]
    └── Service Binding: API_GUIDEME → api-guideme
```

---

## Configuración `wrangler.jsonc` de api-guideme

```jsonc
{
  "name": "api-guideme",
  "compatibility_date": "2025-08-03",
  "main": "./src/index.tsx",
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "guideme-db",
      "database_id": "PLACEHOLDER"  // Reemplazar tras: wrangler d1 create guideme-db
    }
  ],
  "services": [
    {
      "binding": "AGNOSTIC_AUTH_API",
      "service": "agnostic-auth"
    }
    // Descomentar cuando whatsapp-worker esté creado:
    // { "binding": "WHATSAPP_WORKER", "service": "whatsapp-worker" }
  ],
  "vars": {
    "AGNOSTIC_AUTH_APP_ID": "guide-me",
    "COOKIE_DOMAIN": ".guideme.com",
    "CORS_ORIGIN": "https://app.guideme.com"
  }
  // Secrets (wrangler secret put <NAME>):
  // RESEND_API_KEY
  // WHATSAPP_API_TOKEN
  // WHATSAPP_PHONE_NUMBER_ID
  // QR_SECRET
}
```

---

## Decisiones de Arquitectura y Justificación

| Decisión | Alternativa descartada | Por qué |
|---|---|---|
| Cookies HttpOnly para sesión | JWT en localStorage / memory | XSS no puede robar cookies HttpOnly. localStorage es vulnerable. |
| Dos cookies (access + refresh) | Session ID en KV | Evita un lookup en KV por cada request. El JWT es autocontenido. |
| `gm_refresh` restringido a `/api/auth/refresh` | Refresh en cualquier path | El navegador solo envía el refresh token cuando la app lo necesita explícitamente. |
| Service Binding para auth | HTTP fetch a URL pública | Cero latencia, sin egress cost, comunicación interna en la red de Cloudflare. |
| Worker separado para WhatsApp webhook | Ruta dentro de api-guideme | Aislamiento de responsabilidades. El webhook de Meta puede tener picos de tráfico independientes. Firma HMAC se valida sin pasar por la lógica de negocio. |
| SameSite=Lax (no None) | SameSite=None | Mismo dominio raíz, no se necesita None. Lax es más seguro y no requiere HTTPS estricto en dev. |

---

## Placeholders Pendientes

| Item | Acción requerida |
|---|---|
| `database_id` en `wrangler.jsonc` | Ejecutar `wrangler d1 create guideme-db` y pegar el ID |
| `appId: "guide-me"` en Agnostic Auth | Confirmar que `guide-me` está registrado en el App Registry de agnostic-auth |
| `whatsapp-worker` | Crear el Worker, configurar webhook en Meta Business, agregar Service Binding |
| Dominio `guideme.com` | Configurar DNS en Cloudflare, rutas de Workers para `api.guideme.com` y `app.guideme.com` |
| Templates de WhatsApp | Crear y obtener aprobación de Meta para: comprobante de venta, magic link, notificación de cancelación |
