# Feature: Zoned Capacity (physical zones inside a departure)

## Context

A slot-based service sells one undifferentiated pool of seats: `slots.capacity` in,
`slots.booked` out. Operators running vehicles with distinct physical areas — the upper and
lower decks of a Turibus, a first-class carriage, a covered vs open section — cannot express
that. Today an agent selling "the last 3 seats" has no way to know whether those seats are on
the deck the tourist actually wants, and nothing prevents 40 people being sold onto a 20-seat
upper deck.

This feature lets an admin **subdivide a service's capacity into named zones with their own
seat counts**. The POS then shows availability per zone and the agent sells a specific zone,
so each area is protected by its own ceiling.

Zones are a **pure inventory partition**: same price, same minimum price, same commission,
same extras. A zone splits *seats*, never *money*. That is the single constraint that keeps
this feature small — no per-zone pricing, no discount floors per zone, no re-pricing when a
passenger is moved between zones, and no refund arithmetic anywhere in the flow.

The setting is **opt-in per service** (`services.zones_enabled`). Every existing service, and
every new one, behaves exactly as it does today until an admin turns zones on.

**User Story:** **US-A64** (define zones on a service; sell and release per zone; close a zone
for a single departure).

**Builds on:**
- `docs/catalog/service-catalog.spec.md` — the `services` table and the admin-only
  `POST`/`PUT /api/services` this feature extends with one flag and a child collection.
- `docs/schedules/schedules-slots.spec.md` — `slots.capacity` / `slots.booked`, the per-slot
  counters zones subdivide, and the slot lifecycle (materialization, deactivate/reactivate).
- `docs/pos/pos-controlled-discount.spec.md` — the POS reads (`GET /api/pos/services`,
  `GET /api/pos/services/:id`) and the atomic capacity guard in `confirmSale`.
- `docs/catalog/flexible-capacity.spec.md` — Soft Cap, which this feature is **mutually
  exclusive** with (see *Zones and flexible capacity*).
- `docs/lodging/accommodation-stays.spec.md` — the unit-type inventory model this mirrors in
  shape (a named child collection with its own count) for a slot-based service.
- `docs/qr/folio-qr-signing.spec.md` — one signed ticket per folio line; the zone rides on the
  line, **not** in the signed payload.

**Out of scope (own features, deliberately excluded):**
- **Per-zone pricing.** A zone has no `base_price` / `minimum_price`. If premium decks are
  ever needed, that is an additive migration on `service_zones` plus the whole pricing stack
  (floor enforcement, discount authority, commission snapshots) — a separate feature.
- **Zones + flexible capacity together.** With strict per-zone ceilings and a total equal to
  the sum of zones, the Soft Cap margin is mathematically unreachable; the two settings are
  therefore mutually exclusive (below).
- **Per-slot zone capacity overrides.** Seat counts live on the service. A single departure can
  have a zone *closed* (§ Closing a zone for one departure), but not resized.
- **Gate enforcement.** The scanner *displays* the zone; it does not reject a ticket at the
  wrong door. No per-device zone configuration.
- **Rescheduling and per-line cancellation.** Neither exists in the product today (cancellation
  is whole-folio, `docs/cancellation/total-folio-cancellation.spec.md`). Zones make the latter
  more visible but do not change it.
- **Per-zone occupancy reporting.** No occupancy dashboard exists; reports are money-based and
  read folios, which are unaffected.

---

## Data Model

One migration, `0043_zoned_capacity.sql`, carries all four changes.

### `service_zones` — the zone definitions (new table)

The seat counts live here and **only** here. Every departure of the service inherits them.

| Column | Type | Notes |
|---|---|---|
| `id` | `text PRIMARY KEY` | |
| `organization_id` | `text NOT NULL → organizations(id)` | Rule 5. |
| `service_id` | `text NOT NULL → services(id)` | |
| `name` | `text NOT NULL` | Free text, operator-authored ("Piso alto"). Unique per service among active zones, case-insensitive. |
| `capacity` | `integer NOT NULL` | Seats in this zone; `>= 1`. |
| `sort_order` | `integer NOT NULL DEFAULT 0` | Stable display order in the wizard, POS and detail page. |
| `status` | `text NOT NULL DEFAULT 'active'` | `active` \| `inactive`. Soft-deactivated, never hard-deleted once it has sales. |
| `created_at` / `updated_at` | `integer NOT NULL DEFAULT (unixepoch())` | |

