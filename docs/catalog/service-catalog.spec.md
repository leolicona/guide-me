# Feature: Service Catalog (Services + Extras + Minimum Price)

## Context

The admin builds and maintains the organization's catalog of tourist services
(tours). Each service has a name, description, a `base_price`, a `minimum_price`
floor the agent can never sell below, and a default per-slot capacity. The admin can
attach optional **extras** (e.g. "Professional photo", "Travel insurance") with a
fixed price each, and can edit or deactivate a service without disturbing tickets
already sold.

**User Stories:** **US-A09** (create service), **US-A11** (extras), **US-A13** (edit /
deactivate without affecting sold folios).

**Out of scope (own features):**
- **US-A10** — recurring schedules / specific-date slots with per-slot capacity.
  This feature stores only the service-level `default_capacity` that US-A10 will use
  as the seed when generating slots. No `slots` table is created here.
- **US-A12** — per-service `commission_bonus`. Belongs to the Commissions feature;
  the `services` table is designed so a nullable `commission_bonus` column can be
  added later by `ALTER TABLE` without reshaping anything here.
- **US-AG03** — the agent-facing POS catalog read (active services + live
  availability). This feature's router is **admin-only**; agent read access lands
  with the POS feature.

**New endpoints (all admin-only):**
- `POST   /api/services` — create a service (US-A09)
- `GET    /api/services` — list services (US-A09 / catalog management)
- `GET    /api/services/:id` — service detail incl. its extras (US-A13)
- `PUT    /api/services/:id` — edit a service (US-A13)
- `POST   /api/services/:id/deactivate` — soft-deactivate (US-A13)
- `POST   /api/services/:id/reactivate` — restore (companion to deactivate)
- `POST   /api/services/:id/extras` — add an extra (US-A11)
- `PUT    /api/services/:id/extras/:extraId` — edit an extra (US-A11)
- `DELETE /api/services/:id/extras/:extraId` — soft-deactivate an extra (US-A11)

**Foundation:** new `src/routes/services/`, `src/middleware/auth.ts`,
`src/middleware/role.ts`, `docs/multitenancy/multitenancy.spec.md` (Enforcement
Contract, Scenarios B3/B4). The router applies `authMiddleware` + `requireRole('admin')`
to `*`, exactly like the existing `agents` router.

`GET /api/services/:id` is **the first resource-detail-by-id endpoint** in the
codebase — i.e. the consumer of the `NOT_FOUND` error code reserved by the
multitenancy spec (Scenario B3) and tracked in `docs/TECH_DEBT.md §1`. `NOT_FOUND` is
already present in the `ErrorCode` union (added by Staff Management); this feature is
its first catalog use. `docs/TECH_DEBT.md §1` can be marked resolved.

---

## Data Model

Two **new tenant-scoped tables**. Per Multitenancy Rule 5, each declares
`organization_id TEXT NOT NULL REFERENCES organizations(id)`. `service_extras` *could*
be scoped transitively through `service_id`, but it carries `organization_id`
**directly** anyway so every query is independently org-filtered (Rules 2 & 4,
defense in depth) and gets a clean org-leading index (Rule 6).

### Money representation

All monetary amounts (`base_price`, `minimum_price`, extra `price`) are stored as
**integer minor units** ("centavos") — never floats — mirroring the basis-points
decision for commissions. Single currency per deployment (MXN in MVP).

| Value stored | Means |
|---|---|
| `0` | $0.00 |
| `150000` | $1,500.00 |
| `4999` | $49.99 |

The frontend renders `cents / 100` and converts the admin's decimal input back with
`Math.round(value * 100)`. Keep both conversions in one helper to avoid drift.

### `services` (new table)

| Column | Type | Notes |
|---|---|---|
| `id` | `text` PK | `crypto.randomUUID()` |
| `organization_id` | `text NOT NULL` → `organizations(id)` | Rule 5 |
| `name` | `text NOT NULL` | non-empty |
| `description` | `text` (nullable) | |
| `base_price` | `integer NOT NULL` | minor units, `>= 0` |
| `minimum_price` | `integer NOT NULL` | minor units, `0 <= minimum_price <= base_price` |
| `default_capacity` | `integer NOT NULL` | `>= 1`; seeds per-slot capacity in US-A10 |
| `status` | `text NOT NULL DEFAULT 'active'` | enum `['active','inactive']` |
| `created_at` | `integer NOT NULL DEFAULT (unixepoch())` | |
| `updated_at` | `integer NOT NULL DEFAULT (unixepoch())` | |

Index (Rule 6): `CREATE INDEX services_org_status_idx ON services (organization_id, status);`

### `service_extras` (new table)

