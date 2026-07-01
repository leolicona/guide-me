# Feature: Accommodation Stays (Lodging — Named Units, Nightly Pricing, Date-Range Booking)

**Category:** `lodging` (the `Hospedaje` chip from US-A37 — `docs/catalog/service-categories.spec.md`).
**Stories:** **US-A59 … US-A63** (admin configuration), **US-AG36 … US-AG38** (agent/affiliate selling).
**Status:** Specification. SHOULD HAVE (first category-specific service type).
**Owner modules:** `api-guideme/src/routes/services/` (admin config), `api-guideme/src/routes/pos/`
(availability + sale), `app-guideme/src/features/catalog/` + `app-guideme/src/features/pos/`.

---

## 1. Context

Every service today is a **per-slot, single-occurrence** product: an instance at one
`(date, start_time)` with a `capacity`/`booked` counter, sold by decrementing N *spots* for
that one occurrence (`docs/schedules/schedules-slots.spec.md`, `docs/catalog/service-catalog.spec.md`).
A POS sale is one slot, one day.

**Accommodation breaks that model.** A tourist stays **more than one day**, so the product is
fundamentally different and needs its own inventory primitive **beside** `slots` (never a tweak
to it):

| Tours / activities (today) | Accommodation (this feature) |
|---|---|
| One `(date, start_time)` occurrence | A **date range** [check-in … check-out) = N nights |
| Sell *spots* against a per-day counter | Occupy a **named unit** for the whole range |
| Flat `base_price` per ticket | **nights × nightly rate (+ extra-person)**, rate may vary by weekend/season |
| Available = `remaining ≥ qty` on one day | Available = **no overlapping reservation on any night** ∧ not blocked-out ∧ meets min-stay |

This is the **first category-specific service type**. It establishes the pattern (a category that
carries its own child inventory + its own availability/pricing engine) without disturbing the
existing tour flow — a `lodging` service simply does not use slots/schedules.

### Confirmed decisions (this spec)

| # | Topic | Decision |
|---|---|---|
| D1 | **Inventory model** | **Named individual units.** A `lodging` service is the property/listing; it owns named units (`accommodation_units`), each independently bookable. *(Not a pooled count, not "each unit a service".)* |
| D2 | **Where config lives** | **Per unit.** Each unit carries its own rate rules, occupancy, beds, amenities, min-stay, check-in/out, block-outs, and seasonal overrides — a suite ≠ a cabin. |
| D3 | **Pricing** | Per night: **seasonal override > weekend rate > base rate**, plus a flat per-extra-person-per-night surcharge above a base occupancy, capped at a hard max capacity. Weekend days are org-configurable (default Fri+Sat). Extra-person fee does **not** vary by season in v1. |
| D4 | **Turnover** | **Standard hotel.** A stay occupies nights `[check_in … check_out)`; the check-out day is free for a same-day arrival. Min-stay counts **nights** = `check_out − check_in`. |
| D5 | **Min-stay** | A single `min_nights` **per unit**. Seasonal min-stay is deferred. |
| D6 | **v1 admin scope** | Block-out calendar, minimum stay, check-in/out times, and amenity tags **all ship in v1** (plus inventory + nightly rates + extra-person). |
| D7 | **Sale path** | Reuse the existing **cart → folio** flow; a stay is one folio line spanning the range. **Deposit/apartado is supported in v1** (`docs/bookings/bookings-down-payments.spec.md`). |
| D8 | **Agent entry points** | **Both** range-first (pick dates → see available units) **and** unit-first (pick a unit → pick dates on its calendar). |
| D9 | **Cancellation** | **Split by folio status.** A `booking`-status stay cancelled keeps the existing **non-refundable-deposit** rule (US-AG07.4). A fully-`paid` stay cancelled uses a new **structured free-window + penalty %** to compute the refund. |

### Out of scope (own features / later)

- **Per-night manual discount** on a stay (the US-AG06 minimum-price floor is per-ticket, not
  per-night). v1 sells stays at the computed total; discounting stays is deferred.