Index: `(organization_id, service_id, sort_order)`.

### `slot_zones` — the per-departure zone inventory (new table)

Holds one row per (departure, zone): the seats that zone offers on that departure, how many are
taken, and whether it is open. `capacity` is **snapshotted** here at row creation — copied from
`service_zones.capacity` at that moment — so a later edit to the zone's seat count never rewrites
what a past departure offered. This is a real per-departure fact and gets a real per-departure row.

| Column | Type | Notes |
|---|---|---|
| `id` | `text PRIMARY KEY` | |
| `organization_id` | `text NOT NULL → organizations(id)` | Rule 5. |
| `slot_id` | `text NOT NULL → slots(id)` | |
| `zone_id` | `text NOT NULL → service_zones(id)` | |
| `capacity` | `integer NOT NULL` | Seats this zone offers on this departure. Snapshotted from `service_zones.capacity` at creation; frozen for past departures. |
| `booked` | `integer NOT NULL DEFAULT 0` | Seats sold/held in this zone on this departure. |
| `status` | `text NOT NULL DEFAULT 'active'` | `active` \| `inactive` (`inactive` = closed for this departure, e.g. rain). |
| `created_at` / `updated_at` | `integer NOT NULL DEFAULT (unixepoch())` | |

Unique index: `(slot_id, zone_id)` — the row identity the atomic guard depends on.
Index: `(organization_id, slot_id)`.

**Rows are created eagerly for every FUTURE slot** (`slot.date >= today`) of a zoned service — at
the moment zones are enabled, and whenever a new slot is later materialized (schedule generation
or one-off creation, in the same atomic batch that inserts the slot). One row per active zone.
Past slots are never back-filled. The eager row is what lets the guard, the reconcile and the POS
payload all read a single frozen source; it costs one bounded, batched insert per future departure
(≤ 6 zones each), negligible at operator scale.

### `services` — one new column

| Column | Type | Notes |
|---|---|---|
| `zones_enabled` | `integer NOT NULL DEFAULT 0` | boolean. `0` = today's single pool (every existing row). |

### `folio_lines` — two new columns

| Column | Type | Notes |
|---|---|---|
| `zone_id` | `text NULL → service_zones(id)` | The zone this line's seats occupy. `NULL` for an unzoned sale or a lodging stay line. |
| `zone_name` | `text NULL` | **Snapshot** of the zone name at sale time — so renaming a zone never rewrites a sold ticket, receipt or portal page. |

```sql
-- migrations/0043_zoned_capacity.sql
CREATE TABLE `service_zones` ( …, `capacity` integer NOT NULL, … );
--> statement-breakpoint
CREATE INDEX `service_zones_org_service_idx` ON `service_zones` (`organization_id`, `service_id`, `sort_order`);
--> statement-breakpoint
CREATE TABLE `slot_zones` ( …, `capacity` integer NOT NULL, `booked` integer DEFAULT 0 NOT NULL, … );
--> statement-breakpoint
CREATE UNIQUE INDEX `slot_zones_slot_zone_uq` ON `slot_zones` (`slot_id`, `zone_id`);
--> statement-breakpoint
CREATE INDEX `slot_zones_org_slot_idx` ON `slot_zones` (`organization_id`, `slot_id`);
--> statement-breakpoint
ALTER TABLE `services` ADD COLUMN `zones_enabled` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `folio_lines` ADD COLUMN `zone_id` text REFERENCES `service_zones`(`id`);
--> statement-breakpoint
ALTER TABLE `folio_lines` ADD COLUMN `zone_name` text;
```

> Purely additive — two new tables and three nullable/defaulted columns. No table rebuild, so
> none of the `0040` / `0042` per-statement FK hazards apply (D1's remote `/query` enforces FKs
> per statement; `ADD COLUMN` with a FK reference is valid on its own).

---

## Core rules

### 1. The sale guard stays a single atomic statement

Concurrency safety in this codebase comes from one conditional `UPDATE` whose `WHERE` carries
the ceiling (`confirmSale`, `src/routes/pos/handler.ts`). D1 has no interactive transactions, so
that property is non-negotiable. For a zoned line the guard moves to the zone row and reads the
ceiling from **the row's own snapshotted `capacity`** — the eager row is guaranteed to exist:

```sql
UPDATE slot_zones
   SET booked = booked + :qty, updated_at = unixepoch()
 WHERE slot_id = :slot_id
   AND zone_id = :zone_id
   AND organization_id = :org
   AND status = 'active'                    -- zone open on this departure
   AND booked + :qty <= capacity;           -- self-column, snapshotted & frozen
```

Zero rows changed → `409 ZONE_UNAVAILABLE`, and the existing `compensate()` path unwinds the
rest of the sale exactly as it does for `SLOT_UNAVAILABLE` today. Because the row is created
eagerly when the slot is materialized (§ Enabling / slot materialization), the guard needs no
lazy-insert step — one statement, one row, no correlated subquery.

### 2. `slots` totals are derived, never hand-maintained

Every existing read — the POS availability SQL, the catalog rollup `available_spots`, the date
dots, sold-out styling, `SlotRow` — reads `slots.capacity` and `slots.booked`. Rather than
teach all of them about zones, **the slot row is reconciled from its own `slot_zones` rows** by
one idempotent pair of statements — a single table, since the rows exist eagerly — run in the
same batch as any zone write:

```sql
UPDATE slots SET
  booked   = (SELECT COALESCE(SUM(sz.booked),   0) FROM slot_zones sz
               WHERE sz.slot_id = slots.id AND sz.status = 'active'),
  capacity = (SELECT COALESCE(SUM(sz.capacity), 0) FROM slot_zones sz
               WHERE sz.slot_id = slots.id AND sz.status = 'active'),
  updated_at = unixepoch()
WHERE id = :slot_id;
```

Both sums are idempotent, so they are correct whether or not the guarded statement applied — no
conditional logic, no drift, no dependence on `service_zones`. `capacity - booked` then equals
`Σ over open zones (capacity − booked)`, which is precisely the sellable count. A closed zone
(`status = 'inactive'`) drops out of **both** sums, so its seats stop inflating availability
while remaining on their folios.

> ⚠️ **These statements run ONLY for zoned services.** On an unzoned slot there are no
> `slot_zones` rows, so the reconcile would zero out a legitimate `booked`. Branch on
> `zones_enabled` (or on the line carrying a `zone_id`) at every call site.

**Consequence, accepted:** while a zone is closed on a departure, that departure's headline
capacity and booked counts exclude it. The seats sold in the closed zone remain on their folios
and are surfaced in the zone UI ("cerrada · 8 vendidos") so staff know how many to reseat; they
simply stop inflating the departure's availability. Reopening restores them.

### 3. Every release path releases the zone

`slots.booked` moves in six places; each needs its zone counterpart when the line carries a
`zone_id`, followed by the reconcile above:

| Path | File | Change |
|---|---|---|
| Sale decrement | `pos/handler.ts` `confirmSale` | Guarded zone `UPDATE` (rule 1) instead of the slot `UPDATE`. |
| Compensation | `pos/handler.ts` `compensate()` | Give back `slot_zones.booked`. |
| Expiry sweep | `pos/sweep.ts` | Release each expired booking's zone seats. |
| Manual cancel | `pos/handler.ts` cancel folio | Release per zone. |
| Un-cancel re-block | `pos/handler.ts` | Re-block **into the same zone**, guarded — may now fail because the zone filled meanwhile; reuse the existing "cannot re-block" failure path. |
| Slot capacity edit | `services/slots.handler.ts` | Rejected for a zoned service (capacity is derived — see rule 4). |

### 4. Capacity is service-level to author, per-departure to record

The operator authors seat counts once, on `service_zones`. Each departure records its own copy
on `slot_zones.capacity`, snapshotted when the row is created. The per-slot capacity field is
therefore read-only for a zoned service: `PUT /api/services/:id/slots/:slotId` rejects a
`capacity` change with `400 VALIDATION_ERROR`, and the slot form hides it.

Editing a zone's `capacity` (`PUT …/zones/:zoneId`) propagates in one batch:

```sql
-- 1. update the authored value
UPDATE service_zones SET capacity = :new, updated_at = unixepoch() WHERE id = :zone_id …;
-- 2. re-snapshot ONLY future departures; past rows are frozen history
UPDATE slot_zones SET capacity = :new, updated_at = unixepoch()
 WHERE zone_id = :zone_id
   AND slot_id IN (SELECT id FROM slots WHERE service_id = :service_id AND date >= :today);
-- 3. reconcile those future slots' totals (rule 2)
```

Because past `slot_zones` rows keep their snapshot, editing a zone's seat count **never** changes
what a past departure offered — per zone or in total. There is no live-read, so no history-rewrite
limitation and nothing to defer.

