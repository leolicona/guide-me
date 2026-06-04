# Feature: Schedules & Slots (Capacity by Date and Time)

## Context

A service in the catalog is sellable only when it has **slots** — concrete instances of
that service at a specific date and time, each with its own maximum capacity. This
feature lets the admin define those slots in two ways:

- **Specific-date slots** — a single one-off instance (e.g. "Canyon Sunrise Tour on
  2026-06-15 at 06:00, capacity 12").
- **Recurring schedules** — a weekly rule (e.g. "every Mon/Wed/Fri at 06:00, capacity
  12, from 2026-06-08 to 2026-07-31") that the server **materializes** into concrete
  slot rows across a bounded date window.

Each slot carries its **own** capacity, seeded from the parent service's
`default_capacity` but independently overridable (US-A10: "its independent capacity per
slot"). The `slots` table is the **inventory unit** that every downstream feature reads
and decrements — the POS deducts spots from it (US-AG04/AG11), the occupancy dashboard
reads its remaining capacity (US-A14/A15), and folio cancellation releases spots back to
it (US-A21).

**User Story:** **US-A10** — As an admin, I want to define recurring schedules or
specific dates for each service, with its independent capacity per slot.

**Builds on:** the Service Catalog feature (`docs/catalog/service-catalog.spec.md`) —
its `services` table, `default_capacity` seed, the admin-only `src/routes/services/`
router, and the `requireService` org-scoped parent guard. Slots & schedules are nested
**under a service**, mirroring how extras are nested.

**Out of scope (own features):**
- **Decrementing capacity on sale** (US-AG04, US-AG08, US-AG11) — POS feature. This
  feature creates the `slots.booked` column (always `0` here) and the remaining-capacity
  read shape, but the atomic decrement (`UPDATE … SET booked = booked + n WHERE capacity
  - booked >= n`) lands with POS.
- **Releasing capacity on cancellation** (US-A21) — Cancellations feature decrements
  `booked` back down.
- **Occupancy dashboard** (US-A14, US-A15) — the cross-service "today's slots" read and
  the available / close-to-capacity / full status rollup. This feature exposes the
  per-service slot list with `remaining`; the dashboard's cross-service aggregation and
  its `(organization_id, date)` index land there.
- **Agent-facing POS slot read** (US-AG03, US-AG10) — this feature's router is
  **admin-only**; agent read access lands with the POS feature.
- **Per-slot timezone handling** — see "Date & time representation": MVP assumes a
  single organization-local timezone (like the single-currency MVP decision). Slots
  store naive local `date` + `start_time` strings; an `organization.timezone` column is
  deferred to Phase 2.

**New endpoints (all admin-only, nested under a service):**

| Method & path | Purpose | US |
|---|---|---|
| `POST   /api/services/:id/slots` | Create one specific-date slot | A10 |
| `GET    /api/services/:id/slots` | List a service's slots (date-range + status filters) | A10 |
| `PUT    /api/services/:id/slots/:slotId` | Edit a slot's time / capacity | A10 |
| `POST   /api/services/:id/slots/:slotId/deactivate` | Soft-deactivate (close) a slot | A10 |
| `POST   /api/services/:id/slots/:slotId/reactivate` | Restore a slot | A10 |
| `POST   /api/services/:id/schedules` | Create a recurring schedule → materializes slots | A10 |
| `GET    /api/services/:id/schedules` | List a service's recurring schedules | A10 |
| `POST   /api/services/:id/schedules/:scheduleId/deactivate` | Deactivate a schedule + cascade-close its unbooked slots | A10 |

---

## Data Model

Two **new tenant-scoped tables**. Per Multitenancy Rule 5 each declares
`organization_id TEXT NOT NULL REFERENCES organizations(id)`. Both carry
`organization_id` **directly** (even though they could scope transitively through
`service_id`) so every query is independently org-filtered (Rules 2 & 4, defense in
depth) and gets a clean org-leading index (Rule 6) — the same decision the catalog made
for `service_extras`.

### Date & time representation

To avoid timezone ambiguity in the MVP (single-timezone assumption, mirroring the
single-currency decision in catalog), dates and times are stored as **TEXT**, not epoch
integers:

| Value | Format | Example |
|---|---|---|
| `date` | `YYYY-MM-DD` (ISO calendar date, org-local) | `2026-06-15` |
| `start_time` | `HH:MM` (24-hour, org-local) | `06:00` |

These sort lexicographically (so `ORDER BY date, start_time` is correct), are trivially
comparable for range filters, and dodge the UTC-vs-local pitfalls of epoch storage for a
human-scheduled calendar. `created_at` / `updated_at` remain epoch integers (machine
timestamps), consistent with every other table.

> **Deferred:** when multi-timezone support arrives (Phase 2), add
> `organizations.timezone` and interpret these naive local strings against it. No slot
> reshaping is needed — the strings already encode local wall-clock time.

### Capacity tracking

Each slot stores its total `capacity` and a `booked` counter (spots already sold).
**Remaining is derived**, never stored: `remaining = capacity - booked`. This feature
always writes `booked = 0`; the POS feature owns the atomic increment and US-A21 owns the
decrement-on-cancel. Keeping `capacity` immutable-by-edit-floor (an edit may not drop
`capacity` below `booked`) preserves the integrity of spots already sold.

### `slots` (new table) — the inventory unit

| Column | Type | Notes |
|---|---|---|
| `id` | `text` PK | `crypto.randomUUID()` |
| `organization_id` | `text NOT NULL` → `organizations(id)` | Rule 5 |
| `service_id` | `text NOT NULL` → `services(id)` | parent service |
| `schedule_id` | `text` (nullable) → `schedules(id)` | `NULL` = one-off specific-date slot; set = materialized from a recurring schedule |
| `date` | `text NOT NULL` | `YYYY-MM-DD` (org-local) |
| `start_time` | `text NOT NULL` | `HH:MM` (24h, org-local) |
| `capacity` | `integer NOT NULL` | `>= 1`; seeded from `service.default_capacity`, overridable |
| `booked` | `integer NOT NULL DEFAULT 0` | spots sold; `0 <= booked <= capacity`. Always `0` in this feature |
| `status` | `text NOT NULL DEFAULT 'active'` | enum `['active','inactive']` |
| `created_at` | `integer NOT NULL DEFAULT (unixepoch())` | |
| `updated_at` | `integer NOT NULL DEFAULT (unixepoch())` | |

Indexes (Rule 6):
```sql
CREATE INDEX slots_org_service_date_idx ON slots (organization_id, service_id, date);
-- No two ACTIVE slots may share the same service/date/time. Partial unique index
-- (SQLite supports WHERE on indexes); an inactive slot may coexist with a new active one.
CREATE UNIQUE INDEX slots_active_unique_idx
  ON slots (organization_id, service_id, date, start_time)
  WHERE status = 'active';
```

### `schedules` (new table) — the recurring rule / generator

A `schedules` row is **not** the inventory unit; it is a weekly recurrence rule that
groups the concrete slots it generated, so the admin can list and bulk-deactivate them.
MVP supports a single `weekly` recurrence kind over a bounded `[start_date, end_date]`
window. (Specific-date slots need no schedule row — they are created directly with
`schedule_id = NULL`.)

| Column | Type | Notes |
|---|---|---|
| `id` | `text` PK | |
| `organization_id` | `text NOT NULL` → `organizations(id)` | Rule 5 |
| `service_id` | `text NOT NULL` → `services(id)` | parent service |
| `recurrence` | `text NOT NULL DEFAULT 'weekly'` | enum `['weekly']` (extensible later) |
| `weekdays` | `text NOT NULL` | CSV of ISO weekday numbers, `0`=Sun … `6`=Sat (e.g. `"1,3,5"`) |
| `start_time` | `text NOT NULL` | `HH:MM` applied to every generated slot |
| `capacity` | `integer NOT NULL` | `>= 1`; per-slot capacity for every generated slot |
| `start_date` | `text NOT NULL` | `YYYY-MM-DD` inclusive horizon start |
| `end_date` | `text NOT NULL` | `YYYY-MM-DD` inclusive horizon end (`>= start_date`) |
| `status` | `text NOT NULL DEFAULT 'active'` | enum `['active','inactive']` |
| `created_at` | `integer NOT NULL DEFAULT (unixepoch())` | |
| `updated_at` | `integer NOT NULL DEFAULT (unixepoch())` | |

Index (Rule 6): `CREATE INDEX schedules_org_service_idx ON schedules (organization_id, service_id);`

> Migrations: `0008_create_schedules.sql`, `0009_create_slots.sql` (one table per file,
> matching the `0001`–`0007` style). `slots` references `schedules`, so `schedules` is
> created first (`0008`).

### Why eager materialization (and a bounded horizon)

A recurring schedule is **expanded into concrete `slots` rows at create time**, not
resolved lazily on read. This keeps the inventory model dead simple: there is always a
concrete row to decrement atomically (the SPEC race-condition rule needs
`UPDATE slots SET booked = booked + n WHERE id = ? AND capacity - booked >= n`), the
dashboard counts real rows, and there is **no cron dependency** (the platform has no
scheduled-job infrastructure in the MVP). The trade-off — an unbounded recurrence would
generate infinite rows — is contained by requiring an explicit `end_date` and capping the
window at **`MAX_HORIZON_DAYS = 366`** (one year). Extending a schedule past its horizon
in Phase 2 is a re-run that materializes the next window.

### Why soft-deactivate, never hard-delete

Consistent with the catalog (US-A13): slots and schedules are **never hard-deleted** in
the MVP. Deactivation flips `status` to `'inactive'`. A booked slot must survive so the
folio/QR it backs stays valid; an unbooked slot is simply hidden from future sale.
Deactivating a schedule cascades only to its **unbooked** slots (see below).

---

## Business rules (enforced server-side)

From SPEC → Key Business Rules → Inventory, plus US-A10:

1. **Independent per-slot capacity.** Every slot has its own `capacity >= 1`. The
   create endpoints default it to the parent `service.default_capacity` when the body
   omits `capacity`, but the admin may override per slot / per schedule.
2. **No duplicate active slot.** At most one **active** slot may exist for a given
   `(service, date, start_time)`. A specific-date create that collides with an existing
   active slot is rejected `409 CONFLICT`; schedule materialization **skips** dates that
   already have an active slot at that time (idempotent-ish re-generation) and reports the
   count actually generated. The partial unique index is the DB-level backstop.
3. **Capacity floor on edit.** Editing a slot may not set `capacity < booked` (would
   oversell spots already reserved) → `409 CONFLICT`. With `booked = 0` (this feature)
   any `capacity >= 1` is allowed; the guard protects the POS era.
4. **Booked slots are protected from closing.** Deactivating a schedule cascade-closes
   only its slots with `booked = 0`; slots with `booked > 0` stay `active` so their
   folios remain honorable. (A booked individual slot can still be force-closed via its
   own deactivate endpoint — that is the admin's explicit choice; cancellation/refund of
   the affected folios is the Cancellations feature's concern.)
5. **Bounded horizon.** `start_date <= end_date` and
   `end_date - start_date <= MAX_HORIZON_DAYS (366)` → else `400 VALIDATION_ERROR`.
6. **Slots only attach to a real service in the caller's org.** The parent `:id` is
   verified with the existing `requireService` guard → `404 NOT_FOUND` otherwise.

---

## Endpoints

All endpoints: **Auth required, `admin` only** (`authMiddleware` + `requireRole('admin')`
already applied to `*` on the `services` router). Cross-org and unknown ids resolve to
`404 NOT_FOUND` via the org-filtered query (Rules 2 & 4) — the response never reveals
whether the id exists in another organization.

The slot API shape always includes the derived `remaining`:

```json
{ "id": "slot_1", "service_id": "svc_abc", "schedule_id": null,
  "date": "2026-06-15", "start_time": "06:00",
  "capacity": 12, "booked": 0, "remaining": 12, "status": "active" }
```

### `POST /api/services/:id/slots` — Create a specific-date slot (US-A10)

#### Request body

```json
{ "date": "2026-06-15", "start_time": "06:00", "capacity": 12 }
```

| Field | Rule |
|---|---|
| `date` | required, `YYYY-MM-DD`, a real calendar date |
| `start_time` | required, `HH:MM` 24-hour (`00:00`–`23:59`) |
| `capacity` | optional, integer `>= 1`; **defaults to `service.default_capacity`** when omitted |

- `organizationId` / `booked` / `status` / `schedule_id` are never read from the body
  (Rule 1; Zod strips unknowns). Created `active`, `booked = 0`, `schedule_id = null`.
- Collision with an existing **active** slot at the same `(service, date, start_time)` →
  `409 CONFLICT`.

#### Response — 201 Created — `{ "slot": { … , "remaining": 12 } }`

### `GET /api/services/:id/slots` — List a service's slots (US-A10)

Returns the service's slots ordered by `date` then `start_time`. Defaults to **active
only**; pass `status=inactive` or `status=all` to widen.

**Query params (all optional):**

| Param | Effect |
|---|---|
| `from` | `YYYY-MM-DD` — include slots with `date >= from` |
| `to` | `YYYY-MM-DD` — include slots with `date <= to` |
| `status` | `active` (default) \| `inactive` \| `all` |

#### Response — 200 OK — `{ "slots": [ { …, "remaining": … }, … ] }`

### `PUT /api/services/:id/slots/:slotId` — Edit a slot (US-A10)

Edits `start_time` and/or `capacity` (and `date`). Full-replace of the editable fields,
mirroring catalog's PUT. `404` if no such slot under that service in the caller's org
(triple filter `slotId + serviceId + organizationId`).

#### Request body

```json
{ "date": "2026-06-15", "start_time": "07:00", "capacity": 15 }
```

- `capacity < booked` → `409 CONFLICT` (rule 3).
- Moving the slot to a `(date, start_time)` already taken by another active slot →
  `409 CONFLICT` (rule 2).

#### Response — 200 OK — `{ "slot": { …, "remaining": … } }`

### `POST /api/services/:id/slots/:slotId/deactivate` — Close a slot (US-A10)

Sets `status = 'inactive'`. Idempotent. The slot row (and any `booked`) is preserved.

#### Response — 200 OK — `{ "slot": { "id": "...", "date": "...", "start_time": "...", "status": "inactive" } }`

### `POST /api/services/:id/slots/:slotId/reactivate` — Restore a slot

Sets `status = 'active'`. Idempotent. Rejected `409 CONFLICT` if reactivating would
collide with another active slot at the same `(service, date, start_time)`.

#### Response — 200 OK — `{ "slot": { …, "status": "active" } }`

### `POST /api/services/:id/schedules` — Create a recurring schedule (US-A10)

Creates the `schedules` row, then **materializes** one `active` slot per matching date in
`[start_date, end_date]`, skipping dates already holding an active slot at `start_time`.

#### Request body

```json
{
  "weekdays": [1, 3, 5],
  "start_time": "06:00",
  "capacity": 12,
  "start_date": "2026-06-08",
  "end_date": "2026-07-31"
}
```

| Field | Rule |
|---|---|
| `weekdays` | required, non-empty array of distinct ints `0`–`6` (`0`=Sun … `6`=Sat) |
| `start_time` | required, `HH:MM` 24-hour |
| `capacity` | optional, integer `>= 1`; defaults to `service.default_capacity` |
| `start_date` | required, `YYYY-MM-DD` |
| `end_date` | required, `YYYY-MM-DD`, `>= start_date`, within `MAX_HORIZON_DAYS` of `start_date` |

- `recurrence` defaults to `'weekly'` (only value in MVP). `organizationId`/`status`
  never from body (Rule 1).

#### Response — 201 Created

```json
{
  "schedule": {
    "id": "sch_1", "service_id": "svc_abc", "recurrence": "weekly",
    "weekdays": [1, 3, 5], "start_time": "06:00", "capacity": 12,
    "start_date": "2026-06-08", "end_date": "2026-07-31", "status": "active"
  },
  "slots_generated": 24
}
```

### `GET /api/services/:id/schedules` — List recurring schedules (US-A10)

Returns the service's schedules ordered by `start_date`. Optional `?status=active|inactive`
(omitted = all). Lean shape — no embedded slots (use `GET …/slots` for those).

#### Response — 200 OK — `{ "schedules": [ { …, "weekdays": [1,3,5] }, … ] }`

### `POST /api/services/:id/schedules/:scheduleId/deactivate` — Deactivate a schedule (US-A10)

Sets the schedule `status = 'inactive'` **and** cascade-closes (`status = 'inactive'`)
every slot it generated that has `booked = 0`. Slots with `booked > 0` are left `active`
(rule 4). Idempotent. `404` if no such schedule under that service in the caller's org.

#### Response — 200 OK

```json
{
  "schedule": { "id": "sch_1", "status": "inactive" },
  "slots_closed": 18
}
```

---

## Error responses (all endpoints)

| Status | Code | Condition |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Bad `date`/`start_time` format, `capacity < 1`, non-integer, empty `weekdays`, weekday out of `0–6`, `end_date < start_date`, horizon `> 366` days |
| 401 | `UNAUTHORIZED` | No / unrefreshable session |
| 403 | `FORBIDDEN` | Authenticated as `agent`, not `admin` |
| 403 | `ACCOUNT_SUSPENDED` | Caller's own account is suspended (from `authMiddleware`) |
| 404 | `NOT_FOUND` | No service `:id` (or slot/schedule under it) in the caller's org — includes ids that exist in another org |
| 409 | `CONFLICT` | Duplicate active slot at `(service, date, start_time)`; or edit/reactivate that would collide; or `capacity < booked` |

> **New `ErrorCode`: `CONFLICT` (409).** This is the first consumer. Add `'CONFLICT'` to
> the `ErrorCode` union in `src/types/errors.ts` (the union currently ends at
> `NOT_FOUND` / `INTERNAL_ERROR`). The global error handler maps `ApiError.status` →
> response, so no handler-map change is needed beyond the union entry. Record the new
> code in `docs/TECH_DEBT.md` as introduced-and-consumed by this feature (no debt left
> open).

---

## Scenarios

### US-A10 — Specific-date slots

#### Scenario 1 — Admin creates a specific-date slot
**Given** an authenticated `admin` of `org_a` with a service `svc_a`
**When** `POST /api/services/svc_a/slots` with `{date, start_time, capacity: 12}`
**Then** Status `201`; a `slots` row exists in `org_a` with `schedule_id = NULL`,
`booked = 0`, `status = 'active'`; the response echoes `remaining = 12`.

#### Scenario 2 — Capacity defaults to the service's `default_capacity`
**Given** `svc_a` has `default_capacity = 10`
**When** a slot is created **without** `capacity`
**Then** the stored slot has `capacity = 10`, `remaining = 10`.

#### Scenario 3 — Invalid date / time / capacity → 400
**When** `date` is not `YYYY-MM-DD`, or `start_time` is not `HH:MM`, or `capacity` is `0`
/ negative / non-integer
**Then** Status `400 VALIDATION_ERROR`; no row written.

#### Scenario 4 — Duplicate active slot → 409
**Given** an active slot exists for `svc_a` on `2026-06-15` at `06:00`
**When** another slot is created for the same service/date/time
**Then** Status `409 CONFLICT`; only the original row exists.

#### Scenario 5 — List is ordered by date then time; respects range + status
**Given** `svc_a` has several active slots across dates and one inactive slot
**When** `GET /api/services/svc_a/slots`
**Then** Status `200`; only **active** slots, ordered by `date` then `start_time`, each
with `remaining`. With `?from=&to=` only in-range slots return; with `?status=all` the
inactive slot is included.

#### Scenario 6 — Edit changes time/capacity, advances `updated_at`
**Given** an active slot with `booked = 0`
**When** `PUT …/slots/:slotId` changes `start_time` and `capacity`
**Then** Status `200`; the row reflects the new values; `updated_at` advances;
`organization_id`/`service_id`/`status`/`booked` unchanged.

#### Scenario 7 — Edit to a colliding time → 409
**Given** active slots A (`06:00`) and B (`07:00`) on the same date
**When** `PUT` moves A to `07:00`
**Then** Status `409 CONFLICT`; both rows unchanged.

#### Scenario 8 — Deactivate / reactivate are idempotent
**Given** an active slot
**When** `POST …/deactivate` is called (twice) **then** `POST …/reactivate`
**Then** `200` each time; status ends `inactive` then `active`; the row is never deleted.

#### Scenario 9 — Reactivate into a taken time → 409
**Given** slot A is `inactive` at `06:00` and a new active slot B occupies `06:00`
**When** `POST …/A/reactivate`
**Then** Status `409 CONFLICT`; A stays `inactive`.

### US-A10 — Recurring schedules

#### Scenario 10 — Create a weekly schedule materializes the right slots
**Given** `svc_a` with `default_capacity = 12`
**When** `POST …/schedules` with `weekdays:[1,3,5]`, `start_time:"06:00"`,
`start_date:"2026-06-08"`, `end_date:"2026-06-21"` (no `capacity`)
**Then** Status `201`; a `schedules` row exists; one `active` slot per Mon/Wed/Fri in the
window is created with `schedule_id` set, `capacity = 12`, `booked = 0`;
`slots_generated` equals the number created.

#### Scenario 11 — Materialization skips already-occupied times
**Given** an active one-off slot already exists on a date/time the schedule would generate
**When** the schedule is created
**Then** that date is skipped (no duplicate, no `409`); `slots_generated` excludes it; the
pre-existing slot is unchanged.

#### Scenario 12 — `end_date < start_date` or horizon > 366 days → 400
**When** a schedule has `end_date` before `start_date`, or a window wider than
`MAX_HORIZON_DAYS`
**Then** Status `400 VALIDATION_ERROR`; no schedule and no slots written.

#### Scenario 13 — Empty / out-of-range `weekdays` → 400
**When** `weekdays` is `[]` or contains a value outside `0–6`
**Then** Status `400 VALIDATION_ERROR`.

#### Scenario 14 — List schedules ordered by start_date
**Given** `svc_a` has two schedules
**When** `GET …/schedules`
**Then** Status `200`; both returned ordered by `start_date`; `weekdays` is an int array;
no embedded slots.

#### Scenario 15 — Deactivate schedule cascades to unbooked slots only
**Given** a schedule with several generated slots, one of which has `booked = 2`
**When** `POST …/schedules/:id/deactivate`
**Then** Status `200`; the schedule is `inactive`; every generated slot with `booked = 0`
is now `inactive`; the slot with `booked = 2` stays `active`; `slots_closed` counts only
the closed ones.

#### Scenario 16 — Agent is forbidden
**Given** a user with `role = 'agent'`
**When** any `/api/services/:id/slots*` or `/schedules*` endpoint is called
**Then** Status `403 FORBIDDEN`.

#### Scenario 17 — Unknown / foreign parent service → 404
**Given** an admin of `org_a`
**When** any slots/schedules endpoint targets a service id absent from `org_a`
**Then** Status `404 NOT_FOUND`; nothing written.

### Multitenancy isolation (required — Scenarios B3 / B4)

Per `CLAUDE.md` and `docs/multitenancy/multitenancy.spec.md`, every tenant-scoped route
MUST ship cross-org isolation tests built on `seedTwoOrgs`.

#### Scenario 18 — B4: Slot/schedule lists are scoped to the caller's org
**Given** slots and schedules exist for services in both `org_a` and `org_b`
**When** the `org_a` admin lists slots/schedules for its own service
**Then** only `org_a` rows are returned; no `org_b` row ever appears.

#### Scenario 19 — B3: Cross-org slot/schedule ops → 404
**Given** slot `slot_b` / schedule `sch_b` belong to a service in `org_b`
**When** the `org_a` admin targets them (get-list under svc_b, edit/deactivate/reactivate
a slot, deactivate a schedule)
**Then** Status `404 NOT_FOUND`; `org_b` rows are unchanged; the response does not reveal
they exist in another org.

#### Scenario 20 — B1: Injected `organizationId` / `booked` / `status` in body is ignored
**Given** an `org_a` admin creates a slot or schedule
**When** the body includes `"organizationId": "org_b"`, `"booked": 99`, or
`"status": "inactive"`
**Then** those fields are stripped by Zod; the row's `organization_id` stays `org_a`,
`booked = 0`, `status = 'active'`.

---

## Definition of Done

- [ ] Migrations `0008_create_schedules.sql` + `0009_create_slots.sql` create both tables
      with `organization_id` (Rule 5), org-leading indexes (Rule 6), and the partial
      unique index on active slots
- [ ] Drizzle schema: `schedules` + `slots` tables and inferred types
- [ ] `'CONFLICT'` added to the `ErrorCode` union (`src/types/errors.ts`); documented in
      `docs/TECH_DEBT.md` as introduced-and-consumed here
- [ ] Slot & schedule handlers added under `src/routes/services/` (own
      `slots.handler.ts` / `slots.schema.ts` or folded into the existing handler — see
      plan), mounted on the existing admin-only `services` router
- [ ] `date`/`start_time` stored as TEXT (`YYYY-MM-DD` / `HH:MM`); `capacity >= 1`;
      `booked` defaults `0`; `remaining` derived in the response, never stored
- [ ] Capacity defaults to `service.default_capacity` when omitted; per-slot override honored
- [ ] Duplicate-active-slot → `409`; edit/reactivate collision → `409`; `capacity < booked`
      → `409`; horizon/weekday/format violations → `400`
- [ ] Schedule create materializes slots over a bounded window, skipping occupied times;
      schedule deactivate cascade-closes only `booked = 0` slots
- [ ] All reads/writes filter by `c.var.user.organizationId` (Rules 2 & 4); no
      `organizationId`/`status`/`booked` field in any Zod schema (Rule 1); parent guarded
      by `requireService`
- [ ] Scenarios 1–17 covered by `test/catalog/schedules-slots.test.ts` (or
      `test/schedules/…`)
- [ ] Scenarios 18–20 (B1/B3/B4) covered using `seedTwoOrgs`
- [ ] Frontend: `schedulesService`, feature dir (`features/schedules/`) types/schemas/hooks,
      a **Schedules & Slots** section on the service detail page (`CatalogDetailPage`),
      specific-date slot form, recurring-schedule form, slot list grouped by date
- [ ] `pnpm --filter api-guideme test` green; `pnpm build:app` clean
- [ ] `docs/SPEC.md` MUST-HAVE item **Schedules/slots with capacity by date and time
      (US-A10)** ticked