- **Seasonal minimum-stay** and **season-varying extra-person fee** (D3/D5).
- **Pooled / interchangeable units** and a shared unit-type rate table (D1 picked named units).
- **Tourist self-service** booking (the Phase-2 B2C portal); v1 is agent/affiliate-sold only.
- **Multi-timezone** — naive org-local `YYYY-MM-DD` dates, same as slots.

### Builds on

- `docs/catalog/service-categories.spec.md` — the `lodging` category key that flags a service as
  accommodation and routes it through this engine.
- `docs/catalog/service-catalog.spec.md` — the parent `services` table, the admin-only
  `services` router, and the `requireService` org-scoped parent guard (units/seasons/blockouts
  nest under a service exactly like extras and slots).
- `docs/bookings/bookings-down-payments.spec.md` — the apartado lifecycle (deposit hold, one-shot
  settle, manual cancel US-AG07.4, auto-expiry sweep, reactivate US-AG07.5) the stay reuses.
- `docs/cancellation/total-folio-cancellation.spec.md` — US-A21 folio cancellation, extended to
  release reservations and apply the structured refund for paid stays (D9).
- `docs/multitenancy/multitenancy.spec.md` — every new table is tenant-scoped (Rules 1–6);
  cross-org ids resolve `404`.

---

## 2. Data Model

All money is **integer minor units** (centavos), single currency (MXN), per the catalog rule.
All dates are **TEXT `YYYY-MM-DD`** (org-local), all times **TEXT `HH:MM`** (24h) — same
representation and rationale as `slots`. Every new table carries `organization_id` **directly**
(Rule 5) with an org-leading index (Rule 6), even where it could scope transitively, for defense
in depth (Rules 2 & 4) — the same decision `service_extras`/`slots` made.

> Migrations (one table per file, continuing the `0035+` sequence — latest in tree is `0034`):
> `0035_create_accommodation_units.sql`, `0036_create_accommodation_seasons.sql`,
> `0037_create_accommodation_blockouts.sql`, `0038_create_accommodation_reservations.sql`,
> `0039_add_lodging_settings_to_organizations.sql`.

### 2.1 `accommodation_units` (new) — a named, bookable unit

| Column | Type | Notes |
|---|---|---|
| `id` | `text` PK | `crypto.randomUUID()` |
| `organization_id` | `text NOT NULL` → `organizations(id)` | Rule 5 |
| `service_id` | `text NOT NULL` → `services(id)` | parent `lodging` service |
| `name` | `text NOT NULL` | non-empty, e.g. `"Cabaña 1"` |
| `unit_type` | `text` (nullable) | free label, e.g. `cabin` / `suite` (admin-defined; not a closed enum in v1) |
| `beds` | `integer NOT NULL` | `>= 1`; informational |
| `base_occupancy` | `integer NOT NULL` | `>= 1`; guests included in the nightly rate |
| `max_capacity` | `integer NOT NULL` | `>= base_occupancy`; hard cap on guests |
| `base_rate` | `integer NOT NULL` | per-night, minor units, `>= 0` |
| `weekend_rate` | `integer` (nullable) | per-night, minor units; `NULL` ⇒ use `base_rate` on weekend nights |
| `extra_person_fee` | `integer NOT NULL DEFAULT 0` | per extra person **per night**, minor units, `>= 0` |
| `min_nights` | `integer NOT NULL DEFAULT 1` | `>= 1` |
| `checkin_time` | `text NOT NULL DEFAULT '15:00'` | `HH:MM` |
| `checkout_time` | `text NOT NULL DEFAULT '11:00'` | `HH:MM` |
| `amenities` | `text NOT NULL DEFAULT ''` | CSV of amenity enum keys (see §2.6), e.g. `"wifi,parking,kitchen"`. CSV mirrors `schedules.weekdays`. |
| `status` | `text NOT NULL DEFAULT 'active'` | enum `['active','inactive']` (soft-deactivate, never hard-delete — protects folio history) |
| `created_at` / `updated_at` | `integer` epoch | machine timestamps |

```sql
CREATE INDEX accommodation_units_org_service_idx
  ON accommodation_units (organization_id, service_id, status);
```

### 2.2 `accommodation_seasons` (new) — per-unit seasonal rate override