| Column | Type | Notes |
|---|---|---|
| `id` | `text` PK | |
| `organization_id` | `text NOT NULL` → `organizations(id)` | carried directly (see above) |
| `service_id` | `text NOT NULL` → `services(id)` | parent service |
| `name` | `text NOT NULL` | non-empty |
| `price` | `integer NOT NULL` | minor units, `>= 0`. **No discounts apply to extras** (business rule) |
| `status` | `text NOT NULL DEFAULT 'active'` | enum `['active','inactive']` |
| `created_at` | `integer NOT NULL DEFAULT (unixepoch())` | |
| `updated_at` | `integer NOT NULL DEFAULT (unixepoch())` | |

Index (Rule 6): `CREATE INDEX service_extras_org_service_idx ON service_extras (organization_id, service_id);`

> Migrations: `0006_create_services.sql`, `0007_create_service_extras.sql` (one table
> per file, matching the `0001`–`0004` style).

### Why soft-deactivate, never hard-delete (US-A13)

US-A13 requires editing/deactivating a service "without affecting already-sold tickets
(folios)". Folios (a later feature) will **snapshot** the service/extra name and the
sold price onto each line at sale time, so a folio never dereferences the live catalog
row for historical values. To keep that guarantee:

- A service/extra is **never hard-deleted** in MVP; deactivation flips `status` to
  `'inactive'`.
- An `inactive` service is hidden from the POS catalog (US-AG03) but stays readable for
  reports and historical reference.
- `DELETE /api/services/:id/extras/:extraId` therefore performs a **soft-deactivate**
  (sets the extra's `status = 'inactive'`), not a row deletion.

---

## Pricing rules (enforced server-side)

From SPEC → Key Business Rules → Pricing and Discounts:

- `minimum_price <= base_price` and both `>= 0`. A request that violates this is a
  `400 VALIDATION_ERROR` (Zod `refine`); no row is written.
- The agent may discount down to `minimum_price` **inclusive**; below it the sale is
  blocked. That floor is *enforced at sale time* (POS feature) using the
  `minimum_price` set here — this feature only stores and validates it.
- Extras have a fixed price; no discount is ever applied to an extra.

---

## Endpoints

All endpoints: **Auth required, `admin` only.** Cross-org and unknown ids resolve to
`404 NOT_FOUND` via the org-filtered query (Rules 2 & 4) — the response never reveals
whether the id exists in another organization.

### `POST /api/services` — Create service (US-A09)

#### Request body

```json
{
  "name": "Canyon Sunrise Tour",
  "description": "Guided sunrise hike with breakfast.",
  "base_price": 150000,
  "minimum_price": 120000,
  "default_capacity": 12
}
```

| Field | Rule |
|---|---|
| `name` | required, non-empty string |
| `description` | optional, nullable string |
| `base_price` | required, integer `>= 0` (minor units) |
| `minimum_price` | required, integer `>= 0`, **`<= base_price`** |
| `default_capacity` | required, integer `>= 1` |

- Per Multitenancy Rule 1, `organizationId`/`status` are never read from the body; Zod
  strips unknowns. New services are created `active`.

#### Response — 201 Created

```json
{
  "service": {
    "id": "svc_abc",
    "name": "Canyon Sunrise Tour",
    "description": "Guided sunrise hike with breakfast.",
    "base_price": 150000,
    "minimum_price": 120000,
    "default_capacity": 12,
    "status": "active",
    "extras": []
  }
}
```

### `GET /api/services` — List services (catalog management)

Returns every service in the caller's org (`active` + `inactive`), ordered by `name`
ascending. Lean shape — **no** embedded extras (use the detail endpoint for those).

**Query param (optional):** `status=active|inactive` filters the list; omitted = all.

#### Response — 200 OK

```json
{
  "services": [
    {
      "id": "svc_abc",
      "name": "Canyon Sunrise Tour",
      "description": "Guided sunrise hike with breakfast.",
      "base_price": 150000,
      "minimum_price": 120000,
      "default_capacity": 12,
      "status": "active"
    }
  ]
}
```

### `GET /api/services/:id` — Service detail + extras (US-A13)

Returns one service with its **extras** array (active + inactive extras, ordered by
`name`). 404 if no such service in the caller's org.

#### Response — 200 OK

```json
{
  "service": {
    "id": "svc_abc",
    "name": "Canyon Sunrise Tour",
    "description": "Guided sunrise hike with breakfast.",
    "base_price": 150000,
    "minimum_price": 120000,
    "default_capacity": 12,
    "status": "active",
    "extras": [
      { "id": "ext_1", "name": "Professional photo", "price": 25000, "status": "active" },
      { "id": "ext_2", "name": "Travel insurance",   "price": 8000,  "status": "active" }
    ]
  }
}
```

### `PUT /api/services/:id` — Edit service (US-A13)

Same body and validation as create (full replace of editable fields). `status` is not
edited here (use deactivate/reactivate); `organization_id` is never accepted (Rule 1).
Editing prices does **not** retroactively change folios already sold (they snapshot
their own values).

#### Response — 200 OK — `{ "service": { …, "extras": [...] } }` (same shape as detail)

### `POST /api/services/:id/deactivate` — Soft-deactivate (US-A13)

Sets the service `status = 'inactive'`. Idempotent. History untouched.

#### Response — 200 OK

```json
{ "service": { "id": "svc_abc", "name": "Canyon Sunrise Tour", "status": "inactive" } }
```

### `POST /api/services/:id/reactivate` — Restore

Sets `status = 'active'`. Idempotent.

#### Response — 200 OK — `{ "service": { "id": "...", "name": "...", "status": "active" } }`

### `POST /api/services/:id/extras` — Add extra (US-A11)

The parent `:id` must be a service in the caller's org (else `404`). Extras may be added
to active or inactive services.

#### Request body

```json
{ "name": "Professional photo", "price": 25000 }
```

| Field | Rule |
|---|---|
| `name` | required, non-empty string |
| `price` | required, integer `>= 0` (minor units) |

#### Response — 201 Created

```json
{ "extra": { "id": "ext_1", "name": "Professional photo", "price": 25000, "status": "active" } }
```

### `PUT /api/services/:id/extras/:extraId` — Edit extra (US-A11)

Edits `name` / `price`. `404` if the extra does not exist **under that service in the
caller's org** (the query filters by `extraId` + `serviceId` + `organizationId`).

#### Response — 200 OK — `{ "extra": { "id": "...", "name": "...", "price": ..., "status": "active" } }`

### `DELETE /api/services/:id/extras/:extraId` — Remove extra (US-A11)

**Soft-deactivate** — sets the extra's `status = 'inactive'` (protects folio history;
see "Why soft-deactivate"). Idempotent. `404` if not found under that service/org.

