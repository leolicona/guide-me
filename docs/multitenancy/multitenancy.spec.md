# Feature: Multitenancy — Organización Aislada

## Context

GuideMe is a multi-tenant platform where multiple tourism companies (organizations) share the same Cloudflare D1 database and API. Multitenancy ensures that every organization's data — agents, services, schedules, folios, cash drawers — is completely isolated. An admin or agent from Organization A can never read, write, or affect any data belonging to Organization B.

This is a foundational, cross-cutting feature. It does not map to a single user story but is a prerequisite for every subsequent feature in the platform. Its deliverables are threefold:

1. A small concrete surface: `GET /api/organizations/me`.
2. An **Enforcement Contract** that every future handler and migration must uphold.
3. Tests that lock the contract in place — both for the concrete endpoint and as reusable templates for future tenant-scoped routes.

**User Stories:** (global prerequisite — affects all US-A* and US-AG* stories)
**Endpoints:** `GET /api/organizations/me`
**Foundation already in place:** `docs/ARCHITECTURE.md`, `src/middleware/auth.ts`, `src/db/schema.ts`, `src/routes/agents/handler.ts`

---

## Tenancy Model

### Single shared database, row-level isolation

GuideMe uses a **shared-database, shared-schema** model: one D1 instance, one set of tables, and every tenant-scoped row carries an `organization_id`. Isolation is enforced at the **query layer** — every read and write is filtered by the authenticated user's `organization_id`. There is no per-tenant database or schema.

### Identity uniqueness across tenants

`users.email` is **globally unique** (`CREATE UNIQUE INDEX users_email_unique ON users(email)`). This is a deliberate design decision with product consequences:

- One email address maps to **exactly one** organization across the entire platform. A person cannot be an admin of Org A and an agent of Org B using the same email.
- This is *why* the authentication layer can resolve a user (and therefore their `organization_id`) from the JWT `sub` (email) alone, without the client ever supplying an org identifier.
- It is also why `inviteAgent` checks for an existing user by email **without** an org filter (Rule 2 below does not apply): the email is unique platform-wide, so the check is inherently global by design.

> If multi-org membership per identity is ever required (Phase 2+), it would mean dropping the global email uniqueness constraint and introducing a `memberships` join table. That is explicitly out of scope for the MVP.

### Foreign keys provide integrity, not isolation

Every tenant-scoped table declares `FOREIGN KEY (organization_id) REFERENCES organizations(id)`. D1 enforces these constraints, which guarantees no orphan rows (you cannot insert a row pointing at a non-existent org). **Foreign keys do not enforce tenant isolation** — they do not stop Org B from *reading* Org A's rows. Isolation is enforced exclusively by the query-layer rules below.

---

## Enforcement Contract

These rules are invariants. No handler may violate them. They apply to every route that reads or writes tenant-scoped data.

### Rule 1 — `organization_id` is always taken from context, never from the request

The `organization_id` for any read or write operation is always `c.var.user.organizationId`, populated by `authMiddleware` after looking up the authenticated user in D1. It is never accepted as a query parameter, path segment, or request body field from the client.

As defense in depth, **Zod request schemas must not declare an `organizationId` field**. Zod objects are non-strict by default, so an `organizationId` sent by the client is silently stripped during validation and never reaches the handler.

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

> Exception: lookups keyed by a globally-unique column (e.g. `users.email`, `invitations.token`) are inherently global and do not need — and must not silently assume — an org filter. See "Identity uniqueness across tenants."

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

Without the `organizationId` filter on UPDATE/DELETE, a user who guesses another org's resource ID could overwrite or delete foreign data. The org filter prevents this silently — the query simply matches 0 rows, and the handler returns `404`.

### Rule 5 — Every new tenant-scoped table must have `organization_id NOT NULL REFERENCES organizations(id)`

No migration may introduce a tenant-scoped data table without this column. Organization-agnostic tables (e.g. a future `payment_methods` lookup table, or `password_reset_tokens` which derives its org transitively via `user_id`) are explicitly excluded from this rule and must be documented as such in the migration.

### Rule 6 — Index `organization_id` on tenant-scoped tables

Because every query on a tenant-scoped table filters by `organization_id`, each such table must carry an index that leads with it — either a standalone `organization_id` index or a composite index whose first column is `organization_id` (e.g. `(organization_id, date)` for slots). This keeps tenant-scoped reads from degrading into full-table scans as the shared database grows.

---

## Database Schema — Existing Foundation

The following is already in place and does not require new migrations for this feature.

### `organizations` (root table)

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
  email           TEXT NOT NULL UNIQUE,   -- globally unique → one identity = one org
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

> All future tables for services, slots, folios, extras, cash drawers, and QR tickets must follow the same pattern: `organization_id TEXT NOT NULL REFERENCES organizations(id)`, plus an `organization_id`-leading index (Rule 6).

---

## Auth Middleware — Existing Foundation

`src/middleware/auth.ts` already performs the full resolution chain on every protected request:

1. Reads the `gm_access` cookie
2. Decodes the JWT and checks expiry
3. Looks up the user in D1 by identity (email, the JWT `sub`)
4. Attaches `{ userId, name, email, role, organizationId }` to `c.var.user`
5. Transparently refreshes the session via `gm_refresh` if the access token is expired

The `organizationId` in context is therefore always the value stored in D1 for that user — it cannot be forged by the client. This is the single source from which all of the Enforcement Contract rules draw `organization_id`.

---

## New Endpoint — `GET /api/organizations/me`

