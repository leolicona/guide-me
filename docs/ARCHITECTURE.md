# Turistear Ya! — System Architecture

## Overview

Turistear Ya! consists of four independent services that communicate with each other. The UI never interacts directly with internal services or manipulates tokens — all session and authentication logic occurs on the server.

```
┌─────────────────────────────────────────────────────────────┐
│                        INTERNET                             │
│                                                             │
│   ┌──────────────────┐         ┌──────────────────────┐    │
│   │   UI (SPA)       │         │  Meta WhatsApp API   │    │
│   │ app.turistear.com  │         │ (outbound templates) │    │
│   └────────┬─────────┘         └──────────▲───────────┘    │
│            │ HTTPS + cookies              │ HTTPS POST     │
│            │                              │                │
└────────────┼──────────────────────────────┼────────────────┘
             │                              │
    ┌────────▼──────────────────────────────┼─────────┐
    │              CLOUDFLARE NETWORK       │         │
    │                                       │         │
    │  ┌──────────────────────┐  Service  ┌─┴───────┐ │
    │  │     api-turistear      │  Binding  │whatsapp │ │
    │  │   api.turistear.com    │──────────►│ -worker │ │
    │  │   (Hono Worker/BFF)  │           └─────────┘ │
    │  └──────┬──────────┬────┘                        │
    │         │          │  Service Binding             │
    │         │          └──────────────────┐           │
    │         │                    ┌────────▼─────────┐ │
    │         │                    │  agnostic-auth   │ │
    │         │                    │  (Auth Worker)   │ │
    │         │                    └──────────────────┘ │
    │  ┌──────▼──────┐                                  │
    │  │Cloudflare D1│      ── Resend (external HTTP)   │
    │  │  (SQLite)   │                                  │
    │  └─────────────┘                                  │
    └──────────────────────────────────────────────────┘
```

---

## Services

### 1. UI — Frontend Application (SPA)

- **Domain:** `app.turistear.com`
- **Technology:** SPA (React / Next / Vite) — to be defined
- **Responsibility:** User interface for admins and agents. Mobile-first.
- **Communication:** Only talks to `api-turistear`. Never calls other services directly.
- **Session Management:** Does not store tokens. The session lives in HttpOnly cookies managed by `api-turistear`. The frontend uses `credentials: 'include'` on all fetches.

### 2. api-turistear — Backend for Frontend (BFF)

- **Domain:** `api.turistear.com`
- **Runtime:** Cloudflare Worker (Hono)
- **Responsibility:** Single entry point for the UI. Manages sessions, authorization, business logic, D1 access, and orchestration of calls to internal and external services.
- **Bindings:**

| Binding | Type | Purpose |
|---|---|---|
| `DB` | D1Database | Main database |
| `AGNOSTIC_AUTH_API` | Fetcher (Service Binding) | Issue and renew JWTs |
| `WHATSAPP_WORKER` | Fetcher (Service Binding) | Send messages via WhatsApp Worker |
| `RESEND_API_KEY` | Secret | Transmit transactional emails |
| `WHATSAPP_API_TOKEN` | Secret | Meta WhatsApp Cloud API |
| `WHATSAPP_PHONE_NUMBER_ID` | Secret | Registered WhatsApp number ID with Meta |
| `AGNOSTIC_AUTH_APP_ID` | Var | `"guide-me"` — appId registered in Agnostic Auth |
| `QR_SECRET` | Secret | HMAC key to sign/verify QR codes |
| `COOKIE_DOMAIN` | Var | `.turistear.com` |

### 3. agnostic-auth — Identity Provider (IdP)

- **Service:** `agnostic-auth` (existing Cloudflare Worker)
- **Access from api-turistear:** Service Binding `AGNOSTIC_AUTH_API`
- **Responsibility:** Issue JWTs (access token) and refresh tokens. Manage magic links in KV. Rotate tokens (RTR).
- **api-turistear never exposes these tokens to the frontend** — it reads them from the Agnostic Auth response and writes them as cookies.

### 4. whatsapp-worker — WhatsApp Integration Proxy

- **Service:** Separate Worker (independent repository or in this monorepo)
- **Responsibility:**
  - Standardize and format requests before dispatching them to the Meta WhatsApp Cloud API.
  - Send outbound purchase receipts and QR tickets to clients.
  - Webhooks and incoming message processing are disabled/not supported (the only WhatsApp integration is outbound to send tickets).
- **Binding in api-turistear:** `WHATSAPP_WORKER: Fetcher` — api-turistear calls this binding to proxy outbound messages to the Meta Cloud API.

---

## BFF Pattern — Sessions with HttpOnly Cookies

### Why BFF with Cookies

The UI never stores the JWT in `localStorage` or in exposed JavaScript memory. All credentials live in HttpOnly cookies, which the browser automatically includes in every request and that JavaScript cannot read. This eliminates the risk of token theft via XSS.