#### Response — 200 OK — `{ "extra": { "id": "...", "name": "...", "price": ..., "status": "inactive" } }`

---

## Error responses (all endpoints)

| Status | Code | Condition |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Body fails Zod (empty `name`, negative price, non-integer, `minimum_price > base_price`, `default_capacity < 1`) |
| 401 | `UNAUTHORIZED` | No / unrefreshable session |
| 403 | `FORBIDDEN` | Authenticated as `agent`, not `admin` |
| 403 | `ACCOUNT_SUSPENDED` | Caller's own account is suspended (from `authMiddleware`) |
| 404 | `NOT_FOUND` | No service `:id` (or extra `:extraId` under it) in the caller's org — includes ids that exist in another org |

No new `ErrorCode` is introduced; all of the above already exist.

---

## Scenarios

### US-A09 — Create / list services

#### Scenario 1 — Admin creates a service
**Given** an authenticated `admin` of `org_a`
**When** `POST /api/services` is called with a valid body
**Then** Status `201`; a `services` row exists in `org_a` with `status = 'active'`;
the response echoes the service with an empty `extras` array.

#### Scenario 2 — `minimum_price > base_price` is rejected
**Given** an admin
**When** `POST /api/services` is called with `minimum_price` greater than `base_price`
(or any negative price, or `default_capacity` of `0`)
**Then** Status `400 VALIDATION_ERROR`; no row is written.

#### Scenario 3 — List returns the org's services ordered by name
**Given** an admin of `org_a` with two services (one `active`, one `inactive`)
**When** `GET /api/services` is called
**Then** Status `200`; both services are returned ordered by `name`; no `extras` key on
list items. With `?status=active`, only the active one is returned.

#### Scenario 4 — Agent is forbidden
**Given** a user with `role = 'agent'`
**When** any `/api/services*` endpoint is called
**Then** Status `403 FORBIDDEN`.

### US-A13 — Detail / edit / deactivate

#### Scenario 5 — Service detail includes its extras
**Given** a service in `org_a` with two extras
**When** `GET /api/services/:id` is called
**Then** Status `200`; the `extras` array contains both, ordered by `name`.

#### Scenario 6 — Unknown / foreign id → 404
**Given** an admin of `org_a`
**When** `GET`/`PUT`/`deactivate`/`reactivate` targets an id that does not exist or
belongs to `org_b`
**Then** Status `404 NOT_FOUND`; no row changed.

#### Scenario 7 — Edit updates fields, advances `updated_at`, keeps `status`
**Given** an `active` service in `org_a`
**When** `PUT /api/services/:id` changes name and prices
**Then** Status `200`; the row reflects the new values; `status` and `organization_id`
are unchanged; `updated_at` advances.

