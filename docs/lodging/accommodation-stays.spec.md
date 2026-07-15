# Feature: Accommodation Stays (Lodging — Unit-Type Inventory, Nightly Pricing, Date-Range Booking)

**Category:** `lodging` (the `Hospedaje` chip from US-A37 — `docs/catalog/service-categories.spec.md`).
**Stories:** **US-A59 … US-A63** (admin configuration), **US-AG36 … US-AG38** (agent/affiliate selling).
**Status:** Specification **v2 — Unit-Type Inventory** (per the approved
`docs/RFCs/rfc-airbnb-inventory-model.md`, 2026-07-07). Supersedes the v1 named-physical-units
model, which shipped in migrations `0035`–`0041`; the v2 delta is migration `0042` + the API/POS
refactor below.
**Owner modules:** `api-guideme/src/routes/services/` (admin config), `api-guideme/src/routes/pos/`
(availability + sale), `app-guideme/src/features/catalog/` + `app-guideme/src/features/pos/`.

---

## 1. Context

Every tour service is a **per-slot, single-occurrence** product: an instance at one
`(date, start_time)` with a `capacity`/`booked` counter, sold by decrementing N *spots* for
that one occurrence (`docs/schedules/schedules-slots.spec.md`, `docs/catalog/service-catalog.spec.md`).
A POS sale is one slot, one day.

**Accommodation breaks that model.** A tourist stays **more than one day**, so the product is
fundamentally different and needs its own inventory primitive **beside** `slots` (never a tweak
to it):

| Tours / activities | Accommodation (this feature) |
|---|---|
| One `(date, start_time)` occurrence | A **date range** [check-in … check-out) = N nights |
| Sell *spots* against a per-day counter | Reserve a **quantity of a unit type** for every night of the range |
| Flat `base_price` per ticket | **nights × nightly rate (+ extra-person)**, rate may vary by weekend/season |
| Available = `remaining ≥ qty` on one day | Available = **per-night remaining ≥ qty on *every* night** ∧ meets min-stay |

### v1 → v2: from physical rooms to room types

v1 (the original US-A59 decision D1) modeled **named physical units** — "Cabaña 1", "Room 101" —
each individually bookable. The approved RFC replaces that with the **OTA / Airbnb model**:

- The sellable thing is a **unit type** ("Habitación Estándar", "Cabaña Río") carrying an
  **`inventory_count`** (how many interchangeable rooms of that type exist).
- The agent sells **`quantity` rooms of a type** for a range; **nobody picks a physical room**.
- A boutique property is the degenerate case: each unique cabin is its own type with
  `inventory_count = 1` — and it gains its own card in the POS catalog (premium visibility).
- The POS catalog is **flattened**: lodging appears as one card **per unit type** (not per parent
  service), alongside tour cards.

This remains the **first category-specific service type**: a category that carries its own child
inventory + its own availability/pricing engine, without disturbing the tour flow — a `lodging`
service still never uses slots/schedules.

### Confirmed decisions (this spec)