### 5. Zones and flexible capacity are mutually exclusive

If every zone is strictly capped and the total equals the sum of the zones, then
`booked <= Σ zone capacities = capacity`, so the Soft Cap margin can never bind. Rather than
ship dead configuration, the two are exclusive:

- `zones_enabled = 1` requires `is_flexible = 0` and `flex_capacity_pct = 0`.
- Enabling zones on a Soft Cap service **warns and clears** the flex settings in the same save
  (the wizard states it explicitly; the API coerces).
- The flexible-capacity control is disabled while zones are on, and vice versa.

---

## Enabling, editing and disabling

### Turning zones ON (forward-only, sales preserved)

`POST /api/services/:id/zones/enable` accepts the zone definitions plus an
`assign_existing_to` zone id. In one batch (chunked under the D1 bound-parameter cap, exactly
like schedule materialization):

1. Insert the `service_zones` rows (min 2).
2. Set `services.zones_enabled = 1`; clear `is_flexible` / `flex_capacity_pct`.
3. For every **future** slot (`date >= today`), insert one `slot_zones` row **per zone**,
   `capacity` snapshotted from the zone, `booked = 0` — except:
4. On each future slot that had `booked > 0`, the `assign_existing_to` row instead starts at
   `booked = slots.booked` (the pre-existing sales land in that zone).
5. **Backfill `folio_lines.zone_id` / `zone_name`** for every line on those future slots to
   `assign_existing_to`.
6. Reconcile `slots.capacity` / `slots.booked` for every future slot (rule 2).

> Step 5 is not optional. Without it, cancelling one of those pre-existing folios decrements no
> zone counter, the reconcile recomputes the same total, and the seats are orphaned — never
> resellable. This is the single most important correctness detail in the feature.

Existing folios, QR codes and receipts are untouched and stay valid.

### Slot materialization on a zoned service

Every path that creates a new slot must, for a zoned service, insert its `slot_zones` rows **in
the same batch** as the slot (the atomicity lesson from BUG-012 — a slot must never exist
without its zone rows):

- `createSchedule` / schedule materialization (`src/routes/services/slots.handler.ts`) — for
  each generated slot, one `slot_zones` row per active zone.
- `createSlot` (one-off departure) — same, in its insert batch.

A slot created for an **unzoned** service inserts no zone rows, exactly as today.

### Editing zones once sales exist

| Change | Rule |
|---|---|
| **Rename** | Always allowed. Sold lines keep `zone_name` as sold; only future sales use the new name. |
| **Shrink capacity** | Allowed down to `MAX(booked)` across all **future** `slot_zones` rows of that zone. Below that → `409 CONFLICT`, naming the blocking departure. On success, re-snapshots future rows + reconciles (rule 4). |
| **Grow capacity** | Always allowed. Re-snapshots future rows + reconciles (rule 4). |
| **Add a zone** | Always allowed. Inserts a snapshotted `slot_zones` row on every future slot in the same batch; raises the derived total there. |
| **Delete** | Hard-delete only when the zone has no `slot_zones` row with `booked > 0` and no `folio_lines` reference; the delete also removes the zone's zero-booked future `slot_zones` rows in the same batch. Otherwise `deactivate` (soft): future rows flip to `inactive` (dropping out of the derived capacity) while past rows and sold lines remain. |
| **Below 2 active zones** | Rejected — a service with one zone is just an unzoned service. Use disable instead. |

### Closing a zone for one departure (the rain case)

`POST /api/services/:id/slots/:slotId/zones/:zoneId/close` (and `/reopen`) flips
`slot_zones.status` on the departure's row (which already exists — eager creation), then
reconciles the slot (rule 2), all in one batch.

- Closing **blocks new sales only**. Seats already sold there stay valid and scan normally.
- The zone UI shows the sold count on a closed zone so staff know how many passengers to
  reseat at the door. This is safe precisely because zones are same-price and the scanner does
  not enforce — no money moves, nothing is rejected at the gate.

### Turning zones OFF

`POST /api/services/:id/zones/disable`, in one batch: sets `zones_enabled = 0`; for every future
slot, writes `slots.capacity = Σ active-zone snapshot` (its current derived total) directly, then
**deletes that slot's `slot_zones` rows** (they are pure counters — the sold seats live on
`folio_lines`, whose `zone_name` snapshot is the historical reference). Past `slot_zones` rows are
kept untouched as frozen history. `service_zones` rows are retained (deactivated) so re-enabling
is not a retype. New sales require no `zone_id`; nothing enforces a zone and no passenger needs
reseating — it is the same vehicle.

