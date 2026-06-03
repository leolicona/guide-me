# Feature: Multitenancy — Organización Aislada

## Context

GuideMe is a multi-tenant platform where multiple tourism companies (organizations) share the same Cloudflare D1 database and API. Multitenancy ensures that every organization's data — agents, services, schedules, folios, cash drawers — is completely isolated. An admin or agent from Organization A can never read, write, or affect any data belonging to Organization B.

This is a foundational, cross-cutting feature. It does not map to a single user story but is a prerequisite for every subsequent feature in the platform.

**User Stories:** (global prerequisite — affects all US-A* and US-AG* stories)  
**Endpoints:** `GET /api/organizations/me`  
**Foundation already in place:** `docs/ARCHITECTURE.md`, `src/middleware/auth.ts`, `src/db/schema.ts`

---

## Enforcement Contract

These rules are invariants. No handler may violate them. They apply to every route that reads or writes tenant-scoped data.

### Rule 1 — `organization_id` is always taken from context, never from the request

The `organization_id` for any read or write operation is always `c.var.user.organizationId`, populated by `authMiddleware` after looking up the authenticated user in D1. It is never accepted as a query parameter, path segment, or request body field from the client.

```ts
// CORRECT
.where(eq(services.organizationId, user.organizationId))

// FORBIDDEN — never trust a client-supplied org ID
.where(eq(services.organizationId, c.req.param('orgId')))
```

### Rule 2 — Every SELECT on a tenant-scoped table must include an org filter

```ts
// CORRECT
const rows = await db
  .select()
  .from(services)
  .where(eq(services.organizationId, user.organizationId))

// FORBIDDEN — leaks data across organizations
const rows = await db.select().from(services)
```

### Rule 3 — Every INSERT on a tenant-scoped table must set `organization_id` from context

```ts
// CORRECT
await db.insert(services).values({
  id: crypto.randomUUID(),
  organizationId: user.organizationId,
  ...input,
})
```

### Rule 4 — Every UPDATE and DELETE must include the org filter

```ts
// CORRECT
await db
  .update(services)
  .set({ name: input.name })
  .where(
    and(
      eq(services.id, input.id),
      eq(services.organizationId, user.organizationId),
    ),
  )
```

Without the `organizationId` filter on UPDATE/DELETE, a user who guesses another org's resource ID could overwrite or delete foreign data. The org filter prevents this silently — the query simply finds 0 rows.

### Rule 5 — Every new tenant-scoped table must have `organization_id NOT NULL REFERENCES organizations(id)`

No migration may introduce a data table without this column. Organization-agnostic tables (e.g., future `payment_methods` lookup tables) are explicitly excluded from this rule and must be documented as such.

---

## Database Schema — Existing Foundation

The following is already in place and does not require new migrations for this feature.

### `organizations`

```sql
CREATE TABLE organizations (
  id          TEXT PRIMARY KEY NOT NULL,
  name        TEXT NOT NULL,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
```

### `users` (tenant-scoped)

```sql
CREATE TABLE users (
  id              TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  name            TEXT NOT NULL,
  email           TEXT NOT NULL UNIQUE,
  password_hash   TEXT NOT NULL,
  password_salt   TEXT NOT NULL,
  phone           TEXT,
  role            TEXT NOT NULL,        -- 'admin' | 'agent'
  status          TEXT NOT NULL DEFAULT 'unverified', -- 'unverified' | 'active' | 'suspended'
  plan            TEXT NOT NULL DEFAULT 'free',
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
);
```

### `invitations` (tenant-scoped)

```sql
CREATE TABLE invitations (
  id              TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  identity        TEXT NOT NULL,
  identity_type   TEXT NOT NULL DEFAULT 'email',
  token           TEXT NOT NULL UNIQUE,
  invited_by      TEXT NOT NULL REFERENCES users(id),
  status          TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'accepted' | 'expired'
  expires_at      INTEGER NOT NULL,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
);
```

> All future tables for services, slots, folios, extras, cash drawers, and QR tickets must follow the same pattern: `organization_id TEXT NOT NULL REFERENCES organizations(id)`.

---

## Auth Middleware — Existing Foundation

`src/middleware/auth.ts` already performs the full resolution chain on every protected request:

