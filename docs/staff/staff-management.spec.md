# Feature: Staff Management (List, Edit, Deactivate Agents)

## Context

The admin manages the sales agents of their organization: invites them, sees the
roster with each agent's commission percentage, edits an agent's profile and base
commission, and deactivates (suspends) an agent so they lose access without losing
their history.

This spec covers the **management** half of staff. The **invitation/onboarding**
half (US-A05 / US-AG01) is already implemented and specified in
`docs/auth/agent-invitation.spec.md` — it is referenced here, not redefined.

**User Stories:** US-A05 (done — invite), **US-A06** (list), **US-A07** (edit), **US-A08** (deactivate)
**New endpoints:**
- `GET /api/agents` — list agents (US-A06)
- `PUT /api/agents/:id` — edit profile + base commission (US-A07)
- `POST /api/agents/:id/deactivate` — suspend (US-A08)
- `POST /api/agents/:id/reactivate` — restore access (companion to US-A08)

**Existing endpoint (unchanged):** `POST /api/agents/invite` (US-A05)
**Foundation:** `src/routes/agents/`, `src/middleware/auth.ts`, `src/middleware/role.ts`,
`docs/multitenancy/multitenancy.spec.md` (Enforcement Contract, Scenarios B3/B4)

All endpoints are mounted under the existing `agents` router, which already applies
`authMiddleware` + `requireRole('admin')` to `*`.

---

## Data Model Changes

### `users.base_commission` (new column)

Each agent carries a base commission percentage assigned by the admin (Key Business
Rules → Commissions). It is stored as **integer basis points** to avoid
floating-point money bugs:

| Value stored | Means |
|---|---|
| `0` | 0.00% (default for a freshly onboarded agent) |
| `1050` | 10.50% |
| `10000` | 100.00% |

```
commission = sold_price * base_commission / 10000
```

- Column: `base_commission INTEGER NOT NULL DEFAULT 0`, valid range `0`–`10000`.
- Applies to `agent` rows; `admin` rows keep the default `0` (unused).
- Set to `0` at invitation acceptance; the admin assigns the real value later via
  `PUT /api/agents/:id` (the invite flow is not extended in this feature).

### `users` org-leading index (Rule 6)

`users` is tenant-scoped but today only has the `users_email_unique` index. The new
list/edit queries filter by `organization_id` (+ `role`, `status`), so a composite
org-leading index is added per Multitenancy Rule 6:

```sql
CREATE INDEX users_org_role_status_idx ON users (organization_id, role, status);
```

> Migration `0005_add_base_commission_to_users.sql` adds both the column and the index.
> Per Multitenancy Rule 5, no new tenant-scoped *table* is introduced.

---

## Cross-cutting change — Suspended users lose access

US-A08 requires a deactivated agent to **lose access to the platform**. Today
`authMiddleware` resolves the user by email but never inspects `status`, so a
suspended agent with a still-valid `gm_access` cookie (or a refreshable session)
would keep working until expiry.

**Required change:** `authMiddleware` (`buildUserPayload`) must also select
`users.status`. If `status === 'suspended'`, the middleware clears the session
cookies and rejects the request:

- Status `403 Forbidden`
- Body: `{ "error": { "code": "ACCOUNT_SUSPENDED" } }`

This applies on **both** the valid-token branch and the post-refresh branch, so a
suspended agent cannot regain access by letting the access token expire and
refreshing. `unverified` is out of scope here (it is handled at login).

> New error codes introduced by this feature: `ACCOUNT_SUSPENDED` (403) and
> `NOT_FOUND` (404). `NOT_FOUND` is the code the multitenancy spec (Scenario B3)
> reserved for "the first resource-detail endpoint" — this is that endpoint.

---

## Endpoints

### `GET /api/agents` — List agents (US-A06)

Returns every **agent** (`role = 'agent'`) in the caller's organization, active and
suspended, each with its status and base commission. Admin rows are excluded.

**Auth:** Required, `admin` only.

#### Response — 200 OK

```json
{
  "agents": [
    {
      "id": "usr_abc",
      "name": "Carlos López",
      "email": "carlos@empresa.com",
      "phone": "+52 55 1234 5678",
      "status": "active",
      "base_commission": 1050
    },
    {
      "id": "usr_def",
      "name": "Ana Ruiz",
      "email": "ana@empresa.com",
      "phone": null,
      "status": "suspended",
      "base_commission": 800
    }
  ]
}
```

- Ordered by `name` ascending.
- `base_commission` is returned in basis points; the frontend renders `/ 100` (e.g. `10.50%`).
- `password_hash` / `password_salt` are **never** included.
- Pending invitations (people invited but not yet onboarded) are **not** agents and
  do not appear in this list. (A combined view is a possible future enhancement.)