---

## Validation rules (server-side Zod, mirrored in the frontend)

| Field / rule | Rule |
|---|---|
| `name` | Required, trimmed, 1–40 chars. Case-insensitively unique among the service's **active** zones → `409 CONFLICT`. |
| `capacity` | Required integer `>= 1`. |
| Zone count | `zones_enabled = 1` requires **2–6** active zones. Fewer than 2 or more than 6 → `400 VALIDATION_ERROR`. |
| `assign_existing_to` | Required when enabling on a service that has any future slot with `booked > 0`; must be one of the zones being created. |
| Sale payload | On a zoned service, a slot line **must** carry `zone_id`; missing → `400 VALIDATION_ERROR`. On an unzoned service, a supplied `zone_id` → `400`. |
| `zone_id` ownership | Must belong to the line's service and the caller's org (Rule 2) → else `404 NOT_FOUND`. |
| Flex conflict | `zones_enabled = 1` with `is_flexible = 1` → flex coerced to `0` / `0 %`. |
| Slot capacity edit | `PUT …/slots/:slotId` with `capacity` on a zoned service → `400 VALIDATION_ERROR`. |

**New error code:** `ZONE_UNAVAILABLE` (409) — added to the `ErrorCode` union in
`src/types/errors.ts`, thrown by `confirmSale`, asserted by Scenario 12. Introduced **and**
consumed in this feature (per the `docs/TECH_DEBT.md` convention).

---

## API surface

### Admin catalog (mirrors the `unit-types` shape)

```
POST   /api/services/:id/zones                     create one zone
GET    /api/services/:id/zones                     list (active first, by sort_order)
PUT    /api/services/:id/zones/:zoneId             rename / resize / reorder
DELETE /api/services/:id/zones/:zoneId             hard-delete (only when unsold)
POST   /api/services/:id/zones/:zoneId/deactivate  soft-remove from future sales
POST   /api/services/:id/zones/:zoneId/reactivate
POST   /api/services/:id/zones/enable              { zones: [...], assign_existing_to }
POST   /api/services/:id/zones/disable
POST   /api/services/:id/slots/:slotId/zones/:zoneId/close    per-departure closure
POST   /api/services/:id/slots/:slotId/zones/:zoneId/reopen
```

All admin-only, all org-scoped (Rules 1–4). `GET /api/services/:id` echoes `zones_enabled` and
embeds the zone list so the wizard re-hydrates on edit.

### POS payload

`GET /api/pos/services/:id` — each slot gains a `zones` array built from its `slot_zones` rows
(so `capacity` is the per-departure snapshot, and a closed zone is included with
`status: "inactive"`). Absent/empty for an unzoned service, so today's clients are unaffected:

```json
{
  "id": "slot_1",
  "date": "2026-08-15",
  "start_time": "10:00",
  "capacity": 50,
  "booked": 17,
  "remaining": 33,
  "zones": [
    { "zone_id": "z_alto", "name": "Piso alto", "capacity": 20, "booked": 12, "remaining": 8,  "status": "active" },
    { "zone_id": "z_bajo", "name": "Piso bajo", "capacity": 30, "booked": 5,  "remaining": 25, "status": "active" }
  ]
}
```

`GET /api/pos/services` (rollup) needs **no change**: `available_spots` already sums
`capacity - booked`, which rule 2 keeps correct.

### Sale

`POST /api/pos/sales` — a slot line accepts an optional `zone_id`, required on a zoned service.
A party split across zones is **two lines on the same folio**, one per zone, each with its own
quantity. The line snapshots `zone_name` alongside the existing `service_name` / `slot_date`
snapshots.

### QR and scanner — no payload change

`TicketPayload` (`src/utils/qr.ts`) is **unchanged**, so every ticket already issued stays
valid. The scanner's response builds its display from a DB read of the line
(`routes/tickets/handler.ts`, `TicketContext`), which simply gains `zone_name`. One QR is signed
per line, so a split party receives one code per zone.

---

## Frontend

- **Service wizard / edit** (`features/catalog/components/wizard`): a "Dividir en zonas"
  checkbox in the availability step reveals a name + seats editor (add/remove rows, live
  "Total: N asientos", min 2). Turning it on for a Soft Cap service shows the explicit warning
  that overbooking tolerance will be cleared. The per-service capacity field becomes the
  read-only derived total.