#### Scenario 8 — Deactivate / reactivate are idempotent
**Given** an `active` service
**When** `POST .../deactivate` is called (twice)
**Then** Status `200`, `status = 'inactive'` (still `inactive` on the second call).
**When** `POST .../reactivate` is then called
**Then** `status = 'active'`.

#### Scenario 9 — Deactivation does not delete or mutate extras
**Given** a service with extras
**When** the service is deactivated
**Then** the `service_extras` rows are untouched (the service simply reads `inactive`).

### US-A11 — Extras

#### Scenario 10 — Add an extra
**Given** a service in `org_a`
**When** `POST /api/services/:id/extras` with `{ "name": "Photo", "price": 25000 }`
**Then** Status `201`; a `service_extras` row exists with `status = 'active'`, the same
`organization_id` as the parent service, and `service_id = :id`.

#### Scenario 11 — Add to unknown / foreign service → 404
**Given** an admin of `org_a`
**When** `POST /api/services/:id/extras` targets a service id absent from `org_a`
**Then** Status `404 NOT_FOUND`; no extra written.

#### Scenario 12 — Edit an extra
**Given** an extra under a service in `org_a`
**When** `PUT /api/services/:id/extras/:extraId` changes name/price
**Then** Status `200`; the row reflects new values; `updated_at` advances.

#### Scenario 13 — Remove (soft-deactivate) an extra
**Given** an `active` extra
**When** `DELETE /api/services/:id/extras/:extraId`
**Then** Status `200`; the row still exists with `status = 'inactive'` (not deleted).

#### Scenario 14 — Edit / remove extra with mismatched parent → 404
**Given** extra `ext_1` belongs to service `svc_a`
**When** `PUT`/`DELETE /api/services/svc_b/extras/ext_1` (wrong parent), or the extra id
is unknown
**Then** Status `404 NOT_FOUND`; `ext_1` unchanged (filter is `extraId` + `serviceId` +
`organizationId`).

#### Scenario 15 — Negative / invalid extra price → 400
**When** an extra is created/edited with a negative or non-integer `price`, or empty `name`
**Then** Status `400 VALIDATION_ERROR`; no row changed.

### Multitenancy isolation (required — Scenarios B3 / B4)

Per `CLAUDE.md` and `docs/multitenancy/multitenancy.spec.md`, every tenant-scoped route
MUST ship cross-org isolation tests built on `seedTwoOrgs`.

#### Scenario 16 — B4: List is scoped to caller's org
**Given** services exist in both `org_a` and `org_b`
**When** the `org_a` admin calls `GET /api/services`
**Then** only `org_a` services are returned; no `org_b` service ever appears.

#### Scenario 17 — B3: Cross-org detail / edit / deactivate / extras → 404
**Given** service `svc_b` (with extra `ext_b`) belongs to `org_b`
**When** the `org_a` admin calls `GET`/`PUT`/`deactivate`/`reactivate` on `svc_b`, or
`POST`/`PUT`/`DELETE` on its extras
**Then** Status `404 NOT_FOUND`; `svc_b` and `ext_b` are unchanged; the response does
not reveal they exist in another org.

#### Scenario 18 — B1: Injected `organizationId` in body is ignored
**Given** an `org_a` admin creates/edits a service
**When** the body includes an extra `"organizationId": "org_b"`
**Then** the field is stripped by Zod; the row's `organization_id` stays `org_a`.

---

## Definition of Done

- [ ] Migrations `0006_create_services.sql` + `0007_create_service_extras.sql` create
      both tables with `organization_id` (Rule 5) and org-leading indexes (Rule 6)
- [ ] Drizzle schema: `services` + `serviceExtras` tables and inferred types
- [ ] `src/routes/services/` (`index.ts`, `handler.ts`, `schema.ts`), mounted under
      `/api/services` with `authMiddleware` + `requireRole('admin')` on `*`
- [ ] Money stored as integer minor units everywhere; `minimum_price <= base_price`
      and `default_capacity >= 1` enforced by Zod `refine`
- [ ] Services & extras are soft-deactivated, never hard-deleted (US-A13);
      `DELETE` extra = soft-deactivate
- [ ] All reads/writes filter by `c.var.user.organizationId` (Rules 2 & 4); no
      `organizationId`/`status` field in any Zod schema (Rule 1)
- [ ] Scenarios 1–15 covered by `test/catalog/service-catalog.test.ts`
- [ ] Scenarios 16–18 (B1/B3/B4) covered using `seedTwoOrgs`
- [ ] `docs/TECH_DEBT.md §1` marked resolved (NOT_FOUND now consumed by `GET /api/services/:id`)
- [ ] Frontend: catalog service, hooks, schemas, `CatalogListPage`, service form, extras
      manager; **Catalog** nav destination (admin-only) added to `AppLayout`
- [ ] `pnpm --filter api-guideme test` green; `pnpm build:app` clean
</content>
</invoke>
