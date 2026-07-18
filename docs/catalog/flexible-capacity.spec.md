# Feature: Flexible Capacity & Overbooking Tolerance (Hard / Soft Cap)

## Context

Every service in the catalog has a per-slot `capacity` (seeded from the service's
`default_capacity`, US-A09/US-A10). Today that ceiling is **strict**: the POS never
lets a seller exceed it. This feature lets the admin mark a service as **Soft Cap**,
permitting a bounded amount of controlled overbooking so agents can capture
last-minute demand without manually overriding inventory — while leaving the default
behaviour (**Hard Cap**) untouched for operations that cannot stretch.

The admin declares the capacity mode and (when flexible) a **tolerance percentage**
in the catalog service form. The POS reads those two fields and computes the slot's
**Effective Capacity** live as the agent moves the people counter; the existing
atomic capacity guard enforces against that effective ceiling at confirmation.

**User Story:** **US-A36** (capacity type + tolerance on create/edit; persisted on
`services`; surfaced in the POS payload).

**Builds on:**
- `docs/catalog/service-catalog.spec.md` — the `services` table and the admin-only
  `POST`/`PUT /api/services` form this feature extends with two columns/fields.
- `docs/pos/pos-controlled-discount.spec.md` — the POS catalog reads
  (`GET /api/pos/services`, `GET /api/pos/services/:id`) and the atomic
  capacity guard in `confirmSale` (`src/routes/pos/handler.ts`).
- `docs/schedules/schedules-slots.spec.md` — `slots.capacity` / `slots.booked`,
  the per-slot numbers the effective ceiling is derived from.

**Out of scope (own features):**
- Any change to how slots are generated or to `slots.capacity` itself. The flex margin
  is **derived at read/confirm time** from the service's tolerance and the slot's own
  `capacity`; it is never persisted onto the slot row.
- Per-slot tolerance overrides. Tolerance lives on the **service** in MVP; a slot-level
  override is a possible later `ALTER TABLE` on `slots`, not built here.
- A standalone Settings UI. This feature adds the **org ceiling column + its validation**;
  surfacing it in a Configuración home is tracked under US-A29's settings home
  (SPEC → Reorg Phase 3 "Configuración home").

---

## Data Model

### `services` — two new columns (migration `0031`)

| Column | Type | Notes |
|---|---|---|
| `is_flexible` | `integer NOT NULL DEFAULT 0` | boolean (`0` = Hard Cap, `1` = Soft Cap). **New services default Hard Cap** (US-A36). |
| `flex_capacity_pct` | `integer NOT NULL DEFAULT 0` | tolerance as a whole-number percent of the slot capacity. Meaningful only when `is_flexible = 1`; ignored (and must be `0`) for Hard Cap. |

```sql
-- migrations/0031_add_flex_capacity_to_services.sql
ALTER TABLE `services` ADD COLUMN `is_flexible` integer DEFAULT 0 NOT NULL;
ALTER TABLE `services` ADD COLUMN `flex_capacity_pct` integer DEFAULT 0 NOT NULL;
```

> Additive, backfill-free: every existing service becomes Hard Cap with a `0` tolerance —
> byte-identical enforcement to today. Mirrors the additive `0023_add_commission_bonus_to_services`
> pattern.

Drizzle (`src/db/schema.ts`, `services` table) — append after `commissionValue`:

```ts
// Flexible capacity / overbooking tolerance (US-A36 — docs/catalog/flexible-capacity.spec.md).
// is_flexible = false → Hard Cap (strict). true → Soft Cap: the POS allows up to
// flex_capacity_pct extra spots per slot (floor(slot.capacity × pct / 100)). pct is bounded
// by the org's flex_cap_max_pct ceiling; it is 0 (and ignored) for Hard Cap services.
isFlexible: integer('is_flexible', { mode: 'boolean' }).notNull().default(false),
flexCapacityPct: integer('flex_capacity_pct').notNull().default(0),
```

### `organizations` — one new column: the configurable ceiling (migration `0031`)

US-A36 requires the tolerance's upper bound to be **configurable by the admin in the
settings panel**. Stored per org, mirroring `ack_window_hours` (`0026`):

| Column | Type | Notes |
|---|---|---|
| `flex_cap_max_pct` | `integer NOT NULL DEFAULT 30` | The largest `flex_capacity_pct` any service in the org may use. Admin-configurable; allowed range `1–100`. The **lower** bound for an enabled tolerance is a fixed `1` (a Soft Cap service must allow at least one margin step). |