- **Catalog list** (`ServiceRow`): a zoned service reads "20 alto · 30 bajo" in the meta line
  where an unzoned one shows its capacity.
- **Service detail** (`CatalogDetailPage`): a `ZonesSection` mirroring `UnitsSection` — list,
  add, edit, deactivate, with the shared `SectionCard` / `FormSheet` / `ConfirmSheet`
  primitives.
- **Schedules section**: each departure row gains a per-zone breakdown and the close/reopen
  action; a closed zone renders with the icon-paired functional red and its sold count.
- **POS service sheet** (`SlotPicker`): tapping a departure expands zone chips beneath it
  (`[ Piso alto 8 ] [ Piso bajo 25 ]`); the departure chip itself keeps today's total. The
  quantity stepper is bounded by the **zone's** remaining. A sold-out or closed zone renders
  disabled, matching the existing `(Agotado)` treatment.
- **Cart** (`store/posCart.ts`): a slot line's identity becomes `slotId + zoneId` — `lineKey`,
  the dedupe in `addLine`, and `updateQuantity` / `updateExtraQuantity` must all take the zone,
  otherwise 3-upper + 2-lower collapses into one wrong line.
- **Cart / folio / receipt / portal**: the line label carries the zone —
  "Turibus 10:00 · Piso alto". The portal folio view (`routes/portal/handler.tsx`) adds it under
  the date line.
- **Scanner** (`ScannerPage`): the zone appears on the valid-result card, at the same weight as
  the departure time — it is what the staffer acts on.

---

## Scenarios

### US-A64 §1 — Defining zones

#### Scenario 1 — A service is unzoned by default
**Given** an authenticated `admin`
**When** `POST /api/services` is called with no zone fields
**Then** Status `201`; `zones_enabled = 0`; no `service_zones` rows; slot behaviour is
byte-identical to today.

#### Scenario 2 — Enabling zones requires at least two
**Given** an admin and a slot-based service
**When** `POST /api/services/:id/zones/enable` is called with a single zone
**Then** Status `400 VALIDATION_ERROR`; `zones_enabled` stays `0`; no rows written.

#### Scenario 3 — Duplicate zone names are rejected
**Given** a service with an active zone "Piso alto"
**When** another zone named "piso alto" is created
**Then** Status `409 CONFLICT`; one zone remains.

#### Scenario 4 — Enabling zones clears Soft Cap
**Given** a service with `is_flexible = 1`, `flex_capacity_pct = 10`
**When** zones are enabled with 20 + 30 seats
**Then** Status `200`; `zones_enabled = 1`, `is_flexible = 0`, `flex_capacity_pct = 0`.

#### Scenario 5 — Future departures inherit the derived capacity
**Given** a service with future slots of `capacity = 40` and zones 20 + 30 enabled
**When** the enable call completes
**Then** every future slot reports `capacity = 50`; past slots are untouched.

### US-A64 §2 — Enabling with seats already sold

#### Scenario 6 — Existing sold seats are assigned to a zone
**Given** a future slot with `booked = 8` and folio lines totalling 8
**When** zones are enabled with `assign_existing_to = z_bajo`
**Then** a `slot_zones` row exists for `(slot, z_bajo)` with `booked = 8`; every affected
`folio_lines.zone_id = z_bajo` and `zone_name = 'Piso bajo'`; the slot reports
`capacity = 50`, `booked = 8`.

#### Scenario 7 — A pre-existing folio cancels cleanly after enabling
**Given** the state from Scenario 6
**When** that folio is cancelled
**Then** `slot_zones.booked` for `z_bajo` drops by the line quantity **and** `slots.booked`
follows — the seats are resellable (this is the backfill regression test).

### US-A64 §3 — Selling a zone

#### Scenario 8 — A zoned sale decrements only its zone
**Given** zones alto `20` (booked 12) and bajo `30` (booked 5)
**When** an agent confirms 2 seats in `z_alto`
**Then** Status `201`; `z_alto.booked = 14`, `z_bajo.booked = 5`; `slots.booked = 19`.

#### Scenario 9 — A party split across zones is two lines, one folio
**When** a sale is confirmed with 3 × `z_alto` and 2 × `z_bajo` in one request
**Then** Status `201`; the folio has two slot lines with the same `slot_id` and different
`zone_id`; two QR tokens are signed; each zone counter moves by its own quantity.