A flat nightly rate that applies to **every** night in `[start_date, end_date]` (it outranks the
weekend rate, D3). Overlapping active seasons for the same unit are rejected at write time.

| Column | Type | Notes |
|---|---|---|
| `id` | `text` PK | |
| `organization_id` | `text NOT NULL` → `organizations(id)` | Rule 5 |
| `service_id` | `text NOT NULL` → `services(id)` | denormalized for org-leading queries |
| `unit_id` | `text NOT NULL` → `accommodation_units(id)` | parent unit |
| `name` | `text NOT NULL` | e.g. `"Semana Santa"` |
| `start_date` / `end_date` | `text NOT NULL` | `YYYY-MM-DD`, `end_date >= start_date` |
| `nightly_rate` | `integer NOT NULL` | minor units, `>= 0`; flat for all nights in range |
| `status` | `text NOT NULL DEFAULT 'active'` | `['active','inactive']` |
| `created_at` / `updated_at` | `integer` epoch | |

```sql
CREATE INDEX accommodation_seasons_org_unit_idx
  ON accommodation_seasons (organization_id, unit_id, start_date);
```

### 2.3 `accommodation_blockouts` (new) — per-unit unavailable range

Admin-declared dates a unit cannot be sold (maintenance, owner use). Hard-deletable (no
historical value, unlike a sold reservation).

| Column | Type | Notes |
|---|---|---|
| `id` | `text` PK | |
| `organization_id` | `text NOT NULL` → `organizations(id)` | Rule 5 |
| `service_id` | `text NOT NULL` → `services(id)` | denormalized |
| `unit_id` | `text NOT NULL` → `accommodation_units(id)` | parent unit |
| `start_date` / `end_date` | `text NOT NULL` | `YYYY-MM-DD`, `end_date >= start_date`. Half-open `[start, end)` to match turnover (D4) |
| `reason` | `text` (nullable) | optional note |
| `created_at` / `updated_at` | `integer` epoch | |

```sql
CREATE INDEX accommodation_blockouts_org_unit_idx
  ON accommodation_blockouts (organization_id, unit_id, start_date);
```

### 2.4 `accommodation_reservations` (new) — **the inventory unit** (analogue of `slots`)

One row per sold stay line. This is what every availability check reads and every cancellation
releases — the lodging equivalent of `slots.booked`.

| Column | Type | Notes |
|---|---|---|
| `id` | `text` PK | |
| `organization_id` | `text NOT NULL` → `organizations(id)` | Rule 5 |
| `service_id` | `text NOT NULL` → `services(id)` | denormalized |
| `unit_id` | `text NOT NULL` → `accommodation_units(id)` | the occupied unit |
| `folio_id` | `text NOT NULL` → `folios(id)` | the sale this reservation backs |
| `check_in` / `check_out` | `text NOT NULL` | `YYYY-MM-DD`, `check_out > check_in`. Occupies nights `[check_in, check_out)` (D4) |
| `guests` | `integer NOT NULL` | `>= 1`, `<= unit.max_capacity` (snapshot at sale) |
| `status` | `text NOT NULL DEFAULT 'active'` | `['active','cancelled']`. `active` ⇒ holds the dates (covers both `booking`-status and `paid` folios; the folio carries the deposit/paid distinction). Cancel/expiry flips to `cancelled`, freeing the dates. |
| `created_at` / `updated_at` | `integer` epoch | |

```sql
CREATE INDEX accommodation_reservations_org_unit_dates_idx
  ON accommodation_reservations (organization_id, unit_id, check_in, check_out);
```

> **Overlap rule (D4, half-open).** Two `active` reservations for the same `unit_id` conflict iff
> `existing.check_in < new.check_out AND new.check_in < existing.check_out`. The check-out day is
> therefore reusable by a same-day arrival. The **atomic guard** is a conditional insert
> (`INSERT … SELECT … WHERE NOT EXISTS (<overlapping active reservation>)`), the lodging analogue
> of the slot guard `UPDATE … WHERE capacity − booked >= n` (US-AG11): the insert affects 0 rows
> when the unit is taken, and the handler maps that to `409 UNIT_UNAVAILABLE`.