```sql
ALTER TABLE `organizations` ADD COLUMN `flex_cap_max_pct` integer DEFAULT 30 NOT NULL;
```

```ts
// Largest overbooking tolerance (%) any service may set; admin-configurable (US-A36).
flexCapMaxPct: integer('flex_cap_max_pct').notNull().default(30),
```

> One migration file (`0031`) carries all three `ALTER TABLE`s — they ship as one feature.

---

## Effective Capacity — the core rule

For a slot belonging to service `S`:

```
effective_capacity(slot) =
  S.is_flexible
    ? slot.capacity + floor(slot.capacity × S.flex_capacity_pct / 100)
    : slot.capacity
```

- **`floor`** (not `round`/`ceil`) so actual overbooking never exceeds the stated
  tolerance — a 10-seat slot at 25 % yields `+2` (not `+3`), capping at 12.
- `effective_remaining = effective_capacity − slot.booked`. A Hard Cap service has
  `effective_capacity = slot.capacity`, so its behaviour is unchanged.
- The formula is small and pure — define it once (`src/utils/capacity.ts`,
  `effectiveCapacity(slotCapacity, isFlexible, flexPct)`) and share it between the POS
  serializer (display) and the atomic confirmation guard (enforcement) so the two can
  never drift.

---

## Validation rules (server-side, shared with the frontend via Zod)

On the catalog `services` schema (`src/routes/services/schema.ts`), extend create/edit:

| Field | Rule |
|---|---|
| `is_flexible` | optional boolean, defaults `false`. |
| `flex_capacity_pct` | optional integer. **Hard Cap** (`is_flexible` false/absent): must be `0` or absent (coerced to `0`). **Soft Cap** (`is_flexible` true): **required, `>= 1`** and `<= org.flex_cap_max_pct`. |

Cross-field guard (Zod `superRefine`, since the upper bound is the caller's org ceiling
fetched in the handler, not a literal):

- Soft Cap with `flex_capacity_pct` empty / `0` → `400 VALIDATION_ERROR`. **This is the
  rule that satisfies US-A36's "form will not allow saving if Flexible is selected but
  the field is empty or 0."** The frontend mirrors it (disabled Save) and the API
  enforces it.
- `flex_capacity_pct > org.flex_cap_max_pct` → `400 VALIDATION_ERROR`.

On the org-settings schema (`organizations` route):

- `flex_cap_max_pct` integer, `1 <= flex_cap_max_pct <= 100`. Lowering it does **not**
  retroactively clamp services already above it (existing folios/slots untouched); the
  new ceiling applies to the next service create/edit. *(Open: whether to warn the admin
  that N services exceed the new ceiling — out of scope here; defaulting to no
  retroactive change.)*

---

## API surface

### Admin catalog (extends `docs/catalog/service-catalog.spec.md`)

`POST /api/services` and `PUT /api/services/:id` accept the two new fields. Per
Multitenancy Rule 1, `organization_id` is still never read from the body. Example body:

```json
{
  "name": "Canyon Sunrise Tour",
  "base_price": 150000,
  "minimum_price": 120000,
  "default_capacity": 12,
  "is_flexible": true,
  "flex_capacity_pct": 25
}
```

`GET /api/services` and `GET /api/services/:id` echo `is_flexible` + `flex_capacity_pct`
on the service object so the form can re-hydrate the control on edit.

### Org settings (extends the `organizations` route)

`GET`/`PUT` of the org's settings includes `flex_cap_max_pct` alongside
`ack_window_hours`. Admin-only.

### POS — the payload the frontend computes from (US-A36 §5)

Both POS service reads expose the two service-level fields so the agent UI can compute
Effective Capacity live as the people counter changes:

- `GET /api/pos/services/:id` (`getPosService`) — the **service-detail + slots** payload.
  The service object gains `is_flexible` and `flex_capacity_pct`; each slot keeps its
  existing `capacity` / `booked` / `remaining` and additionally exposes
  `effective_capacity` and `effective_remaining` (server-computed via the shared helper,
  so a client that doesn't recompute still gets correct numbers).
- `GET /api/pos/services` (`listPosServices`) — the catalog rollup. `available_spots`
  becomes the sum of **effective** remaining over active future slots, so a Soft Cap
  service advertises its stretched availability consistently with the detail screen.

Example `GET /api/pos/services/:id` slot fragment:

```json
{
  "id": "slot_1",
  "date": "2026-06-20",
  "start_time": "07:00",
  "capacity": 12,
  "booked": 12,
  "remaining": 0,
  "effective_capacity": 15,
  "effective_remaining": 3
}
```

### POS — enforcement (the guard already exists)

`confirmSale` rejects a sale when remaining `< quantity` via an atomic
`UPDATE … WHERE capacity - booked >= quantity` (today at `src/routes/pos/handler.ts`,
the `gte(slots.capacity - slots.booked, quantity)` predicate). For this feature the
predicate compares against **effective** capacity for Soft Cap services:

```
WHERE (capacity + (is_flexible ? floor(capacity × flex_capacity_pct / 100) : 0)) - booked >= quantity
```

Implement by joining/sub-selecting the service's `is_flexible` / `flex_capacity_pct`
into the conditional `UPDATE` (or precomputing the effective ceiling in the handler and
binding it into the `WHERE`). The guard stays a **single atomic statement** — the
race-condition protection (US-AG11) and the existing rollback path are unchanged; only
the ceiling moves. A Hard Cap service yields the byte-identical predicate it has today.

---

## Frontend (catalog form + POS counter)

- **Catalog service form** (`features/Catalog`): a capacity-type control (segmented
  toggle / radio — *Cupo estricto* vs *Cupo flexible*), defaulting to **Hard Cap** for a
  new service. Selecting Hard Cap hides/disables the *Lugares extra permitidos* numeric
  stepper; selecting Soft Cap enables it (`min=1`, `max=org.flex_cap_max_pct`, `step=1`).
  Save is disabled — and the shared Zod schema rejects — when Soft Cap is on but the
  field is empty/`0`. **Inline help text** under the field explains the impact, e.g.
  *"Permite vender hasta {pct}% por encima del cupo en cada horario (≈ {n} lugares extra
  para un cupo de {cap}). Úsalo para asegurar ventas de último minuto sin sobrepasar la
  operación."*
- **POS people counter** (`features/Pos`): uses `effective_capacity` /
  `effective_remaining` from `GET /api/pos/services/:id` to bound the counter and render
  the remaining indicator, recomputing the available margin live as quantity changes.
  Hard Cap behaves exactly as today.
- **Settings (Configuración)**: a single numeric field for `flex_cap_max_pct`
  (`1–100`), alongside the acknowledgment window — folded into the US-A29 settings home
  when that ships; until then exposed via the org-settings endpoint.

---

## Scenarios

### US-A36 — Admin defines capacity type & tolerance

#### Scenario 1 — New service defaults to Hard Cap
**Given** an authenticated `admin`
**When** `POST /api/services` is called with no capacity-type fields
**Then** Status `201`; the row has `is_flexible = false`, `flex_capacity_pct = 0`.

#### Scenario 2 — Soft Cap requires a non-zero tolerance
**Given** an admin
**When** `POST`/`PUT /api/services` is called with `is_flexible = true` and
`flex_capacity_pct` omitted, `0`, or negative
**Then** Status `400 VALIDATION_ERROR`; no row is written/changed.

#### Scenario 3 — Tolerance above the org ceiling is rejected
**Given** an org with `flex_cap_max_pct = 30`
**When** an admin sends `is_flexible = true`, `flex_capacity_pct = 31`
**Then** Status `400 VALIDATION_ERROR`.

#### Scenario 4 — Hard Cap forces tolerance to zero
**Given** an admin
**When** `is_flexible = false` is sent with `flex_capacity_pct = 25`
**Then** the stored `flex_capacity_pct` is coerced to `0` (or `400` per chosen strictness
— spec picks **coerce to 0**); the service is strict.

#### Scenario 5 — Toggling a service back to Hard Cap clears the margin
**Given** a Soft Cap service at 20 %
**When** `PUT /api/services/:id` sets `is_flexible = false`
**Then** Status `200`; `flex_capacity_pct = 0`; the service enforces strictly thereafter.

### US-A36 §4 — Persistence

#### Scenario 6 — Fields round-trip through detail reads
**Given** a Soft Cap service at 25 %
**When** `GET /api/services/:id` is called
**Then** the response carries `is_flexible = true`, `flex_capacity_pct = 25`.

### US-A36 §5 — POS payload & Effective Capacity

#### Scenario 7 — Soft Cap slot exposes a stretched ceiling
**Given** a Soft Cap service at 25 % with a slot `capacity = 12`, `booked = 12`
**When** `GET /api/pos/services/:id` is called
**Then** the slot reports `remaining = 0`, `effective_capacity = 15`,
`effective_remaining = 3` (`floor(12 × 25/100) = 3`).