Returns the organization details for the authenticated user's organization. Used by the dashboard to display the current organization name, and by future settings/branding screens.

**Auth:** Required (`authMiddleware`). Available to both `admin` and `agent` roles.

### Design note — why a dedicated endpoint and not part of `/api/me`

`/api/me` is intentionally a cheap session-identity check that returns only the JWT-derived `c.var.user` payload with **no extra database read**. Fetching the organization *name* requires a query against `organizations`. Rather than make every `/api/me` call pay for that read, the org detail lives behind its own endpoint that callers hit only when they need it.

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
    "name": "Empresa S.A."
  }
}
```

> The MVP response is intentionally limited to `id` and `name` — the only fields the dashboard needs. If timestamp fields are added later, note that Drizzle columns declared with `{ mode: 'timestamp' }` deserialize to `Date` and are serialized by `c.json()` as **ISO 8601 strings** (e.g. `"2026-06-03T00:00:00.000Z"`), not unix integers.

### Error responses

| Status | Code | Condition |
|---|---|---|
| 401 | `UNAUTHORIZED` | No session cookie, or an expired session that cannot be refreshed |
| 500 | `INTERNAL_ERROR` | The authenticated user's organization row is missing. Unreachable in normal operation — `users.organization_id` is a `NOT NULL` foreign key, so the org always exists. Treated as an invariant violation, not a client `404`. |

---

## Scenarios

Scenarios are split into two groups:

- **Part A** — the concrete `GET /api/organizations/me` endpoint. Testable today.
- **Part B** — cross-cutting tenant-isolation invariants. B1 and B2 are testable *today* against the existing `POST /api/agents/invite` route; B3 and B4 are **templates** to be instantiated against each tenant-scoped resource route as it is built (services, slots, folios, …).

### Part A — `GET /api/organizations/me`

#### Scenario A1 — Authenticated admin reads their own organization

**Given** an admin user with `organization_id = "org_a"` is authenticated
**When** a `GET /api/organizations/me` request is made with their `gm_access` cookie
**Then**
- Status `200 OK`
- Body: `{ "organization": { "id": "org_a", "name": "<org name>" } }`
- No data from any other organization is returned

#### Scenario A2 — Authenticated agent reads their own organization

**Given** an agent user with `organization_id = "org_a"` is authenticated
**When** a `GET /api/organizations/me` request is made
**Then**
- Status `200 OK`
- Body contains the organization data for `"org_a"` (both roles may read their own org)

#### Scenario A3 — Unauthenticated request

**Given** no `gm_access` cookie is present
**When** a `GET /api/organizations/me` request is made
**Then**
- Status `401 Unauthorized`
- Body: `{ "error": { "code": "UNAUTHORIZED" } }`

### Part B — Tenant-isolation invariants

#### Scenario B1 — Organization ID injected in the request body is ignored (testable now)

**Given** an authenticated admin belongs to `"org_a"`
**When** they `POST /api/agents/invite` with a body that includes an extra field: `{ "identity": "nuevo@empresa.com", "organizationId": "org_b" }`
**Then**
- The `organizationId` field is stripped by Zod validation and never reaches the handler
- Status `201 Created`
- The created `invitations` row has `organization_id = "org_a"` (from context), **not** `"org_b"`

#### Scenario B2 — Writes are automatically scoped to the caller's org (testable now)

**Given** an authenticated admin of `"org_a"` invites an agent via `POST /api/agents/invite`
**When** the handler inserts the invitation
**Then**
- The inserted row has `organization_id = "org_a"`, sourced from `c.var.user.organizationId`
- (This invariant is already exercised by `test/auth/agent-invitation.test.ts` Scenario 1; the multitenancy suite asserts it explicitly as a contract test.)

#### Scenario B3 — Cross-org read isolation (template for resource-detail routes)

**Given** Organization A has a resource (e.g. a service) with `id = "svc_xyz"` and `organization_id = "org_a"`
**And** Organization B has an authenticated admin
**When** Organization B's admin requests that resource by ID (e.g. `GET /api/services/svc_xyz`)
**Then**
- The org-filtered query matches 0 rows
- The handler returns `404 Not Found` (a `NOT_FOUND` error code, to be added to `ErrorCode` when the first resource-detail endpoint is built)
- No data from Organization A is exposed, and the error does not reveal that the resource exists in another org

#### Scenario B4 — List/SELECT results are scoped to the caller's org (template for collection routes)

**Given** services exist in both `"org_a"` and `"org_b"`
**And** an agent belongs to `"org_a"`
**When** they request a collection (e.g. `GET /api/services`)
**Then**
- Only rows with `organization_id = "org_a"` are returned
- Rows from `"org_b"` (or any other org) never appear in the result

---

## Definition of Done

- [ ] `GET /api/organizations/me` endpoint implemented (`src/routes/organizations/`) and mounted in `src/index.tsx`
- [ ] The missing-org case maps to `INTERNAL_ERROR` (500), not a client `404` (no new `ErrorCode` introduced by this feature)
- [ ] Scenarios A1–A3 have passing tests (`test/multitenancy/multitenancy.test.ts`)
- [ ] Scenario B1 (org-id injection ignored) has a passing test against `POST /api/agents/invite`
- [ ] Scenario B2 (write scoped to context org) is asserted as a contract test
- [ ] B3 and B4 are documented as templates; a reusable cross-org test helper exists for future resource routes
- [ ] The Enforcement Contract (Rules 1–6) is reviewed by the team before starting the Staff Management feature
- [ ] The PR template includes the multitenancy migration/query checklist (see implementation plan, Phase 4)