### 2.5 `organizations` — lodging settings (migration `0039`)

| Column | Type | Notes |
|---|---|---|
| `lodging_weekend_days` | `text NOT NULL DEFAULT '5,6'` | CSV of ISO weekday ints (`0`=Sun … `6`=Sat); default Fri+Sat. Defines which nights use `weekend_rate`. |
| `lodging_free_cancel_days` | `integer NOT NULL DEFAULT 0` | A **paid** stay may be cancelled free until this many days before `check_in`; `0` = no free window. |
| `lodging_cancel_penalty_pct` | `integer NOT NULL DEFAULT 0` | Penalty (% of stay total) retained when a paid stay is cancelled **inside** the free window cut-off. `0–100`. |

> Org-scoped, mirroring `ack_window_hours` / booking policy. Per-service cancellation overrides are
> a later cascade (shaped `Service-override ?? Org-global`, like the booking-policy resolver) — not
> built here. The structured policy governs **paid** stays only; `booking`-status deposits stay
> non-refundable (D9, US-AG07.4).

### 2.6 Amenity tags — closed enum (frontend label map)

Mirrors the category pattern: stable lowercase keys stored (CSV in `units.amenities`), Spanish
labels live once on the frontend (`features/catalog/lodging.ts`). v1 closed set:

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

Define once in `api-guideme/src/utils/lodging.ts` and import from **both** the POS availability
serializer (display) and `confirmSale` (enforcement), so the quote shown can never drift from the
quote charged — the same single-source discipline as `effectiveCapacity()`.

### 3.1 `nightlyRate(date, unit, seasons, weekendDays)`

```
nightlyRate =
  season.nightly_rate          if date ∈ some active season [start,end]      (highest precedence)
  unit.weekend_rate            else if weekday(date) ∈ weekendDays AND weekend_rate != NULL
  unit.base_rate               otherwise
```

### 3.2 `quoteStay(unit, checkIn, checkOut, guests, seasons, weekendDays)`

```
nights        = dateDiff(checkOut, checkIn)                 // = number of nights occupied
extraGuests   = max(0, guests − unit.base_occupancy)
extraPerNight = extraGuests × unit.extra_person_fee
total         = Σ over each night d ∈ [checkIn, checkOut):  nightlyRate(d, …) + extraPerNight
```

Returns `{ nights, total, perNight[] }` (the per-night breakdown drives the checkout line detail).

### 3.3 `isUnitAvailable(unit, checkIn, checkOut, guests)` — all must hold

1. **Valid range:** `checkOut > checkIn` and `nights >= unit.min_nights` (D4/D5).
2. **Capacity:** `1 <= guests <= unit.max_capacity` (D3).
3. **No block-out overlap:** no `accommodation_blockouts` row for the unit overlaps `[checkIn, checkOut)`.
4. **No reservation overlap:** no `active` `accommodation_reservations` row for the unit overlaps
   `[checkIn, checkOut)` (§2.4 rule).
5. **Status:** `unit.status = 'active'` and the parent service is `active`.

---

## 4. API surface

### 4.1 Admin — units (admin-only, nested under a `lodging` service)

The `services` router already applies `authMiddleware` + `requireRole('admin')` to `*` and guards
the parent `:id` with `requireService`. New nested resources mirror slots/extras:

| Method & path | Purpose | US |
|---|---|---|
| `POST   /api/services/:id/units` | Create a named unit | A59 |
| `GET    /api/services/:id/units` | List a service's units (`?status=active\|inactive\|all`) | A59 |
| `PUT    /api/services/:id/units/:unitId` | Edit a unit (full replace of editable fields, incl. rates, occupancy, min-stay, check-in/out, amenities) | A60/A61/A62 |
| `POST   /api/services/:id/units/:unitId/deactivate` | Soft-close a unit (drops it from POS; keeps reservations) | A59 |
| `POST   /api/services/:id/units/:unitId/reactivate` | Restore a unit | A59 |
| `POST   /api/services/:id/units/:unitId/seasons` | Add a seasonal rate (reject overlap → `409 SEASON_OVERLAP`) | A60 |
| `GET    /api/services/:id/units/:unitId/seasons` | List a unit's seasons | A60 |
| `PUT    /api/services/:id/units/:unitId/seasons/:seasonId` | Edit a season | A60 |
| `DELETE /api/services/:id/units/:unitId/seasons/:seasonId` | Soft-deactivate a season | A60 |
| `POST   /api/services/:id/units/:unitId/blockouts` | Add a block-out range | A61 |
| `GET    /api/services/:id/units/:unitId/blockouts` | List block-outs (`?from=&to=`) | A61 |
| `DELETE /api/services/:id/units/:unitId/blockouts/:blockoutId` | Remove a block-out (hard delete) | A61 |