#### Scenario 10 — Zone is required on a zoned service
**When** a slot line for a zoned service omits `zone_id`
**Then** Status `400 VALIDATION_ERROR`; nothing is written.

#### Scenario 11 — Zone is refused on an unzoned service
**When** a slot line for an unzoned service supplies `zone_id`
**Then** Status `400 VALIDATION_ERROR`.

#### Scenario 12 — Selling past a zone's ceiling is blocked
**Given** `z_alto` with `capacity = 20`, `booked = 19`, while the departure as a whole has 26
seats free
**When** an agent confirms 2 seats in `z_alto`
**Then** Status `409 ZONE_UNAVAILABLE`; `z_alto.booked` stays `19`; no folio rows exist
(compensation ran). **This is the overbooking case the feature exists to prevent.**

#### Scenario 13 — A full zone does not block a different one
**Given** `z_alto` sold out at `20/20`
**When** an agent confirms 2 seats in `z_bajo` (25 free)
**Then** Status `201`.

#### Scenario 14 — Concurrent sales into the last seat of a zone
**Given** `z_alto` with exactly 1 seat left
**When** two sales of 1 seat each are confirmed concurrently
**Then** exactly one succeeds; the other returns `409 ZONE_UNAVAILABLE`; `booked` never exceeds
`capacity` (the single-statement guard, mirroring US-AG11).

### US-A64 §4 — Release paths

#### Scenario 15 — Expiry sweep releases zone seats
**Given** a `booking` folio holding 3 seats in `z_alto`, past `booking_expires_at`
**When** the sweep runs
**Then** the folio is cancelled; `z_alto.booked` drops by 3; `slots.booked` follows.

#### Scenario 16 — Un-cancel re-blocks into the same zone
**Given** a cancelled folio that held 2 seats in `z_alto`, and `z_alto` now has 2 free
**When** the folio is un-cancelled
**Then** Status `200`; `z_alto.booked` rises by 2.

#### Scenario 17 — Un-cancel fails when the zone refilled
**Given** the same folio but `z_alto` now full
**When** the folio is un-cancelled
**Then** the existing "cannot re-block" failure is returned; no counter changed.

### US-A64 §5 — Editing zones

#### Scenario 18 — Rename does not rewrite sold tickets
**Given** a line sold with `zone_name = 'Piso alto'`
**When** the zone is renamed to "Terraza"
**Then** Status `200`; the sold line still reads "Piso alto"; new sales read "Terraza".

#### Scenario 19 — Shrinking below sold seats is rejected
**Given** `z_alto` `capacity = 20` with a future departure holding `booked = 8`
**When** capacity is set to `6`
**Then** Status `409 CONFLICT` naming the blocking departure; capacity stays `20`.

#### Scenario 20 — Deleting a zone with sales is refused; deactivating works
**Given** `z_alto` with sold seats
**When** `DELETE` is called → Status `409 CONFLICT`
**When** `deactivate` is called → Status `200`; the zone leaves future sales and the derived
capacity; its sold lines and history remain.

#### Scenario 21 — Per-slot capacity edits are refused on a zoned service
**When** `PUT /api/services/:id/slots/:slotId` sends a `capacity`
**Then** Status `400 VALIDATION_ERROR`; the slot is unchanged.

### US-A64 §6 — Closing a zone for one departure

#### Scenario 22 — Closing blocks new sales and reprices availability
**Given** the 14:00 departure with alto `20` (booked 8) and bajo `30` (booked 5)
**When** `z_alto` is closed for that slot
**Then** Status `200`; the slot reports `capacity = 30`, `booked = 5`, `remaining = 25`; a sale
into `z_alto` returns `409 ZONE_UNAVAILABLE`; the 8 sold seats remain on their folios and their
QRs still scan `valid`.

#### Scenario 23 — Reopening restores the departure
**When** `z_alto` is reopened
**Then** the slot reports `capacity = 50`, `booked = 13`.

### US-A64 §7 — Disabling

#### Scenario 24 — Disabling collapses to one pool
**Given** a zoned service with future sales in both zones
**When** `POST /api/services/:id/zones/disable` is called
**Then** Status `200`; `zones_enabled = 0`; future slots carry the summed capacity; sold lines
keep `zone_name`; new sales require no `zone_id`.

### US-A64 §8 — Scanner & portal

