# RFC / PDR: Transition to "Unit Type" Inventory (Airbnb/OTA Style)

**Status:** **Approved** (2026-07-07; revised same day — added §3.1–§3.4 decisions, §4 scope, §5 testing)
**Impact:** Core Architecture, POS Catalog, Sales Experience (UX)

## 1. Context and Current Problem

Currently (under the `US-A59` specification), the Lodging architecture in Turistear Ya! operates under a **strictly physical model**:
- **Structure:** A Service (e.g., "Center Hotel") contains Multiple Physical Units (e.g., "Room 101", "Room 102").
- **POS UX:** The main catalog lists the "Parent Service" (Center Hotel). When tapped, the sales sheet displays all available individual physical units. The agent must select and sell a specific physical unit.

**Identified Issues:**
1. **Clutter and Cognitive Load:** If a hotel has 50 identical standard rooms, the agent must see (or indirectly deal with) 50 identical options in the sales sheet. It forces the sales agent to make operational decisions (physical assignment) that delay closing the sale.
2. **Invisibility of Boutique Properties:** A manager with 3 unique cabins loses the power to showcase their properties on the main catalog screen, as they remain hidden within the "Parent Service".

## 2. The Proposal (The Airbnb / Booking Model)

Transition the Point of Sale towards a **"Room-Type Inventory"** model.

The system will no longer require the selection of physical units at the point of sale, and will instead sell **"Quantities of a Unit Type"**.

### 2.1 Visual Impact on the Catalog (Frontend `/pos`)
The catalog is **flattened**. Instead of exclusively listing parent "Services", the `/pos` view will directly list the **Unit Types** (alongside regular Tours).
- *Hotel Scenario:* Instead of showing the "Center Hotel" card, it will show 2 direct cards: `"Standard Room (Center Hotel)"` and `"Presidential Suite (Center Hotel)"`.
- *Boutique Scenario (Airbnb):* Unique units (each being its own "Type") will shine in the main catalog with their own photos and amenities: `"River Cabin"` and `"Forest Cabin"`.

### 2.2 Operational Impact and Sales Flow (Bottom Sheet)
1. The agent taps a "Unit Type" in the catalog.
2. The bottom sheet opens (`LodgingStaySheet`).
3. The agent selects: **Dates, Guests, and Quantity of Rooms** (e.g., 2 standard rooms).
4. The agent DOES NOT select physical room numbers (101 or 102).

## 3. Required Technical Changes (Architecture)

To achieve this transition, the following areas of the system must be modified:

### 3.1 Database Migration — Rename, Don't Drop

The Pure OTA Model (Option 1) stands, but the migration is a **rename + additive transform**, not a
drop-and-recreate. Rationale: `folio_lines`, `accommodation_reservations`, `accommodation_seasons`,
and `accommodation_blockouts` all hold foreign keys into `accommodation_units`. D1's remote `/query`
endpoint enforces FK constraints **per statement** and does not honor `PRAGMA defer_foreign_keys`
(the hard-won lesson documented inside migration `0040`), so `DROP TABLE accommodation_units` would
force a 0040-style multi-step rebuild of every referencing table. `ALTER TABLE … RENAME` sidesteps
all of it — SQLite automatically repoints inbound FK definitions at the renamed table.

Migration steps (one file, plain ALTERs, safe per-statement on remote):

1. **`accommodation_units` → `accommodation_unit_types`** (`RENAME TO`). Nearly every column
   already describes a *type*, not a physical room: `name`, `unit_type`, `beds`, `base_occupancy`,
   `max_capacity`, `base_rate`, `weekend_rate`, `extra_person_fee`, `min_nights`,
   `checkin_time`/`checkout_time`, `amenities`, the commission override (`0041`), `status` — all
   kept as-is. Add one column: **`inventory_count INTEGER NOT NULL DEFAULT 1`**.
2. **`accommodation_reservations`**: `RENAME COLUMN unit_id TO unit_type_id`; add
   **`quantity INTEGER NOT NULL DEFAULT 1`** (rooms reserved).
3. **`accommodation_blockouts`**: `RENAME COLUMN unit_id TO unit_type_id`; add
   **`quantity INTEGER NOT NULL DEFAULT 1`** (rooms taken out of inventory — see §3.3).
4. **`accommodation_seasons`**: `RENAME COLUMN unit_id TO unit_type_id`. No other change.
5. **`folio_lines`**: `RENAME COLUMN unit_id TO unit_type_id`. **No new column** — the existing
   `quantity` column (today hardcoded to `1` for stay lines) now carries the room count.