`organizationId`/`status` are never read from any body (Rule 1; Zod strips unknowns). Cross-org /
unknown ids → `404 NOT_FOUND` (never reveals foreign existence). Amenities are validated as an
array of the §2.6 enum keys and stored CSV.

**Org settings** (extends the existing `organizations` route, admin-only): `GET`/`PUT` include
`lodging_weekend_days`, `lodging_free_cancel_days`, `lodging_cancel_penalty_pct` alongside
`ack_window_hours` / booking policy.

> The **Service Creation Wizard** (US-A38–A44) gains a lodging branch when Step-1 *Category* =
> `Hospedaje`: Steps 2–4 (per-slot pricing / availability / extras) are replaced by a **units**
> step (add named units with rate, occupancy, min-stay, check-in/out, amenities). Detailed wizard
> wiring is a follow-up; the underlying unit/season/blockout endpoints above are the contract.

### 4.2 POS — availability reads (agent/affiliate, org-scoped)

| Method & path | Purpose | US |
|---|---|---|
| `GET /api/pos/lodging/:serviceId/availability?check_in=&check_out=&guests=` | **Range-first** — units of the service available for the whole range, each with a `quoteStay` breakdown | AG36 |
| `GET /api/pos/lodging/units/:unitId/calendar?from=&to=` | **Unit-first** — a unit's day-by-day status (`available` / `blocked` / `booked`) + its rate per day | AG37 |

`availability` response item:

```json
{
  "unit_id": "u_1", "name": "Cabaña 1", "unit_type": "cabin",
  "beds": 2, "base_occupancy": 2, "max_capacity": 4,
  "amenities": ["wifi", "parking"],
  "checkin_time": "15:00", "checkout_time": "11:00",
  "nights": 3, "total": 450000,
  "per_night": [
    { "date": "2026-07-10", "rate": 150000 },
    { "date": "2026-07-11", "rate": 150000 },
    { "date": "2026-07-12", "rate": 150000 }
  ]
}
```

A unit that fails any `isUnitAvailable` rule for the requested range is **omitted** (range-first
shows only bookable units). Invalid range (`check_out <= check_in`) → `400 VALIDATION_ERROR`.

### 4.3 POS — catalog read branch (extends `listPosServices`, US-AG30)

The catalog endpoint computes `has_availability` from `slots` for tour services. For a
`category = 'lodging'` service it instead branches:

- `has_availability` = the property has **at least one active unit with at least one free night**
  in the default rolling window (`today … today+2`), or in the selected date when one is picked.
- It exposes `from_nightly_rate` = the **min `base_rate`** across active units (drives the
  *"Desde $X / noche"* card label), in place of the per-ticket `base_price`.
- No slot/spot fields are emitted for a lodging service (it has none).

A lodging `service` row still carries the catalog columns (`base_price`, `minimum_price`,
`default_capacity`); for lodging they are **not** authoritative — unit rates govern — and may be
set to `0`. Slots/schedules are never created for a lodging service.

### 4.4 POS — sale (extends `confirmSale`)

A cart **stay line** carries `{ service_id, unit_id, check_in, check_out, guests }` instead of
`{ slot_id, quantity }`. On confirm, for each stay line:

1. Re-`quoteStay` server-side (never trust a client price) and **snapshot** the total +
   per-night breakdown + unit name onto the folio line (folio history must not dereference live
   config — same snapshot guarantee as tours).