| # | Topic | Decision |
|---|---|---|
| D1 | **Inventory model** | **Unit types with counts** (RFC). A `lodging` service is the property/listing; it owns unit types (`accommodation_unit_types`), each with an `inventory_count`. A stay reserves a *quantity* of a type, never a physical room. *(Supersedes v1 named units.)* |
| D2 | **Where config lives** | **Per unit type.** Each type carries its own rate rules, occupancy, beds, amenities, min-stay, check-in/out, block-outs, and seasonal overrides — a suite ≠ a cabin. |
| D3 | **Pricing** | Per night: **seasonal override > weekend rate > base rate**, plus a flat per-extra-person-per-night surcharge above a base occupancy, capped at a hard max capacity. Weekend days are org-configurable (default Fri+Sat). Extra-person fee does **not** vary by season. |
| D4 | **Turnover** | **Standard hotel.** A stay occupies nights `[check_in … check_out)`; the check-out day is free for a same-day arrival. Min-stay counts **nights** = `check_out − check_in`. |
| D5 | **Min-stay** | A single `min_nights` **per unit type**. Seasonal min-stay is deferred. |
| D6 | **Admin scope** | Block-out calendar (now quantity-based, D11), minimum stay, check-in/out times, and amenity tags all ship (plus inventory count + nightly rates + extra-person). |
| D7 | **Sale path** | Reuse the existing **cart → folio** flow; a stay is one folio line spanning the range (`quantity` = rooms). **Deposit/apartado supported** (`docs/bookings/bookings-down-payments.spec.md`). |
| D8 | **Agent entry points** | **Both** range-first (pick dates → see available types) **and** type-first (tap a type card → pick the range on its remaining-count calendar). |
| D9 | **Cancellation** | **Split by folio status.** A `booking`-status stay cancelled keeps the **non-refundable-deposit** rule (US-AG07.4). A fully-`paid` stay cancelled uses the **structured free-window + penalty %** refund. |
| D10 | **Availability guard** | **Per-night atomic count guard** (RFC §3.2). ∀ night of the stay: `reserved(night) + blocked(night) + requested ≤ inventory_count`, enforced as one conditional `INSERT` (D1 has no interactive transactions). Insufficient → `409 INSUFFICIENT_INVENTORY`. *(A naive SUM over overlapping reservations over-counts and produces false 409s — forbidden.)* |
| D11 | **Block-outs** | **Type-level quantity block-outs** (RFC §3.3): a block-out removes `quantity` rooms of the type from the pool for `[start, end)`. Overlapping block-outs sum. `quantity = inventory_count` closes the type; for a count-1 boutique it equals the v1 behavior. |
| D12 | **Multi-room pricing** | **Total-guests fast path** (RFC §3.4): the agent enters total `guests` + `quantity`; capacity check `1 ≤ guests ≤ max_capacity × quantity`; guests split across rooms as evenly as possible and each room is quoted by the D3 engine; line total = sum. *(Per-room guest entry rejected — too many taps for a POS.)* |
| D13 | **Commission on stays** | Waterfall unchanged (`type override ?? service base`; affiliate rate wins). `percent` = percent of the line total. **`fixed` counts per room-stay** = `commission_value × quantity` (mirrors tours' per-spot fixed). |
| D14 | **Catalog flattening** | `GET /api/pos/services` returns a mixed list with an **`item_type: 'tour' \| 'unit_type'`** discriminator; lodging contributes one card per active unit type (stable `id` = the unit type's id). The parent service is never a card. |

### Out of scope (own features / later)

- **Physical room assignment.** GuideMe is a **sales POS, not a PMS**: the system tracks *how
  many* rooms of a type are sold per night, never *which* physical room a guest occupies. Key
  assignment at check-in happens outside GuideMe (the property's PMS, front-desk board, or paper).
  "Which room was sold?" is by-design out of scope, not a bug.
- **Per-night manual discount** on a stay (the US-AG06 minimum-price floor is per-ticket, not
  per-night). Stays sell at the computed total; discounting stays is deferred.
- **Seasonal minimum-stay** and **season-varying extra-person fee** (D3/D5).
- **Per-room guest allocation** at sale time (D12 chose the even-split fast path; revisit only if
  agents report material `extra_person_fee` disputes).
- **Tourist self-service** booking (the Phase-2 B2C portal); agent/affiliate-sold only.
- **Multi-timezone** — naive org-local `YYYY-MM-DD` dates, same as slots.

### Builds on

- `docs/RFCs/rfc-airbnb-inventory-model.md` — the approved transition RFC (migration strategy,
  guard math, pricing semantics, scope statement) this v2 implements.
- `docs/catalog/service-categories.spec.md` — the `lodging` category key that flags a service as
  accommodation and routes it through this engine.
- `docs/catalog/service-catalog.spec.md` — the parent `services` table, the admin-only
  `services` router, and the `requireService` org-scoped parent guard (unit types/seasons/blockouts
  nest under a service exactly like extras and slots).
- `docs/bookings/bookings-down-payments.spec.md` — the apartado lifecycle (deposit hold, one-shot
  settle, manual cancel US-AG07.4, auto-expiry sweep, reactivate US-AG07.5) the stay reuses.
- `docs/cancellation/total-folio-cancellation.spec.md` — US-A21 folio cancellation, extended to
  release reservations and apply the structured refund for paid stays (D9).
- `docs/multitenancy/multitenancy.spec.md` — every table is tenant-scoped (Rules 1–6);
  cross-org ids resolve `404`.

---

## 2. Data Model

All money is **integer minor units** (centavos), single currency (MXN), per the catalog rule.
All dates are **TEXT `YYYY-MM-DD`** (org-local), all times **TEXT `HH:MM`** (24h) — same
representation and rationale as `slots`. Every table carries `organization_id` **directly**
(Rule 5) with an org-leading index (Rule 6), even where it could scope transitively, for defense
in depth (Rules 2 & 4).

> **Migration `0042_unit_type_inventory.sql`** (RFC §3.1 — *rename, don't drop*). D1's remote
> `/query` endpoint enforces FKs **per statement** and ignores `PRAGMA defer_foreign_keys` (the
> 0040 lesson), so the v1 tables are **renamed and extended**, never dropped — SQLite's
> `ALTER TABLE … RENAME` repoints all inbound FK definitions automatically:
>
> 1. Wipe dev/test data (stay folios/lines, reservations, seasons, blockouts, unit rows) —
>    confirmed disposable; no transform needed.
> 2. `accommodation_units` → **`RENAME TO accommodation_unit_types`**; add
>    `inventory_count INTEGER NOT NULL DEFAULT 1`.
> 3. `accommodation_reservations`: `RENAME COLUMN unit_id TO unit_type_id`; add
>    `quantity INTEGER NOT NULL DEFAULT 1`.
> 4. `accommodation_blockouts`: `RENAME COLUMN unit_id TO unit_type_id`; add
>    `quantity INTEGER NOT NULL DEFAULT 1`.
> 5. `accommodation_seasons`: `RENAME COLUMN unit_id TO unit_type_id`.
> 6. `folio_lines`: `RENAME COLUMN unit_id TO unit_type_id`. **No new column** — the existing
>    `quantity` column (hardcoded `1` for v1 stay lines) now carries the room count.

### 2.1 `accommodation_unit_types` (renamed from `accommodation_units`) — a sellable room type

| Column | Type | Notes |
|---|---|---|
| `id` | `text` PK | `crypto.randomUUID()` |
| `organization_id` | `text NOT NULL` → `organizations(id)` | Rule 5 |
| `service_id` | `text NOT NULL` → `services(id)` | parent `lodging` service (the property) |
| `name` | `text NOT NULL` | non-empty, e.g. `"Habitación Estándar"`, `"Cabaña Río"` |
| `unit_type` | `text` (nullable) | free label, e.g. `cabin` / `suite` (admin-defined; not a closed enum) |
| `inventory_count` | `integer NOT NULL DEFAULT 1` | `>= 1`; how many interchangeable rooms of this type exist. **`1` = the boutique case** (a unique cabin is its own type). |
| `beds` | `integer NOT NULL` | `>= 1`; per room; informational |
| `base_occupancy` | `integer NOT NULL` | `>= 1`; guests included in the nightly rate, per room |
| `max_capacity` | `integer NOT NULL` | `>= base_occupancy`; hard cap on guests **per room** |
| `base_rate` | `integer NOT NULL` | per-night per-room, minor units, `>= 0` |
| `weekend_rate` | `integer` (nullable) | per-night; `NULL` ⇒ use `base_rate` on weekend nights |
| `extra_person_fee` | `integer NOT NULL DEFAULT 0` | per extra person **per night**, minor units, `>= 0` |
| `min_nights` | `integer NOT NULL DEFAULT 1` | `>= 1` |
| `checkin_time` | `text NOT NULL DEFAULT '15:00'` | `HH:MM` |
| `checkout_time` | `text NOT NULL DEFAULT '11:00'` | `HH:MM` |
| `amenities` | `text NOT NULL DEFAULT ''` | CSV of amenity enum keys (§2.6). CSV mirrors `schedules.weekdays`. |
| `commission_type` / `commission_value` | `text` / `integer` (both nullable) | per-type commission override (waterfall, D13); `NULL` ⇒ inherit the service base. Basis points for `percent`, minor units for `fixed`. |
| `status` | `text NOT NULL DEFAULT 'active'` | enum `['active','inactive']` (soft-deactivate, never hard-delete — protects folio history) |
| `created_at` / `updated_at` | `integer` epoch | machine timestamps |

```sql
-- Index survives the rename; recreate only if the name matters:
CREATE INDEX accommodation_unit_types_org_service_idx
  ON accommodation_unit_types (organization_id, service_id, status);
```

### 2.2 `accommodation_seasons` — per-type seasonal rate override

A flat nightly rate that applies to **every** night in `[start_date, end_date]` (it outranks the
weekend rate, D3). Overlapping active seasons for the same type are rejected at write time.

| Column | Type | Notes |
|---|---|---|
| `id` | `text` PK | |
| `organization_id` | `text NOT NULL` → `organizations(id)` | Rule 5 |
| `service_id` | `text NOT NULL` → `services(id)` | denormalized for org-leading queries |
| `unit_type_id` | `text NOT NULL` → `accommodation_unit_types(id)` | parent type (renamed from `unit_id`) |
| `name` | `text NOT NULL` | e.g. `"Semana Santa"` |
| `start_date` / `end_date` | `text NOT NULL` | `YYYY-MM-DD`, `end_date >= start_date` |
| `nightly_rate` | `integer NOT NULL` | minor units, `>= 0`; flat for all nights in range |
| `status` | `text NOT NULL DEFAULT 'active'` | `['active','inactive']` |
| `created_at` / `updated_at` | `integer` epoch | |

### 2.3 `accommodation_blockouts` — type-level **quantity** block-out (D11)

Admin-declared: **`quantity` rooms of this type are out of inventory** for `[start_date, end_date)`
(maintenance, owner use). Participates in the D10 guard as the `blocked(night)` term.
Hard-deletable (no historical value, unlike a sold reservation).

| Column | Type | Notes |
|---|---|---|
| `id` | `text` PK | |
| `organization_id` | `text NOT NULL` → `organizations(id)` | Rule 5 |
| `service_id` | `text NOT NULL` → `services(id)` | denormalized |
| `unit_type_id` | `text NOT NULL` → `accommodation_unit_types(id)` | parent type (renamed) |
| `quantity` | `integer NOT NULL DEFAULT 1` | `1 ≤ quantity ≤ type.inventory_count` at creation; rooms removed from the pool. Overlapping block-outs **sum**. |
| `start_date` / `end_date` | `text NOT NULL` | `YYYY-MM-DD`, `end_date > start_date`. Half-open `[start, end)` to match turnover (D4) |
| `reason` | `text` (nullable) | optional note |
| `created_at` / `updated_at` | `integer` epoch | |

- *Hotel:* "2 standard rooms out for maintenance next week" → one block-out, `quantity = 2`.
- *Boutique (count = 1):* `quantity = 1` closes the whole listing — identical to v1's per-unit
  block-out.

### 2.4 `accommodation_reservations` — **the inventory unit** (analogue of `slots`)

One row per sold stay line: **`quantity` rooms of `unit_type_id` for nights
`[check_in, check_out)`**. This is what every availability check reads and every cancellation
releases — the lodging equivalent of `slots.booked`.

| Column | Type | Notes |
|---|---|---|
| `id` | `text` PK | |
| `organization_id` | `text NOT NULL` → `organizations(id)` | Rule 5 |
| `service_id` | `text NOT NULL` → `services(id)` | denormalized |
| `unit_type_id` | `text NOT NULL` → `accommodation_unit_types(id)` | the reserved type (renamed) |
| `quantity` | `integer NOT NULL DEFAULT 1` | `>= 1`; rooms reserved |
| `folio_id` | `text NOT NULL` → `folios(id)` | the sale this reservation backs |
| `check_in` / `check_out` | `text NOT NULL` | `YYYY-MM-DD`, `check_out > check_in`. Occupies nights `[check_in, check_out)` (D4) |
| `guests` | `integer NOT NULL` | total for the line; `1 ≤ guests ≤ max_capacity × quantity` (snapshot at sale) |
| `status` | `text NOT NULL DEFAULT 'active'` | `['active','cancelled']`. `active` ⇒ holds the rooms (covers both `booking`-status and `paid` folios). Cancel/expiry flips to `cancelled`, freeing the quantity. |
| `created_at` / `updated_at` | `integer` epoch | |

> **Per-night atomic count guard (D10, half-open).** The naive check —
> `inventory_count − SUM(quantity of overlapping reservations) ≥ requested` — is **incorrect**:
> two reservations that each overlap the request but not each other (Mon–Wed + Thu–Sat vs. a
> Mon–Sat request) both count against the same pool → false 409s. The invariant is per-night:
>
> ∀ night ∈ `[check_in, check_out)`:
> `reserved(night) + blocked(night) + requested_quantity ≤ inventory_count`
>
> It stays **atomic**: D1 has no interactive transactions, so the check and the write are one
> conditional `INSERT … WHERE NOT EXISTS`, `meta.changes === 0 ⟺ insufficient → 409
> INSUFFICIENT_INVENTORY` — the lodging analogue of the slot guard
> `UPDATE … WHERE capacity − booked >= n` (US-AG11). Nights expand via a recursive CTE:
>
> ```sql
> INSERT INTO accommodation_reservations
>   (id, organization_id, service_id, unit_type_id, folio_id,
>    check_in, check_out, guests, quantity, status)
> SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active'
> WHERE NOT EXISTS (
>   WITH RECURSIVE nights(d) AS (
>     SELECT :check_in
>     UNION ALL
>     SELECT date(d, '+1 day') FROM nights WHERE date(d, '+1 day') < :check_out
>   )
>   SELECT 1 FROM nights n
>   WHERE COALESCE((SELECT SUM(r.quantity) FROM accommodation_reservations r
>                   WHERE r.unit_type_id = :type AND r.status = 'active'
>                     AND r.check_in <= n.d AND n.d < r.check_out), 0)
>       + COALESCE((SELECT SUM(b.quantity) FROM accommodation_blockouts b
>                   WHERE b.unit_type_id = :type
>                     AND b.start_date <= n.d AND n.d < b.end_date), 0)
>       + :requested_quantity
>       > (SELECT t.inventory_count FROM accommodation_unit_types t WHERE t.id = :type)
> )
> ```
>
> The same guard runs on **reactivation** (US-AG07.5 re-claim) — it converts alongside
> `confirmSale`, never after.

### 2.5 `organizations` — lodging settings (migration `0039`, unchanged)

| Column | Type | Notes |
|---|---|---|
| `lodging_weekend_days` | `text NOT NULL DEFAULT '5,6'` | CSV of ISO weekday ints (`0`=Sun … `6`=Sat); default Fri+Sat. Defines which nights use `weekend_rate`. |
| `lodging_free_cancel_days` | `integer NOT NULL DEFAULT 0` | A **paid** stay may be cancelled free until this many days before `check_in`; `0` = no free window. |
| `lodging_cancel_penalty_pct` | `integer NOT NULL DEFAULT 0` | Penalty (% of stay total) retained when a paid stay is cancelled **inside** the free window cut-off. `0–100`. |

> Org-scoped, mirroring `ack_window_hours` / booking policy. Per-service overrides are a later
> cascade. The structured policy governs **paid** stays only; `booking`-status deposits stay
> non-refundable (D9, US-AG07.4).

### 2.6 Amenity tags — closed enum (frontend label map, unchanged)

Stable lowercase keys stored (CSV in `unit_types.amenities`), Spanish labels live once on the
frontend (`features/catalog/lodging.ts`):

| Key | Label (UI) |
|---|---|
| `wifi` | WiFi |
| `parking` | Estacionamiento |
| `kitchen` | Cocina |
| `ac` | Aire acondicionado |
| `heating` | Calefacción |
| `pool` | Alberca |
| `pets` | Mascotas permitidas |
| `breakfast` | Desayuno incluido |

---

## 3. The pricing & availability engine (one shared helper)

Defined once in `api-guideme/src/utils/lodging.ts` and imported by **both** the POS availability
serializers (display) and `confirmSale` (enforcement), so the quote shown can never drift from the
quote charged — the same single-source discipline as `effectiveCapacity()`.

### 3.1 `nightlyRate(date, type, seasons, weekendDays)` — unchanged

```
nightlyRate =
  season.nightly_rate          if date ∈ some active season [start,end]      (highest precedence)
  type.weekend_rate            else if weekday(date) ∈ weekendDays AND weekend_rate != NULL
  type.base_rate               otherwise
```

### 3.2 `quoteStay(type, checkIn, checkOut, guests, quantity, seasons, weekendDays)` — D12

Prices **one room**, then sums over the even guest split:

```
nights          = dateDiff(checkOut, checkIn)
roomGuests[i]   = evenSplit(guests, quantity)          // e.g. 5 guests / 2 rooms → [3, 2]
perRoom[i]      = Σ over each night d ∈ [checkIn, checkOut):
                    nightlyRate(d, …) + max(0, roomGuests[i] − base_occupancy) × extra_person_fee
total           = Σ perRoom[i]
```

Deterministic and exact for the common case (`guests ≤ base_occupancy × quantity` ⇒ the split is
irrelevant). Returns `{ nights, total, perNight[] }` (the per-night breakdown drives the checkout
line detail; for `quantity > 1` the breakdown shows the per-night sum across rooms).

### 3.3 `remaining(type, night)` and range availability — all must hold

```
remaining(night) = inventory_count
                 − Σ quantity of active reservations covering night
                 − Σ quantity of blockouts covering night
```

A type is available for `(checkIn, checkOut, guests, quantity)` iff:

1. **Valid range:** `checkOut > checkIn` and `nights >= type.min_nights` (D4/D5).
2. **Capacity:** `1 <= guests <= type.max_capacity × quantity` (D12).
3. **Inventory:** `remaining(night) >= quantity` for **every** night in `[checkIn, checkOut)` (D10).
4. **Status:** `type.status = 'active'` and the parent service is `active`.

The display-side range value **`min_remaining`** = `min over nights of remaining(night)` powers
both `has_availability` (`min_remaining ≥ 1`) and the *"Quedan N"* low-inventory badge.

---

## 4. API surface

### 4.1 Admin — unit types (admin-only, nested under a `lodging` service)

The `services` router already applies `authMiddleware` + `requireRole('admin')` to `*` and guards
the parent `:id` with `requireService`. Routes renamed `units` → `unit-types` (RFC §3.5); create
and update gain `inventory_count`; block-outs gain `quantity`:

| Method & path | Purpose | US |
|---|---|---|
| `POST   /api/services/:id/unit-types` | Create a unit type (incl. `inventory_count`) | A59 |
| `GET    /api/services/:id/unit-types` | List a service's types (`?status=active\|inactive\|all`) | A59 |
| `PUT    /api/services/:id/unit-types/:typeId` | Edit a type (full replace of editable fields, incl. `inventory_count`, rates, occupancy, min-stay, check-in/out, amenities, commission override) | A59/A60/A61/A62 |
| `POST   /api/services/:id/unit-types/:typeId/deactivate` | Soft-close a type (drops it from POS; keeps reservations) | A59 |
| `POST   /api/services/:id/unit-types/:typeId/reactivate` | Restore a type | A59 |
| `POST   /api/services/:id/unit-types/:typeId/seasons` | Add a seasonal rate (reject overlap → `409 SEASON_OVERLAP`) | A60 |
| `GET    /api/services/:id/unit-types/:typeId/seasons` | List a type's seasons | A60 |
| `PUT    /api/services/:id/unit-types/:typeId/seasons/:seasonId` | Edit a season | A60 |
| `DELETE /api/services/:id/unit-types/:typeId/seasons/:seasonId` | Soft-deactivate a season | A60 |
| `POST   /api/services/:id/unit-types/:typeId/blockouts` | Add a quantity block-out (`quantity ≤ inventory_count`) | A61 |
| `GET    /api/services/:id/unit-types/:typeId/blockouts` | List block-outs (`?from=&to=`) | A61 |
| `DELETE /api/services/:id/unit-types/:typeId/blockouts/:blockoutId` | Remove a block-out (hard delete) | A61 |

`organizationId`/`status` are never read from any body (Rule 1; Zod strips unknowns). Cross-org /
unknown ids → `404 NOT_FOUND`. Amenities validated against the §2.6 enum and stored CSV.
Lowering `inventory_count` below currently-reserved levels is allowed (it affects **future**
availability only; existing reservations stand) — the admin sees a warning client-side.

**Org settings** (unchanged): `GET`/`PUT /api/organizations/...` include `lodging_weekend_days`,
`lodging_free_cancel_days`, `lodging_cancel_penalty_pct`.

> The **Service Creation Wizard** lodging branch (Step-1 *Category* = `Hospedaje`) captures unit
> **types** — name, inventory count, rates, occupancy, amenities, commission override — instead of
> physical units. Same step structure, one added field (`inventory_count`).

### 4.2 POS — availability reads (agent/affiliate, org-scoped)

| Method & path | Purpose | US |
|---|---|---|
| `GET /api/pos/lodging/:serviceId/availability?check_in=&check_out=&guests=&quantity=` | **Range-first** — unit types of the property available for the whole range (per-night math), each with a `quoteStay` breakdown + `min_remaining` | AG36 |
| `GET /api/pos/lodging/unit-types/:typeId/calendar?from=&to=` | **Type-first** — a type's day-by-day **remaining count** (`inventory_count − reserved − blocked`) + its rate per day *(replaces the v1 binary free/blocked/booked calendar)* | AG37 |

`availability` response item:

```json
{
  "unit_type_id": "t_1", "name": "Habitación Estándar", "unit_type": "room",
  "inventory_count": 12, "min_remaining": 2,
  "beds": 2, "base_occupancy": 2, "max_capacity": 4,
  "amenities": ["wifi", "parking"],
  "checkin_time": "15:00", "checkout_time": "11:00",
  "nights": 3, "quantity": 2, "total": 900000,
  "per_night": [
    { "date": "2026-07-10", "rate": 300000 },
    { "date": "2026-07-11", "rate": 300000 },
    { "date": "2026-07-12", "rate": 300000 }
  ]
}
```

A type that fails any §3.3 rule for the requested range/quantity is **omitted** (range-first shows
only bookable types). Invalid range (`check_out <= check_in`) → `400 VALIDATION_ERROR`.

### 4.3 POS — catalog read (flattened, D14 — extends `listPosServices`, US-AG30)

The catalog endpoint returns a **mixed list**; every item carries
**`item_type: 'tour' | 'unit_type'`** and a stable `id`:

- **Tour services** — unchanged (slot-derived `has_availability`, `base_price`, spot fields).
- **`lodging` services** contribute **one card per active unit type** (the parent service is not
  a card). Each card exposes:
  - `id` = the unit type's id (frontend keys, folio deep-links, category filtering all hang on it);
  - `name` (+ the parent property name for context, e.g. `"Habitación Estándar · Hotel Centro"`);
  - `nightly_rate` = the type's own `base_rate` (an **exact** per-night price — the v1 aggregated
    *"Desde $X"* label is gone with the flattening);
  - `max_capacity` = the per-room guest cap (D12) — lets the stay sheet cap its guests stepper
    (`max_capacity × rooms`) before any quote, so an over-capacity request is never formed;
  - `has_availability` = `min_remaining ≥ 1` over the selected date range (§3.3), and
  - `remaining` = `min_remaining` (drives the *"Quedan N"* badge when low).
- `GET /api/pos/availability/days` — lodging days get **real availability dots**: a day lights up
  when any in-scope unit type has `remaining(night) ≥ 1`. This retires the frontend's
  `lodgingInScope` exception in `PosDatePickerSheet` (v1 made lodging days unconditionally
  pickable because per-unit availability was too expensive to aggregate; counts make it cheap).

A lodging `service` row still carries the catalog columns (`base_price`, `minimum_price`,
`default_capacity`); they are **not** authoritative for lodging (type rates govern) and may be
`0`. Slots/schedules are never created for a lodging service.

### 4.4 POS — sale (extends `confirmSale`)

A cart **stay line** carries `{ service_id, unit_type_id, check_in, check_out, guests, quantity }`
(v1's `unit_id` is gone; `quantity ≥ 1` required). On confirm, for each stay line:

1. Re-`quoteStay` server-side with the D12 semantics (never trust a client price) and **snapshot**
   the total + per-night breakdown + type name onto the folio line (`folio_lines.quantity` = rooms;
   folio history must not dereference live config — same snapshot guarantee as tours).
2. Atomically insert the `accommodation_reservations` row under the §2.4 per-night count guard.
   0 rows affected → **`409 INSUFFICIENT_INVENTORY`**; the whole sale rolls back via the
   compensate-on-failure flow (mirrors the slot capacity guard / US-AG11).
3. Commission resolves by the D13 waterfall and is snapshotted (`fixed` × `quantity`).

A folio may mix tour lines and stay lines. **Deposit/apartado (D7):** the deposit, hold window,
`Liquidar saldo`, `Cancelar` (US-AG07.4), `Reactivar` (US-AG07.5), and auto-expiry sweep operate
on the folio exactly as today; the reservation follows — created `active` at booking, set
`cancelled` on cancel/expiry (releasing the quantity), re-claimed on reactivate under the **same
per-night guard** (`409 INSUFFICIENT_INVENTORY` if the inventory was taken in the meantime).

### 4.5 Cancellation & refund (D9 — extends US-A21, unchanged)

- **`booking`-status stay** cancelled (agent US-AG07.4 or admin): reservation → `cancelled`;
  deposit **non-refundable, retained in the agent's drawer** (unchanged apartado rule).
- **`paid` stay** cancelled (admin US-A21): reservation → `cancelled`; the **refund due** is
  computed by the structured policy —
  ```
  daysBefore = dateDiff(check_in, today)
  refund = (daysBefore >= org.lodging_free_cancel_days)
             ? stay_total                                     // free window: full refund
             : stay_total × (100 − org.lodging_cancel_penalty_pct) / 100
  ```
  surfaced on the cancellation flow and tracked by the existing refund-tracking fields (US-A23).
  Commission clawback (US-A26) applies as for any folio.

### 4.6 Error codes

| Status | Code | Condition |
|---|---|---|
| 409 | `INSUFFICIENT_INVENTORY` | Per-night remaining < requested quantity at confirm/reactivate *(replaces v1 `UNIT_UNAVAILABLE`; remove the old code from `ErrorCode` once no route emits it)* |
| 409 | `SEASON_OVERLAP` | A seasonal rate overlaps an existing active season for the type |
| 400 | `MIN_STAY_NOT_MET` | `nights < type.min_nights` |

Existing `VALIDATION_ERROR` / `NOT_FOUND` / `FORBIDDEN` cover the rest.

---

## 5. Frontend

### 5.1 Admin (catalog)

- **Lodging service detail** — the Units section becomes a **Unit Types** section: a type list
  with add/edit/deactivate; each type form captures name, type label, **inventory count**, beds,
  base occupancy, max capacity, base rate, weekend rate, extra-person fee, min nights,
  check-in/out times, an **amenity multi-select** (§2.6 chips), and the Heredar/%/$ commission
  control. Money inputs use the minor-units helper; `max_capacity >= base_occupancy`,
  `min_nights >= 1`, `inventory_count >= 1` validated client-side via the shared Zod.
- **Per-type Seasons** sub-editor (name + date range + nightly rate; overlap rejected) and
  **Block-outs** sub-editor (date range + **quantity stepper** capped at `inventory_count` +
  optional reason) on the type.
- **Settings (Configuración)**: weekend-days selector + free-cancel-days + penalty-% fields,
  alongside the booking policy (unchanged).

### 5.2 Agent / affiliate (POS)

- **Flattened catalog (`PosCatalogPage`, D14):** cards render both `item_type`s. A unit-type card
  shows the type name (+ property), its **exact nightly rate**, a type-specific photo (when media
  ships), and a low-inventory badge — **"Quedan N"** — when `remaining` is low. Category filtering
  and the calendar dots treat unit-type cards as first-class `lodging` items.
- **`LodgingStaySheet`:** the physical-unit list is **removed**. The sheet captures **dates
  (range), guests, and a room-quantity stepper** (D12); it quotes live via §4.2 and surfaces
  `INSUFFICIENT_INVENTORY` as an inline error with the available count. Adding puts one stay line
  (`quantity` rooms) in the cart.
- **Type-first (AG37):** opening a type card shows its month **remaining-count calendar**
  (`remaining` per day at that day's rate); the agent selects the range on it.
- **`PosDatePickerSheet`:** delete the `lodgingInScope` special case — availability dots are
  uniform across categories now that lodging days light up from real counts (§4.3).
- **Checkout (AG38):** the stay line shows `type × quantity` · `Sáb 10 → Mar 13 · 3 noches` ·
  guests · total (per-night breakdown expandable). The **adaptive amount-driven checkout**
  (US-AG07.2) drives full-pay vs deposit; phone required for a booking.
- Affiliates reach all of the above through the same POS, restricted to their allow-listed
  services — the allow-list stays **service-level** (enabling a property enables its types).
- Commission (US-A12, D13): **type override ?? service base**, affiliate rate wins; `percent` on
  the stay amount; **`fixed` × quantity** (per room-stay). Lodging stays **exempt from the fixed ≤
  `minimum_price` cap** (no per-ticket floor — types price per night).

---

## 6. Scenarios

### US-A59 — Unit types (inventory)

1. **Create type** — admin `POST /api/services/:id/unit-types` (service is `lodging`) with name,
   `inventory_count:12`, beds, `base_occupancy:2`, `max_capacity:4`, `base_rate:150000` → `201`;
   row in caller's org, `active`.
2. **`max_capacity < base_occupancy` → `400`**; `inventory_count < 1` → `400`; no row written.
3. **Types only on a lodging service** — creating a type under a `tours` service → `400`.
4. **Deactivate/reactivate** are idempotent; reservations are untouched; a deactivated type's
   card disappears from the flattened catalog.

### US-A60 — Rate rules

5. **Seasonal rate persists & round-trips**; overlapping active season for the same type →
   `409 SEASON_OVERLAP`.
6. **Quote precedence** — a type `base_rate:100000`, `weekend_rate:140000`, a season
   `2026-12-20…2026-12-31 @ 200000`; a 3-night stay `2026-12-19→2026-12-22` with `weekendDays=Fri,Sat`
   quotes night-19 (Sat, weekend) `140000` + night-20 (season) `200000` + night-21 (season)
   `200000` = `540000`. *(Season outranks weekend; weekend outranks base.)*
7. **Extra-person with even split (D12)** — `base_occupancy:2`, `extra_person_fee:30000`,
   `quantity:2`, 5 guests, 3 nights → split `[3,2]`; room 1 adds `1 × 30000 × 3 = 90000`,
   room 2 adds `0`; total = 2 × room rate × 3 nights + `90000`.

### US-A61 — Availability controls

8. **Quantity block-out** — a type `inventory_count:3` with a block-out `quantity:2` over
   `2026-07-10…2026-07-12`: a 1-room stay touching those nights **succeeds**; a 2-room stay →
   `409 INSUFFICIENT_INVENTORY`. Overlapping block-outs **sum** (a second `quantity:1` block-out
   closes the type).
9. **Min-stay** — `min_nights:2`; a 1-night stay → `400 MIN_STAY_NOT_MET` (and the type is hidden
   for that range in the range-first list).
10. **Turnover** — type fully booked `…→2026-07-12`; a new stay `2026-07-12→2026-07-14` is
    **available** (check-out day reused, half-open intervals).

### US-A62 — Amenities

11. Amenities persist as CSV of valid enum keys; an unknown key → `400`; the POS availability item
    echoes the array.

### US-A63 — Cancellation policy (paid stay)

12. Org `free_cancel_days:7`, `cancel_penalty_pct:50`; a `paid` stay `total:450000`, `check_in` 10
    days out, cancelled → **full refund** (`450000`). Cancelled 3 days out → **refund `225000`**
    (50% penalty retained). A `booking`-status stay cancelled → deposit non-refundable (US-AG07.4).

### US-AG36 / AG37 / AG38 — Selling a stay

13. **Range-first** — `GET /api/pos/lodging/:id/availability?check_in=…&check_out=…&guests=5&quantity=2`
    returns only types with per-night `remaining ≥ 2` for the whole range, with correct
    `nights`/`total`/`min_remaining`.
14. **Guard correctness (the false-409 shape)** — `inventory_count:2`; existing 1-room
    reservations Mon–Wed **and** Thu–Sat; a new 1-room Mon–Sat request **succeeds** (per-night
    occupancy never exceeds 2). *(The naive overlapping-SUM would wrongly reject it.)*
15. **Last-room race** — two agents concurrently confirm the final remaining room for overlapping
    ranges; exactly one `201`, the other `409 INSUFFICIENT_INVENTORY` (conditional insert); no
    overbooking.
16. **Deposit path** — a stay confirmed with a deposit creates a `booking` folio + an `active`
    reservation holding the quantity; `Liquidar saldo` flips to `paid` (reservation unchanged);
    auto-expiry/cancel sets the reservation `cancelled` and frees the quantity; reactivate
    re-claims under the same guard.
17. **Mixed cart** — a folio with one tour line and one stay line confirms, decrementing the slot
    and inserting the reservation atomically; failure of either rolls back both.
18. **Flattened catalog** — a `lodging` service with 2 active types yields 2 `unit_type` cards
    (no parent card) with stable ids; a tour service yields its usual `tour` card; the availability
    dots include lodging days with free inventory.

### Multitenancy isolation (required — B1/B3/B4, via `seedTwoOrgs`)

19. **B4** — type/season/blockout/availability/calendar lists are org-scoped; no `org_b` row ever
    appears (including the flattened catalog cards).
20. **B3** — cross-org type/season/blockout get/edit/deactivate, foreign
    `GET /api/pos/lodging/:id/availability`, and a foreign `unit_type_id` in a stay line → `404`;
    nothing revealed.
21. **B1** — injected `organizationId`/`status` in any body is stripped; the row stays in `org_a`,
    `status='active'`.

---

## 7. Definition of Done (v2 refactor)

- [x] Migration `0042_unit_type_inventory.sql`: test-data wipe + renames + `inventory_count` /
      `quantity` columns (§2.0 steps; **rename, don't drop** — the 0040 D1-remote FK lesson).
- [x] Drizzle schema + inferred types updated (`accommodationUnitTypes`, `unitTypeId`, `quantity`,
      `inventoryCount`); no binding changes (no cf-typegen needed).
- [x] `src/utils/lodging.ts`: `nightlyRate` (unchanged), `quoteStay` with `quantity`/even-split
      (D12), `remainingOnNight`/`minRemaining`/`checkTypeAvailable` (§3.3) — shared by the POS
      serializers and `confirmSale` (single source of pricing/availability).
- [x] Admin nested routers renamed to `/unit-types`; Zod requires `inventory_count >= 1`, blockout
      `quantity` (`1 ≤ q ≤ inventory_count`, upper bound in the handler), and keeps the §2
      validations (amenities enum, `max_capacity >= base_occupancy`, `min_nights >= 1`, season
      overlap).
- [x] `listPosServices` **flattened** (D14): `item_type` discriminator, one card per active unit
      type with `nightly_rate` / `has_availability` (per-night math over the selected range) /
      `remaining`; `GET /api/pos/availability/days` includes lodging days from real counts.
- [x] `GET /api/pos/lodging/:id/availability` takes `quantity` and filters by per-night remaining;
      the type calendar (`GET /api/pos/lodging/unit-types/:typeId/calendar`) returns **remaining
      per day**.
- [x] `confirmSale` stay lines accept `{ unit_type_id, quantity, check_in, check_out, guests }`,
      re-quote + snapshot (D12/D13), and insert under the **per-night count guard** (§2.4,
      recursive-CTE conditional INSERT) → `409 INSUFFICIENT_INVENTORY`; whole-sale rollback on any
      failure; reactivation re-claims under the same guard (self-excluding).
- [x] `'INSUFFICIENT_INVENTORY'` added to `ErrorCode`; `'UNIT_UNAVAILABLE'` removed (no route
      emits it); `docs/TECH_DEBT.md` §18 updated.
- [x] Frontend: flattened `PosCatalogPage` cards (`item_type`, exact "Por noche" rate, "Quedan N"
      badge), `LodgingStaySheet` rewritten type-centric — remaining-count calendar + guests +
      room-quantity steppers (physical-unit list removed; `UnitCalendarSheet` absorbed/deleted),
      **`lodgingInScope` hack deleted** from `PosDatePickerSheet`; cart/checkout/folio lines carry
      `unit_type_id` + rooms; admin Unit-Types editors (+ `inventory_count`, blockout quantity)
      and the wizard lodging branch updated.
- [x] Scenarios in `test/lodging/accommodation-stays.test.ts` rewritten for types (47 tests) —
      **including the false-409 shape, the last-room oversell, blockout quantity sums, D12
      multi-room pricing, D13 fixed × quantity, and B1/B3/B4 via `seedTwoOrgs`**. The rest of the
      POS suite needed no changes (tour paths untouched).
- [x] `pnpm --filter api-guideme test` green (461 tests / 37 files); API `vite build` clean;
      frontend `tsc -b` + eslint (0 errors) + `vite build` clean after the UI refactor.
- [x] `docs/SPEC.md` updated (US-A59–A63, US-AG36–AG38, Inventory/Pricing invariants, roadmap).

> v1 history: the named-units model (migrations `0035`–`0041`, incl. the per-unit commission
> waterfall of `0041`) shipped and is superseded by this revision. The waterfall itself carries
> over 1:1 at the type level (the columns travel with the rename).

---

## 8. Open decisions (defaults chosen — confirm or override)

1. **`unit_type` free label vs closed enum** — *default:* free text (operators name their own
   types). *Alt:* a closed enum like categories (enables type filtering, loses flexibility).
2. **Check-in/out scope** — *default:* per-type (D2 independence). *Alt:* per-service (one
   property time) with per-type override — promote later if every type shares times.
3. **"Quedan N" badge threshold** — *default:* show when `remaining ≤ 2`. *Alt:* org-configurable.
4. **Catalog `base_price` for lodging** — *default:* store `0`; the type card surfaces its own
   `nightly_rate`. *Alt:* keep `base_price` synced to the min type rate.
5. **Lowering `inventory_count` below current occupancy** — *default:* allow with a client-side
   warning (affects future availability only). *Alt:* reject while conflicting reservations exist.
6. **Seasonal min-stay & season-varying extra-person fee** — deferred (D3/D5); revisit if demand.