---

### `PUT /api/agents/:id` — Edit agent profile + base commission (US-A07)

**Auth:** Required, `admin` only.

#### Request body

```json
{
  "name": "Carlos A. López",
  "phone": "+52 55 9999 0000",
  "base_commission": 1200
}
```

| Field | Rule |
|---|---|
| `name` | required, non-empty string |
| `phone` | optional, nullable string |
| `base_commission` | required, integer `0`–`10000` |

- **Not editable here:** `email` (the login identity — immutable in MVP), `role`,
  `status` (status changes go through deactivate/reactivate), `organization_id`.
- Per Multitenancy Rule 1, `organizationId` is never read from the body; Zod strips it.

#### Response — 200 OK

```json
{
  "agent": {
    "id": "usr_abc",
    "name": "Carlos A. López",
    "email": "carlos@empresa.com",
    "phone": "+52 55 9999 0000",
    "status": "active",
    "base_commission": 1200
  }
}
```

---

### `POST /api/agents/:id/deactivate` — Suspend agent (US-A08)

Sets the agent's `status` to `suspended`. The agent's history (folios, sales) is
preserved; only access is revoked (enforced by the `authMiddleware` change above).

**Auth:** Required, `admin` only.

- Idempotent: deactivating an already-suspended agent returns `200` with the same state.
- Targets `role = 'agent'` only — an admin cannot be deactivated through this route
  (and therefore cannot deactivate themselves); such an `:id` yields `404 NOT_FOUND`.

#### Response — 200 OK

```json
{ "agent": { "id": "usr_abc", "name": "Carlos López", "status": "suspended" } }
```

---

### `POST /api/agents/:id/reactivate` — Restore agent access

Sets a suspended agent's `status` back to `active`.

**Auth:** Required, `admin` only. Idempotent. Targets `role = 'agent'` only.

#### Response — 200 OK

```json
{ "agent": { "id": "usr_abc", "name": "Carlos López", "status": "active" } }
```

---

## Error responses (all endpoints)

| Status | Code | Condition |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Body fails Zod validation (e.g. `base_commission` out of `0`–`10000`, empty `name`) |
| 401 | `UNAUTHORIZED` | No / unrefreshable session |
| 403 | `FORBIDDEN` | Authenticated as `agent`, not `admin` |
| 403 | `ACCOUNT_SUSPENDED` | Caller's own account is suspended (from `authMiddleware`) |
| 404 | `NOT_FOUND` | No `agent` with `:id` in the caller's organization (includes IDs that exist in another org, or that belong to an `admin`) |

---

## Scenarios

### US-A06 — List agents

#### Scenario 1 — Admin lists agents with their commission

**Given** an authenticated `admin` of `org_a` with two agents in `org_a`
(one `active`, one `suspended`) and one `admin`
**When** `GET /api/agents` is called
**Then**
- Status `200 OK`
- Exactly the two agents are returned (the admin is excluded), ordered by `name`
- Each item includes `status` and `base_commission` (basis points)
- No `password_hash` / `password_salt` field is present

#### Scenario 2 — Empty roster

**Given** an admin whose org has no agents yet
**When** `GET /api/agents` is called
**Then** Status `200 OK`, body `{ "agents": [] }`

#### Scenario 3 — Agent is forbidden

**Given** an authenticated user with `role = 'agent'`
**When** `GET /api/agents` is called
**Then** Status `403`, body `{ "error": { "code": "FORBIDDEN" } }`

---

### US-A07 — Edit agent

#### Scenario 4 — Admin edits name, phone, and base commission

**Given** an admin of `org_a` and an agent `usr_abc` in `org_a`
**When** `PUT /api/agents/usr_abc` is called with
`{ "name": "Nuevo Nombre", "phone": "+52 ...", "base_commission": 1200 }`
**Then**
- Status `200 OK`
- The `users` row is updated; `updated_at` advances
- `email`, `role`, `status`, `organization_id` are unchanged
- Response echoes the updated agent

#### Scenario 5 — Invalid base commission is rejected

**Given** an admin and an agent in their org
**When** `PUT /api/agents/:id` is called with `base_commission` of `-1`, `10001`, or non-integer
**Then** Status `400`, body `{ "error": { "code": "VALIDATION_ERROR" } }`, no row changed

#### Scenario 6 — Editing a non-existent / foreign agent