**Data:** existing rows are development/test data and will be **wiped** before or during the
migration (delete stay folios/lines, reservations, seasons, blockouts, and unit rows). No
transform is required. (Had real data existed, the `DEFAULT 1` columns mean each physical unit
would have degraded gracefully into a type with `inventory_count = 1` — worth remembering if this
pattern recurs.)

### 3.2 Reservation Engine — Per-Night Atomic Count Guard

⚠️ The naive guard — `inventory_count − SUM(quantity of overlapping reservations) ≥ requested` —
is **incorrect**: two reservations that each overlap the requested range but not each other (e.g.,
Mon–Wed and Thu–Sat against a Mon–Sat request) both count against the same pool, producing false
409s. The constraint must hold **for every night** of the requested stay:

> ∀ night ∈ [check_in, check_out):
> reserved(night) + blocked(night) + requested_quantity ≤ inventory_count

It must also remain **atomic**. D1 has no interactive transactions, so — exactly like today's
per-unit overlap guard — the check and the write are one conditional `INSERT … WHERE NOT EXISTS`,
with `meta.changes === 0 ⟺ insufficient inventory → 409`. The nights are expanded with a
recursive CTE. Sketch:

```sql
INSERT INTO accommodation_reservations
  (id, organization_id, service_id, unit_type_id, folio_id,
   check_in, check_out, guests, quantity, status)
SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active'
WHERE NOT EXISTS (
  WITH RECURSIVE nights(d) AS (
    SELECT :check_in
    UNION ALL
    SELECT date(d, '+1 day') FROM nights WHERE date(d, '+1 day') < :check_out
  )
  SELECT 1 FROM nights n
  WHERE COALESCE((SELECT SUM(r.quantity) FROM accommodation_reservations r
                  WHERE r.unit_type_id = :type AND r.status = 'active'
                    AND r.check_in <= n.d AND n.d < r.check_out), 0)
      + COALESCE((SELECT SUM(b.quantity) FROM accommodation_blockouts b
                  WHERE b.unit_type_id = :type
                    AND b.start_date <= n.d AND n.d < b.end_date), 0)
      + :requested_quantity
      > (SELECT t.inventory_count FROM accommodation_unit_types t WHERE t.id = :type)
)
```

- Error code changes from `UNIT_UNAVAILABLE` to **`INSUFFICIENT_INVENTORY`** (409).
- The **booking reactivation** path (US-AG re-claim, `pos-bookings-reactivate`) re-claims a
  cancelled stay under this same guard — it converts alongside `confirmSale`, not after.
- Cancellation/expiry semantics are unchanged: `status = 'cancelled'` frees the quantity.

### 3.3 Blockouts (US-A61) Become Type-Level Quantity Blockouts

The physical-unit blockout ("Room 101's AC is broken") loses its anchor. Its replacement:
a blockout on a **unit type** removes **`quantity`** rooms from that type's pool for
`[start_date, end_date)` (half-open, matching turnover, as today). It participates in the §3.2
guard as the `blocked(night)` term.

- *Hotel:* "2 standard rooms out for maintenance next week" → one blockout, `quantity = 2`.
- *Boutique (count = 1):* a blockout with `quantity = 1` closes the whole property — identical in
  effect to today's per-unit blockout.
- Validation: `quantity ≤ inventory_count` at creation. Overlapping blockouts on the same type are
  allowed (they sum). Hard-delete stays (no historical value), as today.

### 3.4 Pricing & Commission Semantics with `quantity > 1`

`quoteStay` prices **one room**; `base_occupancy`, `extra_person_fee`, and `max_capacity` are
per-room figures. With multi-room lines the RFC adopts the **total-guests fast path** (speed-first
POS — one guest figure, no per-room allocation UI):

1. **Input:** the agent enters total `guests` for the line plus `quantity` (rooms).
2. **Capacity check:** `1 ≤ guests ≤ max_capacity × quantity`.
3. **Pricing:** guests are split across rooms as evenly as possible (e.g., 5 guests / 2 rooms →
   3 + 2); each room is quoted individually by the existing engine (seasons > weekend > base,
   `extra_person_fee` above `base_occupancy`); the line total is the sum. Deterministic and exact
   for the common case (guests ≤ base_occupancy × quantity ⇒ split is irrelevant).
   - *Rejected alternative:* per-room guest entry — exact for asymmetric splits, but adds a tap
     per room and contradicts the "close the sale fast" goal. Revisit only if agents report
     material `extra_person_fee` disputes.