1. Reads the `gm_access` cookie
2. Decodes and verifies the JWT
3. Looks up the user in D1 by identity (email)
4. Attaches `{ userId, name, email, role, organizationId }` to `c.var.user`
5. Transparently refreshes the session if the access token is expired

The `organizationId` in context is therefore always the value stored in D1 for that user — it cannot be forged by the client.

---

## New Endpoint — `GET /api/organizations/me`

Returns the organization details for the authenticated user's organization. Used by the admin dashboard to display the current organization name and by future settings screens.

**Auth:** Required (`authMiddleware`). Available to both `admin` and `agent` roles.

### Request

```
GET /api/organizations/me
Cookie: gm_access=<jwt>
```

### Response — 200 OK

```json
{
  "organization": {
    "id": "org_abc123",
    "name": "Empresa S.A.",
    "createdAt": 1748822400
  }
}
```

### Error responses

| Status | Code | Condition |
|---|---|---|
| 401 | `UNAUTHORIZED` | No session cookie or expired session that cannot be refreshed |
| 404 | `NOT_FOUND` | Organization no longer exists (should not occur in normal operation) |

---

## Scenarios

### Scenario 1 — Authenticated admin reads their own organization

**Given** an admin user with `organization_id = "org_abc"` is authenticated  
**When** a `GET /api/organizations/me` request is made with their `gm_access` cookie  
**Then**
- Status `200 OK`
- Body contains `organization.id = "org_abc"` and the correct `name`
- No data from other organizations is returned

---

### Scenario 2 — Authenticated agent reads their own organization

**Given** an agent user with `organization_id = "org_abc"` is authenticated  
**When** a `GET /api/organizations/me` request is made  
**Then**
- Status `200 OK`
- Body contains the organization data for `"org_abc"`

---

### Scenario 3 — Unauthenticated request

**Given** no `gm_access` cookie is present  
**When** a `GET /api/organizations/me` request is made  
**Then**
- Status `401 Unauthorized`
- Body: `{ "error": { "code": "UNAUTHORIZED" } }`

---

### Scenario 4 — Cross-org isolation on tenant-scoped data (invariant test)

**Given** Organization A has a resource (e.g., a service) with `id = "svc_xyz"` and `organization_id = "org_a"`  
**And** Organization B has an authenticated admin  
**When** Organization B's admin makes any read or write request against `"svc_xyz"`  
**Then**
- The response is `404 Not Found` (the query finds 0 rows because of the org filter)
- No data from Organization A is exposed
- No error reveals the existence of the resource in another organization

---

### Scenario 5 — Organization ID injection in request body is ignored

**Given** an authenticated admin belongs to `"org_a"`  
**When** they send a request body containing `{ "organizationId": "org_b", ... }`  
**Then**
- The `organizationId` from the request body is silently ignored
- The record is created/updated scoped to `"org_a"` (from `c.var.user.organizationId`)
- Status `201` or `200` as appropriate — no error, no leakage

---

### Scenario 6 — Admin creates a resource; it is automatically scoped to their org

**Given** an admin of `"org_a"` creates a new service via `POST /api/services`  
**When** the handler inserts the record  
**Then**
- The inserted row has `organization_id = "org_a"`
- No `organization_id` field appears in the request body (it is injected by the handler from context)

---

### Scenario 7 — Agent's queries are always scoped to their own organization

**Given** an agent belongs to `"org_a"`  
**When** they request the service catalog via `GET /api/services`  
**Then**
- Only services with `organization_id = "org_a"` are returned
- Services from `"org_b"` or any other organization are never included in the result

---

## Definition of Done

- [ ] `GET /api/organizations/me` endpoint implemented and mounted in `src/index.tsx`
- [ ] All scenarios have passing tests (`test/multitenancy/multitenancy.test.ts`)
- [ ] Scenario 4 (cross-org isolation) is covered by at least one test that verifies the query filter, not just by code review
- [ ] Scenario 5 (org ID injection) is covered by a test
- [ ] The Enforcement Contract (Rules 1–5) is reviewed by the team before starting the Staff Management feature
- [ ] A migration checklist entry is added to the project's PR template: "Does this migration include `organization_id NOT NULL REFERENCES organizations(id)`?"