**Given** an admin of `org_a`
**When** `PUT /api/agents/:id` targets an `:id` that does not exist, belongs to `org_b`,
or belongs to an `admin`
**Then** Status `404`, body `{ "error": { "code": "NOT_FOUND" } }`, no row changed

---

### US-A08 — Deactivate / reactivate

#### Scenario 7 — Admin deactivates an agent

**Given** an admin of `org_a` and an `active` agent `usr_abc` in `org_a`
**When** `POST /api/agents/usr_abc/deactivate` is called
**Then**
- Status `200 OK`, response shows `status = "suspended"`
- The `users` row has `status = 'suspended'`; the agent's history is untouched

#### Scenario 8 — Suspended agent loses access

**Given** agent `usr_abc` has `status = 'suspended'` and presents a valid `gm_access` cookie
**When** they call **any** authenticated endpoint (e.g. `GET /api/me`)
**Then** Status `403`, body `{ "error": { "code": "ACCOUNT_SUSPENDED" } }`,
and the session cookies are cleared

#### Scenario 9 — Suspended agent cannot refresh back in

**Given** agent `usr_abc` is `suspended`, their `gm_access` is expired but `gm_refresh` is valid
**When** they call an authenticated endpoint
**Then** Status `403 ACCOUNT_SUSPENDED` (the post-refresh branch also enforces the status check)

#### Scenario 10 — Reactivate restores access

**Given** a `suspended` agent `usr_abc` in `org_a`
**When** `POST /api/agents/usr_abc/reactivate` is called by the admin
**Then** Status `200 OK`, `status = 'active'`; the agent can authenticate again

#### Scenario 11 — Deactivate is idempotent

**Given** an already-`suspended` agent
**When** `POST /api/agents/:id/deactivate` is called again
**Then** Status `200 OK`, `status` remains `suspended` (no error)

#### Scenario 12 — Deactivating a non-existent / foreign / admin id

**Given** an admin of `org_a`
**When** `POST /api/agents/:id/deactivate` targets an unknown id, an `org_b` user, or an `admin`
**Then** Status `404 NOT_FOUND`, no row changed

---

### Multitenancy isolation (required — Scenarios B3 / B4)

Per `CLAUDE.md` and `docs/multitenancy/multitenancy.spec.md`, every tenant-scoped
route MUST ship cross-org isolation tests built on the `seedTwoOrgs` helper.

#### Scenario 13 — B4: List is scoped to caller's org

**Given** agents exist in both `org_a` and `org_b`
**When** the `org_a` admin calls `GET /api/agents`
**Then** only `org_a` agents are returned; no `org_b` agent ever appears

#### Scenario 14 — B3: Cross-org edit/deactivate is a 404

**Given** agent `usr_b` belongs to `org_b`
**When** the `org_a` admin calls `PUT /api/agents/usr_b`,
`POST /api/agents/usr_b/deactivate`, or `.../reactivate`
**Then** Status `404 NOT_FOUND`; `usr_b` is unchanged and the response does not reveal
that the user exists in another org (the org-filtered UPDATE simply matches 0 rows)

#### Scenario 15 — B1: Injected `organizationId` in body is ignored

**Given** an `org_a` admin edits one of their agents
**When** `PUT /api/agents/:id` body includes an extra `"organizationId": "org_b"`
**Then** the field is stripped by Zod; the row's `organization_id` stays `org_a`

---

## Definition of Done

- [ ] Migration `0005_add_base_commission_to_users.sql` adds `base_commission`
      (INTEGER NOT NULL DEFAULT 0) and `users_org_role_status_idx`
- [ ] `users` Drizzle schema updated with `baseCommission`
- [ ] `authMiddleware` selects `status` and rejects `suspended` with `403 ACCOUNT_SUSPENDED`
      on both the valid-token and post-refresh branches (Scenarios 8, 9)
- [ ] `ACCOUNT_SUSPENDED` (403) and `NOT_FOUND` (404) added to `ErrorCode`
- [ ] `GET /api/agents`, `PUT /api/agents/:id`, `POST /api/agents/:id/deactivate`,
      `POST /api/agents/:id/reactivate` implemented and mounted on the agents router
- [ ] All reads/writes filter by `c.var.user.organizationId` (Rules 2 & 4);
      no `organizationId` field in any Zod schema (Rule 1)
- [ ] `password_hash` / `password_salt` never serialized in any response
- [ ] Scenarios 1–12 covered by `test/staff/staff-management.test.ts`
- [ ] Scenarios 13–15 (B1/B3/B4) covered using `seedTwoOrgs`
- [ ] `pnpm test` green; `pnpm cf-typegen:api` run if bindings changed (none expected)
</content>
</invoke>