### Session Cookies

| Cookie | Content | Duration | Configuration |
|---|---|---|---|
| `gm_access` | JWT issued by Agnostic Auth | 15 min | `HttpOnly; Secure; SameSite=Lax; Domain=.turistear.com` |
| `gm_refresh` | Refresh token from Agnostic Auth | 7 days | `HttpOnly; Secure; SameSite=Lax; Domain=.turistear.com; Path=/api/auth/refresh` |

> `gm_refresh` is restricted to the `/api/auth/refresh` path so that the browser only sends it when the app explicitly requests a refresh, never during normal data requests.

### Domain and CORS Configuration

- UI on `app.turistear.com`, API on `api.turistear.com` — same root domain `.turistear.com`.
- Cookie with `Domain=.turistear.com` → valid for both subdomains.
- `SameSite=Lax` → the browser automatically sends the cookie in same-site requests. Does not require `SameSite=None`.
- CORS in `api-turistear`: `Access-Control-Allow-Origin: https://app.turistear.com` + `Access-Control-Allow-Credentials: true`.

---

## Communication Flows

### Login / Token Acquisition

```
UI                       api-turistear              agnostic-auth
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

### Authenticated Request (api-turistear middleware)

```
UI                        api-turistear
│                              │
│  GET /api/services           │
│  Cookie: gm_access=jwt       │
│─────────────────────────────►│
│                              │  1. Read gm_access cookie
│                              │  2. Verify JWT (signature + exp)
│                              │  3. Extract sub (email/phone)
│                              │  4. Lookup user in D1
│                              │  5. Attach user to Hono context
│                              │  6. Execute handler
│◄─────────────────────────────│
│  200 OK { services: [...] }  │
```

### Transparent Session Renewal (Token Refresh)

```
UI                        api-turistear              agnostic-auth
│                              │                        │
│  GET /api/dashboard          │                        │
│  Cookie: gm_access=EXPIRED   │                        │
│  Cookie: gm_refresh=rt_...   │                        │
│─────────────────────────────►│                        │
│                              │  Expired JWT → read gm_refresh
│                              │  POST /auth/refresh    │
│                              │  { appId, refreshToken }
│                              │───────────────────────►│
│                              │◄───────────────────────│
│                              │  { jwt, refreshToken } │
│                              │  (RTR: rotated refresh)│
│◄─────────────────────────────│                        │
│  200 OK { dashboard }        │                        │
│  Set-Cookie: gm_access=new   │                        │
│  Set-Cookie: gm_refresh=new  │                        │
```

> The frontend **does not know** a refresh occurred. The response arrives with the data and the new cookies, completely transparently.

### Send WhatsApp Message (from api-turistear)

```
api-turistear                  whatsapp-worker          Meta Cloud API
│                                  │                       │
│  Confirm sale → generate QR      │                       │
│  → notify client                 │                       │
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



## Authorization Middleware in api-turistear

Every protected endpoint passes through the auth middleware before reaching the handler:

```
Request
  │
  ├─► [auth middleware]
  │     ├─ Read gm_access cookie
  │     ├─ If not present → 401 UNAUTHORIZED
  │     ├─ Verify JWT (signature, exp)
  │     │   ├─ Valid → continue
  │     │   └─ Expired → try refresh with gm_refresh
  │     │       ├─ Refresh OK → renew cookies → continue
  │     │       └─ Refresh invalid → clear cookies → 401
  │     ├─ Extract sub (identity) from JWT
  │     ├─ Lookup user in D1 by identity
  │     │   └─ Not found → 401
  │     └─ Attach { user_id, role, organization_id } to context
  │
  ├─► [role middleware] (on routes requiring it)
  │     ├─ Verify c.var.user.role === "admin" (or "agent")
  │     └─ If mismatch → 403 FORBIDDEN
  │
  └─► Business Handler
```

---

## Multitenancy — Data Isolation Model

**Full spec and test scenarios:** `docs/multitenancy/multitenancy.spec.md`

### Tenancy model

Turistear Ya! uses **shared-database, shared-schema with row-level scoping**: one D1 instance, one set of tables, every tenant-scoped row carries an `organization_id`. Isolation is enforced at the query layer — foreign keys give referential integrity but do not prevent cross-org reads.

### Identity model

`users.email` is **globally unique** across the platform — one email maps to exactly one organization. This is why the auth middleware can resolve a user's `organization_id` from the JWT `sub` (email) alone, without the client ever supplying an org identifier. Lookups keyed by a globally-unique column (`users.email`, `invitations.token`) are inherently global and are the only queries exempt from the org filter.

### Enforcement rules

Every handler that reads or writes tenant-scoped data MUST follow these rules. Violating them causes silent data leakage across organizations.