2. Atomically insert the `accommodation_reservations` row with the §2.4 conditional-insert guard.
   If 0 rows affected → **`409 UNIT_UNAVAILABLE`**; the whole sale rolls back (mirrors the slot
   capacity guard / US-AG11).

A folio may mix tour lines and stay lines. **Deposit/apartado (D7):** the deposit, hold window,
`Liquidar saldo`, `Cancelar` (US-AG07.4), `Reactivar` (US-AG07.5), and auto-expiry sweep operate
on the folio exactly as today; the reservation follows — it is created `active` at booking and set
`cancelled` on cancel/expiry (releasing the dates), re-created/`active` on reactivate (re-running
the overlap guard; `409 UNIT_UNAVAILABLE` if the dates were taken in the meantime).

### 4.5 Cancellation & refund (D9 — extends US-A21)

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

### 4.6 New error codes

Add to the `ErrorCode` union (`src/types/errors.ts`) and record in `docs/TECH_DEBT.md` as
introduced-and-consumed here:

| Status | Code | Condition |
|---|---|---|
| 409 | `UNIT_UNAVAILABLE` | Range overlaps an active reservation or block-out at confirm/reactivate |
| 409 | `SEASON_OVERLAP` | A seasonal rate overlaps an existing active season for the unit |
| 400 | `MIN_STAY_NOT_MET` | `nights < unit.min_nights` |

Existing `VALIDATION_ERROR` / `NOT_FOUND` / `FORBIDDEN` cover the rest.

---

## 5. Frontend

### 5.1 Admin (catalog)

- **Lodging service detail** grows a **Units** section (reusing the slots/extras section pattern):
  a unit list with add/edit/deactivate; each unit form captures name, type label, beds, base
  occupancy, max capacity, base rate, weekend rate, extra-person fee, min nights, check-in/out
  times, and an **amenity multi-select** (the §2.6 chips). Money inputs use the minor-units helper;
  `max_capacity >= base_occupancy` and `min_nights >= 1` validated client-side via the shared Zod.
- **Per-unit Seasons** sub-editor (name + date range + nightly rate; overlap rejected) and
  **Block-outs** sub-editor (date range + optional reason) on the unit.
- **Settings (Configuración)**: weekend-days selector + free-cancel-days + penalty-% fields,
  alongside the booking policy.

### 5.2 Agent / affiliate (POS)

- **Range-first (AG36):** on a lodging service card, a **date-range picker** (check-in →
  check-out, reusing the `BottomSheet` + calendar pattern of US-AG35) plus a guests stepper; on
  apply, the sheet lists **available units** with their `quoteStay` total and per-night breakdown;
  picking one adds the stay line to the cart. Honors min-stay and turnover; sold-out units are
  absent.