#### Scenario 25 — The scan shows the zone without enforcing it
**Given** a paid line in "Piso alto"
**When** the ticket is scanned
**Then** `result = valid`; the response carries `zone_name = 'Piso alto'`; the pass is redeemed.
No configuration can make the scanner reject it for being the wrong zone.

#### Scenario 26 — Pre-feature tickets still verify
**Given** a QR signed before this feature (no zone anywhere)
**When** it is scanned
**Then** `result = valid` — the signed payload is unchanged, so no re-issue is needed.

### Multitenancy isolation (required)

#### Scenario 27 — B1: injected `organizationId` is ignored
**Given** an `org_a` admin
**When** a zone body includes `"organizationId": "org_b"`
**Then** the field is stripped (Rule 1); the row's `organization_id` is `org_a`.

#### Scenario 28 — B3: a foreign service's zones are unreachable
**Given** a zoned service in `org_b`
**When** an `org_a` admin calls `GET /api/services/:id/zones` for it, or tries to close one of
its slot zones
**Then** Status `404 NOT_FOUND`; `org_b`'s rows are untouched.

#### Scenario 29 — B3: a foreign `zone_id` cannot be sold into
**Given** an `org_a` seller and a zone belonging to `org_b`
**When** a sale supplies that `zone_id`
**Then** Status `404 NOT_FOUND`; no counter in either org moves.

#### Scenario 30 — B4: zone lists are org-scoped
**Given** zones in both orgs
**When** each admin lists zones
**Then** each sees only their own.

---

## Definition of Done

- [x] Migration `0043_zoned_capacity.sql` creates `service_zones` + `slot_zones` (both carrying
      `capacity`) and adds `services.zones_enabled`, `folio_lines.zone_id`,
      `folio_lines.zone_name` (additive, default-safe, per-statement FK-valid).
- [x] Drizzle schema updated for both tables and both altered tables; inferred types flow.
- [x] `ZONE_UNAVAILABLE` added to the `ErrorCode` union, thrown by `confirmSale`, asserted by
      Scenario 12 (introduced **and** consumed — no open debt).
- [x] Zone CRUD + enable/disable + per-slot close/reopen routes, admin-only, Rules 1–4 upheld.
- [x] Slot materialization (`createSchedule`, `createSlot`) inserts `slot_zones` rows in the same
      batch as the slot for a zoned service (§ Slot materialization).
- [x] `confirmSale` uses the single-statement zone guard against the snapshotted `slot_zones.capacity`
      (rule 1 — the eager row means no lazy insert); `compensate()` releases zone seats.
- [x] `reconcileSlotTotals()` helper implementing rule 2 (single-table sums), called from every
      zone write, and **guarded so it never runs for an unzoned slot**.
- [x] All six release paths handle a zoned line: confirm, compensate, `sweep.ts`, cancel,
      un-cancel re-block, slot capacity edit (rejected).
- [x] Enable flow eager-creates snapshotted `slot_zones` for all future slots and backfills
      `folio_lines.zone_id` / `zone_name` for future-slot lines (Scenario 7 is the regression test).
- [x] Zone-capacity edits re-snapshot future `slot_zones` only; past rows frozen (rule 4 —
      no history rewrite, no deferred debt).
- [x] Zod validation: name uniqueness, capacity `>= 1`, 2–6 active zones, `zone_id` required on
      zoned sales and refused on unzoned ones, flex coercion, slot-capacity refusal.
- [x] `GET /api/pos/services/:id` exposes per-slot `zones` from `slot_zones`; the rollup is
      unchanged and still correct.
- [x] `TicketPayload` unchanged; the scan response carries `zone_name` (Scenarios 25–26).
- [x] Frontend: wizard zone editor with the Soft Cap warning; `ZonesSection` on the detail page;
      per-departure close/reopen in the schedules section; `SlotPicker` zone chips; cart keyed
      by `slotId + zoneId`; zone shown on cart, folio, receipt, portal and scanner.
- [x] Scenarios 1–26 covered in `test/catalog/zoned-capacity.test.ts` (POS guard scenarios may
      live beside the existing POS tests).
- [x] Scenarios 27–30 covered using `seedTwoOrgs` (`test/helpers/tenancy.ts`).
- [x] `SPEC.md` updated (US-A64, inventory rule, glossary). **No `TECH_DEBT.md` entry** — the
      snapshot model leaves no deferred limitation.
- [x] `pnpm --filter api-turistear test` green; `pnpm build:app` clean.