#### Scenario 8 — Hard Cap slot is unchanged
**Given** a Hard Cap service with a slot `capacity = 12`, `booked = 12`
**When** `GET /api/pos/services/:id` is called
**Then** `effective_capacity = 12`, `effective_remaining = 0` (equal to `capacity` /
`remaining`).

#### Scenario 9 — Floor rounding caps the margin
**Given** a Soft Cap service at 10 % with a slot `capacity = 5`
**When** the effective capacity is computed
**Then** it is `5` (`floor(5 × 10/100) = floor(0.5) = 0`) — no phantom extra seat.

### POS enforcement (US-AG11 preserved)

#### Scenario 10 — Sale within the flex margin succeeds
**Given** a Soft Cap slot `capacity = 12`, `booked = 12`, tolerance giving `+3`
**When** an agent confirms a sale of `2`
**Then** Status `201`; `booked` becomes `14` (still within `effective_capacity = 15`).

#### Scenario 11 — Sale beyond the effective ceiling is blocked
**Given** the same slot now at `booked = 14`, `effective_capacity = 15`
**When** an agent confirms a sale of `2`
**Then** the sale is rejected with the existing capacity error; `booked` stays `14`
(atomic guard against effective capacity).

#### Scenario 12 — Hard Cap blocks at the strict ceiling
**Given** a Hard Cap slot `capacity = 12`, `booked = 12`
**When** an agent confirms a sale of `1`
**Then** the sale is rejected — identical to today's behaviour.

### Org ceiling

#### Scenario 13 — Admin lowers the org ceiling
**Given** an org admin
**When** `PUT` org settings sets `flex_cap_max_pct = 15`
**Then** Status `200`; a subsequent service create with `flex_capacity_pct = 20` now
fails `400`; services already at `20 %` are unchanged (no retroactive clamp).

#### Scenario 14 — Ceiling out of range
**When** `flex_cap_max_pct` is set to `0` or `101`
**Then** Status `400 VALIDATION_ERROR`.

### Multitenancy isolation (required — Scenarios B1 / B3)

#### Scenario 15 — B1: Injected `is_flexible`/`organizationId` honoured/stripped correctly
**Given** an `org_a` admin
**When** a service body includes `"organizationId": "org_b"`
**Then** the org field is stripped (Rule 1); the row's `organization_id` stays `org_a`;
`is_flexible`/`flex_capacity_pct` persist as sent.

#### Scenario 16 — B3: Soft Cap of another org never leaks via POS
**Given** a Soft Cap service in `org_b`
**When** an `org_a` seller calls `GET /api/pos/services/:id` for it
**Then** Status `404 NOT_FOUND`; the foreign org's tolerance is never revealed.

---

## Definition of Done

- [ ] Migration `0031_add_flex_capacity_to_services.sql` adds `is_flexible` +
      `flex_capacity_pct` to `services` and `flex_cap_max_pct` to `organizations`
      (additive, default-safe).
- [ ] Drizzle schema updated on `services` and `organizations`; inferred types flow.
- [ ] `src/utils/capacity.ts` `effectiveCapacity()` helper, shared by the POS serializer
      and the `confirmSale` guard (single source of the rounding rule).
- [ ] Catalog `services` Zod schema enforces: Hard Cap ⇒ `pct = 0`; Soft Cap ⇒
      `1 <= pct <= org.flex_cap_max_pct`; empty/`0` Soft Cap ⇒ `400`.
- [ ] Org-settings schema/route validates `flex_cap_max_pct` (`1–100`).
- [ ] `GET /api/services` + `GET /api/services/:id` echo the two service fields.
- [ ] `GET /api/pos/services/:id` slots expose `effective_capacity` /
      `effective_remaining`; `GET /api/pos/services` rollup uses effective remaining.
- [ ] `confirmSale` atomic guard compares against effective capacity for Soft Cap;
      Hard Cap predicate unchanged; race protection (US-AG11) intact.
- [ ] Frontend: capacity-type control (Hard default) + conditional tolerance stepper with
      inline help; POS counter bounded by effective remaining; settings field for the
      org ceiling.
- [ ] Scenarios 1–14 covered in `test/catalog/flexible-capacity.test.ts` (+ POS guard
      tests where the confirmation path lives).
- [ ] Scenarios 15–16 (B1/B3) covered using `seedTwoOrgs`.
- [ ] SPEC.md updated (US-A36, Inventory rule, Phase-2 entry, glossary) — done.
- [ ] `pnpm --filter api-turistear test` green; `pnpm build:app` clean.