- **Unit-first (AG37):** a unit view shows a month **availability calendar** (free / blocked /
  booked days at that unit's rate); the agent selects a range on it and adds to cart.
- **Checkout (AG38):** the stay line shows unit · `Sáb 10 → Mar 13 · 3 noches` · guests · total
  (with the per-night/extra-person breakdown expandable). The **adaptive amount-driven checkout**
  (US-AG07.2) drives full-pay vs deposit; phone required for a booking (D4 of the apartado spec).
- Affiliates reach all of the above through the same POS, restricted to their allow-listed
  services (`affiliate_commission` rows) — no lodging-specific divergence.
- Commission (US-A12) — **two-level waterfall** (lodging-specific divergence):
  - **Property level** (the `lodging` service, wizard Step 2) sets the **base** commission —
    `commission_type ∈ {percent, fixed}` + `commission_value`, the default every unit inherits.
  - **Unit level** (each `accommodation_units` row) carries an **optional override**
    (`commission_type`/`commission_value`, both nullable). `NULL` ⇒ inherit the service base; a
    value ⇒ the unit ignores the property rule and applies its own (e.g. one premium cabin at 15%
    or a flat $500 while the rest inherit 10%).
  - **Resolution** happens at sale time — `unit override ?? service base` — and is snapshotted onto
    the stay's `folio_line` (snapshot semantics unchanged). An affiliate's per-affiliate rate still
    wins over both, exactly as for tours.
  - **percent** applies to the stay's sold/collected amount naturally; a **fixed** commission counts
    **per stay line** (one reservation = one "spot"-equivalent). Lodging is **exempt from the D3
    fixed ≤ `minimum_price` cap** (a lodging service has no price floor — units price per night), so
    a fixed base or override is allowed at any amount.

---

## 6. Scenarios

### US-A59 — Units (inventory)

1. **Create unit** — admin `POST /api/services/:id/units` (service is `lodging`) with name, beds,
   `base_occupancy:2`, `max_capacity:4`, `base_rate:150000` → `201`; row in caller's org, `active`.
2. **`max_capacity < base_occupancy` → `400`**; no row written.
3. **Units only on a lodging service** — creating a unit under a `tours` service → `400`
   (or the unit section is simply not offered; server still validates category). *(Open: hard
   reject vs allow-but-unused — default reject.)*
4. **Deactivate/reactivate** are idempotent; reservations are untouched.

### US-A60 — Rate rules

5. **Seasonal rate persists & round-trips**; overlapping active season for the same unit →
   `409 SEASON_OVERLAP`.
6. **Quote precedence** — a unit `base_rate:100000`, `weekend_rate:140000`, a season
   `2026-12-20…2026-12-31 @ 200000`; a 3-night stay `2026-12-19→2026-12-22` with `weekendDays=Fri,Sat`
   quotes night-19 (Sat, weekend) `140000` + night-20 (season) `200000` + night-21 (season)
   `200000` = `540000`. *(Season outranks weekend; weekend outranks base.)*
7. **Extra-person** — `base_occupancy:2`, `extra_person_fee:30000`, 3 nights, 3 guests adds
   `1 × 30000 × 3 = 90000` to the room total.

### US-A61 — Availability controls

8. **Block-out blocks a range** — a block-out `2026-07-10…2026-07-12` makes a stay touching any of
   those nights omit the unit from availability and `409 UNIT_UNAVAILABLE` at confirm.
9. **Min-stay** — `min_nights:2`; a 1-night stay → `400 MIN_STAY_NOT_MET` (and the unit is hidden
   for that range in the range-first list).
10. **Turnover** — unit booked `…→2026-07-12`; a new stay `2026-07-12→2026-07-14` is **available**
    (check-out day reused, half-open intervals).

### US-A62 — Amenities

11. Amenities persist as CSV of valid enum keys; an unknown key → `400`; the POS availability item
    echoes the array.

### US-A63 — Cancellation policy (paid stay)

12. Org `free_cancel_days:7`, `cancel_penalty_pct:50`; a `paid` stay `total:450000`, `check_in` 10
    days out, cancelled → **full refund** (`450000`). Cancelled 3 days out → **refund `225000`**
    (50% penalty retained). A `booking`-status stay cancelled → deposit non-refundable (US-AG07.4).

### US-AG36 / AG37 / AG38 — Selling a stay

13. **Range-first** — `GET /api/pos/lodging/:id/availability?check_in=…&check_out=…&guests=3`
    returns only units free for the whole range with correct `nights`/`total`.
14. **Atomic guard** — two agents confirm the same unit/overlapping range concurrently; exactly one
    `201`, the other `409 UNIT_UNAVAILABLE` (conditional insert); no double-booking.
15. **Deposit path** — a stay confirmed with a deposit creates a `booking` folio + an `active`
    reservation holding the dates; `Liquidar saldo` flips to `paid` (reservation unchanged);
    auto-expiry/cancel sets the reservation `cancelled` and frees the dates.
16. **Mixed cart** — a folio with one tour line and one stay line confirms, decrementing the slot
    and inserting the reservation atomically; failure of either rolls back both.

### Multitenancy isolation (required — B1/B3/B4, via `seedTwoOrgs`)

17. **B4** — unit/season/blockout/availability lists are org-scoped; no `org_b` row ever appears.
18. **B3** — cross-org unit/season/blockout get/edit/deactivate and
    `GET /api/pos/lodging/:id/availability` for a foreign service → `404`; nothing revealed.
19. **B1** — injected `organizationId`/`status` in any body is stripped; the row stays in `org_a`,
    `status='active'`.

---

## 7. Definition of Done

- [ ] Migrations `0035`–`0039`: four `accommodation_*` tables (org-leading indexes, Rule 5/6) +
      three `organizations` lodging columns (additive, default-safe).
- [ ] Drizzle schema + inferred types for all four tables and the org columns.
- [ ] `src/utils/lodging.ts`: `nightlyRate`, `quoteStay`, `isUnitAvailable` — shared by the POS
      serializer and `confirmSale` (single source of pricing/availability).
- [ ] Admin nested routers (units/seasons/blockouts) on the `services` router; Zod requires the
      fields in §2.1–§2.3, validates amenities enum, rejects `max_capacity < base_occupancy`,
      `min_nights < 1`, season overlap.
- [ ] Org-settings route validates `lodging_weekend_days` (CSV `0–6`), `free_cancel_days >= 0`,
      `cancel_penalty_pct 0–100`.
- [ ] `listPosServices` lodging branch (`has_availability` from units/reservations,
      `from_nightly_rate`, no slot fields); `GET /api/pos/lodging/:id/availability` and
      `…/units/:unitId/calendar`.
- [ ] `confirmSale` accepts stay lines, re-quotes + snapshots, inserts reservations under the
      atomic overlap guard (`409 UNIT_UNAVAILABLE`); rolls back the whole sale on any failure.
- [ ] Booking lifecycle (deposit/settle/cancel/reactivate/expiry sweep) drives reservation
      `active`/`cancelled`; reactivate re-runs the guard.
- [ ] US-A21 paid-stay cancellation computes the structured refund (D9); booking-status keeps the
      non-refundable-deposit rule.
- [ ] `'UNIT_UNAVAILABLE'`, `'SEASON_OVERLAP'`, `'MIN_STAY_NOT_MET'` added to `ErrorCode`;
      documented in `docs/TECH_DEBT.md` as introduced-and-consumed here.
- [ ] Frontend: `features/catalog/lodging.ts` (amenity map), unit/season/blockout admin editors on
      the lodging service detail, settings fields; POS range-first + unit-first sheets, stay
      checkout line, deposit-aware checkout.
- [x] **Commission waterfall** (migration `0041`): per-unit `commission_type`/`commission_value`
      override on `accommodation_units` (nullable ⇒ inherit); `confirmSale` resolves
      `unit ?? service`; lodging exempt from the D3 fixed cap; wizard Step 3 unit form + detail unit
      editor expose a Heredar/%/$ control (shared `unitCommission{To,From}Api` mappers). Tests in
      `test/lodging/accommodation-stays.test.ts` (waterfall inherit/percent/fixed override +
      validation) and `test/catalog/service-catalog.test.ts` (lodging fixed base commission).
- [ ] Scenarios 1–16 in `test/lodging/accommodation-stays.test.ts`; 17–19 (B1/B3/B4) via
      `seedTwoOrgs`.
- [ ] `pnpm --filter api-guideme test` green; `pnpm build:app` clean.
- [ ] `docs/SPEC.md` updated (US-A59–A63, US-AG36–AG38, Inventory/Pricing rules, glossary).

---

## 8. Open decisions (defaults chosen — confirm or override)

1. **`unit_type` free label vs closed enum** — *default:* free text (operators name their own
   types). *Alt:* a closed enum like categories (enables type filtering, loses flexibility).
2. **Check-in/out scope** — *default:* per-unit (D2 independence). *Alt:* per-service (one
   property time) with per-unit override — promote later if every unit shares times.
3. **Lodging on a non-lodging service** — *default:* reject unit creation unless
   `service.category = 'lodging'`. *Alt:* allow (units simply unused elsewhere).
4. **Catalog `base_price` for lodging** — *default:* store `0`, surface `from_nightly_rate`
   instead. *Alt:* keep `base_price` synced to the min unit rate.
5. **Fixed commission on a stay** — *default:* per stay line (1 reservation = 1 unit). *Alt:* per
   night. Percent is unaffected.
6. **Seasonal min-stay & season-varying extra-person fee** — deferred (D3/D5); revisit if demand.