| # | Rule |
|---|---|
| 1 | **`organization_id` always comes from `c.var.user.organizationId`** (set by `authMiddleware`). Never from a body field, query param, or path segment. Zod request schemas must not declare `organizationId`. |
| 2 | **Every SELECT filters by org:** `.where(eq(table.organizationId, user.organizationId))`. Exception: globally-unique-key lookups (see identity model above). |
| 3 | **Every INSERT sets `organizationId: user.organizationId`** from context. |
| 4 | **Every UPDATE/DELETE includes the org filter:** `and(eq(table.id, input.id), eq(table.organizationId, user.organizationId))`. A non-matching row silently returns 0 rows → handler returns `404`. |
| 5 | **Every new tenant-scoped migration** declares `organization_id TEXT NOT NULL REFERENCES organizations(id)`. Tables scoped transitively (e.g. via `user_id`) are exempt and must say so in the migration. |
| 6 | **Index `organization_id`** on every tenant-scoped table — standalone or as the leading column in a composite index. |

### Architectural decision

| Decision | Discarded Alternative | Why |
|---|---|---|
| Row-level scoping in shared schema | Per-tenant databases or schemas | D1 does not support dynamic database provisioning. Row-level is the only viable model on Cloudflare Workers. |
| Globally-unique `users.email` | Per-org unique email (one person, multiple orgs) | Lets auth resolve org from identity alone, keeping the JWT and middleware simple. Multi-org membership is explicitly out of scope for MVP. |

---

## Workers Structure in Cloudflare

```
Cloudflare Account leolicona-dev
│
├── api-turistear              ← This repository (api-turistear/)
│   ├── D1 Binding: guideme-db
│   ├── Service Binding: AGNOSTIC_AUTH_API → agnostic-auth
│   └── (optional) Service Binding: WHATSAPP_WORKER → whatsapp-worker
│
├── agnostic-auth            ← Existing Worker (separate repository)
│   └── KV: verification and refresh tokens
│
└── whatsapp-worker          ← [PLACEHOLDER: Worker to be created]
    └── Send template messages to Meta Cloud API (outbound only)
```

---

## `wrangler.jsonc` Config for api-turistear

```jsonc
{
  "name": "api-turistear",
  "compatibility_date": "2025-08-03",
  "main": "./src/index.tsx",
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "guideme-db",
      "database_id": "PLACEHOLDER"  // Replace after running: wrangler d1 create guideme-db
    }
  ],
  "services": [
    {
      "binding": "AGNOSTIC_AUTH_API",
      "service": "agnostic-auth"
    }
    // Uncomment once whatsapp-worker is created:
    // { "binding": "WHATSAPP_WORKER", "service": "whatsapp-worker" }
  ],
  "vars": {
    "AGNOSTIC_AUTH_APP_ID": "guide-me",
    "COOKIE_DOMAIN": ".turistear.com",
    "CORS_ORIGIN": "https://app.turistear.com"
  }
  // Secrets (wrangler secret put <NAME>):
  // RESEND_API_KEY
  // WHATSAPP_API_TOKEN
  // WHATSAPP_PHONE_NUMBER_ID
  // QR_SECRET
}
```

---

## Architectural Decisions and Rationale

| Decision | Discarded Alternative | Why |
|---|---|---|
| HttpOnly cookies for session | JWT in localStorage / memory | XSS cannot steal HttpOnly cookies. localStorage is vulnerable. |
| Two cookies (access + refresh) | Session ID in KV | Avoids a KV lookup on every request. JWT is self-contained. |
| `gm_refresh` restricted to `/api/auth/refresh` | Refresh on any path | Browser only sends the refresh token when the app explicitly needs it. |
| Service Binding for auth | HTTP fetch to public URL | Zero latency, no egress cost, internal communication inside Cloudflare network. |
| Outbound-only WhatsApp proxy | Bidirectional/webhook Worker | Meta's webhook and incoming handling are discarded. The only integration is outbound template delivery for sales folios, simplifying the architecture. |
| SameSite=Lax (not None) | SameSite=None | Same root domain, None is not needed. Lax is more secure and doesn't require strict HTTPS in dev. |

---

## Outstanding Placeholders

| Item | Required Action |
|---|---|
| `database_id` in `wrangler.jsonc` | Run `wrangler d1 create guideme-db` and paste the ID |
| `appId: "turistear"` in Agnostic Auth | Confirm `turistear` is registered in the App Registry of agnostic-auth |
| `whatsapp-worker` | Create the Worker, add Service Binding for outbound message proxying |
| Domain `turistear.com` | Configure DNS in Cloudflare, set up Workers routes for `api.turistear.com` and `app.turistear.com` |
| WhatsApp Templates | Create and obtain approval from Meta for: sales receipt, cancellation notification |