4. **Commission:** `percent` is unchanged (percent of line total). **`fixed` is per room-stay** —
   `commission_value × quantity` — mirroring tours, where fixed commission counts per spot.
   The waterfall (type override ?? service base; affiliate rate wins) moves 1:1 from unit level to
   type level (the `0041` columns travel with the rename).

### 3.5 Backend (APIs)

- **`GET /api/pos/services`** returns a flattened, mixed list. Each item carries a discriminator —
  **`item_type: 'tour' | 'unit_type'`** — and a stable `id` (the unit type's id for lodging cards;
  frontend keys, folio deep-links, and category filtering all depend on it). Lodging cards inject
  `has_availability` computed with the §3.2 per-night math over the selected range, plus a
  `remaining` hint (minimum free count across the range) to power "Only 2 left".
- **`GET /api/pos/availability/days`**: lodging days get **real availability dots** — a day lights
  up if any in-scope unit type has free inventory that night. This retires the frontend's
  `lodgingInScope` exception in `PosDatePickerSheet` (lodging days are currently unconditionally
  pickable because per-unit availability was too expensive to aggregate; counts make it cheap).
- **Unit calendar** `GET /api/pos/lodging/units/:unitId/calendar` →
  `GET /api/pos/lodging/unit-types/:unitTypeId/calendar`, returning **remaining count per day**
  (`inventory_count − reserved − blocked`) instead of a binary free/taken.
- **Folio & Cart (`ConfirmStayLineInput`):** `unit_id` → `unit_type_id` + required
  `quantity` (int ≥ 1). Zod schemas shared with the frontend per the standard pattern.
- **Admin CRUD** (`/api/services/:id/units` → `/unit-types`): same handlers, renamed resource,
  plus `inventory_count` on create/update; blockout endpoints gain `quantity`.

### 3.6 Frontend (UI)

- **`PosCatalogPage`**: cards render both `item_type`s; unit-type cards show the type-specific
  price, photo, and a low-inventory badge ("Quedan 2") when `remaining` is low.
- **`LodgingStaySheet.tsx`**: the physical-unit list is removed; a **room-quantity stepper** is
  added next to the guest count. The sheet quotes via §3.4 and surfaces `INSUFFICIENT_INVENTORY`
  as an inline error with the available count.
- **`PosDatePickerSheet`**: delete the `lodgingInScope` special case (§3.5) — dot-gating becomes
  uniform across categories.

## 4. Out of Scope — Physical Room Assignment

Turistear Ya! is a **sales POS, not a Property Management System**. After this change the system tracks
*how many* rooms of a type are sold per night — never *which* physical room a guest occupies.
Physical key assignment at check-in happens outside Turistear Ya! (the property's own PMS, front-desk
board, or paper). Requests to "see which room was sold" are by-design out of scope, not bugs.

## 5. Testing Requirements

- **Cross-org isolation:** every reworked route ships with `seedTwoOrgs` isolation tests
  (`test/helpers/tenancy.ts`) per the repo-wide multitenancy rule — unit-type CRUD, blockouts,
  seasons, catalog, calendar, and stay confirmation.
- **Guard correctness:** dedicated tests for the §3.2 math, including the false-409 shape (two
  non-overlapping reservations vs. a spanning request **must succeed** when per-night capacity
  allows) and the last-room race (two concurrent confirms on the final unit → exactly one 201,
  one 409).
- **Blockout arithmetic:** overlapping quantity blockouts sum; `blocked + reserved` saturating
  `inventory_count` blocks the sale for exactly the affected nights.
- **Rewrites:** `test/lodging/accommodation-stays.test.ts` and the stay paths of the POS suite
  (`pos-bookings-*`, `pos-catalog-availability`, `pos-availability-days`) are rewritten for the
  type model — budgeted as part of this RFC, not follow-up.

## 6. Conclusion and Verdict

Adopting this model transforms Turistear Ya! from a rigid administration tool into a **High-Performance Sales Engine**.

- Agents sell much faster by not worrying about physical logistics.
- Unique properties get the premium visibility they demand (Airbnb style).
- Traditional hotels avoid UI clutter.

**Next steps:** Approve this RFC to proceed with modifying the `US-A59` to `US-A63` specifications and begin refactoring the lodging API routes.
