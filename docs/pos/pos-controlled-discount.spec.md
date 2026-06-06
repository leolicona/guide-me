# Feature: Mobile Point of Sale with Controlled Discount

## Context

This is the agent's core money-making screen and the first **agent-facing** feature in
the platform. An agent, in the field on a phone, browses the live catalog, picks a
service and an available **slot**, sets how many people, optionally adds **extras**,
optionally applies a **manual discount** down to (never below) the admin's
`minimum_price`, and **confirms** the sale. Confirming **atomically decrements** the
slot's capacity and persists a **folio** — one immutable sale record holding every line
in the cart.

The folio is the system's record of a complete sale. Inventory is the shared, contended
resource: two agents may try to sell the last spot of the same slot at the same instant,
so the decrement at confirm time is the integrity-critical operation (US-AG11).

**User Stories:**
- **US-AG03** — view the catalog of available services with real-time availability
  (remaining spots per schedule).
- **US-AG04** — select a service, choose an available schedule (slot), add a number of
  people to start a sale.
- **US-AG05** — add optional extras to the cart.
- **US-AG06** — apply a manual discount to a service's price, with the floor locked at
  the admin-defined `minimum_price`.
- **US-AG08** — confirm the sale and generate a unique folio containing all services in
  the cart.

**Also satisfied here** (inseparable from a correct POS, no separate checklist line):
- **US-AG10** — clear indication of remaining spots per service/slot on the sales
  screen → every availability read returns derived `remaining`.
- **US-AG11** — block the sale at confirm time if a spot is no longer available
  (race-condition protection) → the atomic conditional decrement + compensation below.

**Builds on:**
- **Service Catalog** (`docs/catalog/service-catalog.spec.md`) — `services`,
  `service_extras`, integer-minor-unit money, `base_price` / `minimum_price`, the
  active/inactive soft-status model.
- **Schedules & Slots** (`docs/schedules/schedules-slots.spec.md`) — `slots` is the
  **inventory unit**. That spec deliberately created `slots.booked` (always `0` there)
  and the derived-`remaining` read shape, and left the atomic decrement
  (`UPDATE slots SET booked = booked + n WHERE … AND capacity - booked >= n`) to **this**
  feature.
- **Auth & roles** — `authMiddleware`, `requireRole`, the multitenancy Enforcement
  Contract (`docs/multitenancy/multitenancy.spec.md`).

### Scope boundary with adjacent features (read carefully)

The SPEC lists *"Folio generation with signed QR code (HMAC)"* as a **separate**
MUST-HAVE that also references US-AG08. The split is intentional and this spec honors it:

| Concern | Owner |
|---|---|
| Cart → folio creation, line/extra snapshots, **atomic inventory decrement**, **controlled discount** | **This feature** |
| Per-service **signed QR payload (HMAC-SHA256, `QR_SECRET`)** on each folio line, QR delivery shape (US-C02) | *Folio generation with signed QR code* feature |
| Email receipt + QR send (US-AG09, US-C01) via Resend | *Sending receipt and QR via Email* feature |
| **Bookings / down-payments** (US-AG07) — partial `amount_paid`, `booking` status | *Bookings* feature |
| **Folio cancellation** + spot release (US-A21) — set `cancelled`, re-increment `booked` | *Total folio cancellation* feature |
| Daily cash drawer aggregation (US-AG12–14) | *Cash drawer* feature |

The `folios` schema below is **designed for** those features (a `status` enum that
already includes `booking`/`cancelled`, an `amount_paid` column, an org-leading
`(organization_id, slot_id)` index on `folio_lines` for fast cancellation release, and
room to `ALTER TABLE folio_lines ADD COLUMN qr_token …` later) but this feature **only**
ever writes a fully-paid (`status = 'paid'`, `amount_paid = total`) folio and never signs
a QR.

> **Client delivery is via Email (Resend), not WhatsApp** (per the SPEC update). The folio
> captures a **mandatory, format-valid** `customer_email` — it is the only ticket+QR
> delivery channel in Phase 1, so the Email-delivery feature made it required at confirm
> time (`z.string().trim().email()`); a missing/malformed address returns `400`. See
> `docs/email/client-ticket-delivery.spec.md` (Business Rule 2). `customer_name` and
> `customer_phone` remain optional metadata.

**New endpoints (all auth-required, `agent` role):** a new `src/routes/pos/` router.

| Method & path | Purpose | US |
|---|---|---|
| `GET  /api/pos/services` | List **active** services with an availability rollup | AG03, AG10 |
| `GET  /api/pos/services/:id` | Active service detail: active extras + upcoming active slots (`remaining`) | AG03, AG04, AG05, AG10 |
| `POST /api/pos/folios` | Confirm a sale: validate cart, enforce discount floor, atomically decrement slots, create the folio | AG04, AG05, AG06, AG08, AG11 |
| `GET  /api/pos/folios/:id` | Read back one of the caller agent's own folios (receipt) | AG08 |

> **Why a new router (not the admin `services` router).** The catalog and schedules
> routers apply `requireRole('admin')` to `*` and explicitly deferred "agent-facing POS
> read access" to this feature. POS is `agent`-role. Folios are **agent-attributed**
> (`agent_id`), which is why selling is an agent action in MVP; admin selling is out of
> scope (admins get dashboards/reports instead).

---

## Data Model

Three **new tenant-scoped tables**. Per Multitenancy Rule 5 each declares
`organization_id TEXT NOT NULL REFERENCES organizations(id)`. `folio_lines` and
`folio_line_extras` *could* scope transitively through `folio_id`, but each carries
`organization_id` **directly** so every query is independently org-filtered (Rules 2 & 4,
defense in depth) and gets a clean org-leading index (Rule 6) — the same decision the
catalog made for `service_extras` and schedules made for `slots`.

### Money & snapshot principles

- All money is **integer minor units** (centavos), never floats — same as catalog.
- A folio is **immutable history**. To satisfy US-A13 ("edit/deactivate a service
  without affecting already-sold folios"), every line and extra **snapshots** the
  human-readable and price fields it depends on at sale time (`service_name`,
  `slot_date`, `slot_start_time`, `base_price`, `minimum_price`, extra `name`/`price`).
  A folio never dereferences the live catalog row for a historical value. The `*_id`
  columns are retained as **references** (for cancellation release, reporting joins),
  not as the source of displayed values.
- **The server is the single source of truth for all totals.** The client sends the
  cart shape and the per-line discounted `unit_price` (the only price decision an agent
  is allowed to make); the server recomputes every total from snapshots and **ignores any
  client-supplied total**. Extra prices come from the DB, never the client (no discount
  ever applies to an extra).

### `folios` (new table) — the sale record

| Column | Type | Notes |
|---|---|---|
| `id` | `text` PK | `crypto.randomUUID()` — the unique folio identifier (SPEC glossary) |
| `organization_id` | `text NOT NULL` → `organizations(id)` | Rule 5 |
| `agent_id` | `text NOT NULL` → `users(id)` | the selling agent, from `c.var.user` (Rule 3) |
| `customer_name` | `text` (nullable) | captured at sale |
| `customer_email` | `text` (nullable column; **required at POS**) | Email address; format-validated at confirm and consumed by Resend delivery. Column stays nullable for legacy/defensive rows. |
| `customer_phone` | `text` (nullable) | E.164; captured for marketing/future WhatsApp |
| `status` | `text NOT NULL DEFAULT 'paid'` | enum `['paid','booking','cancelled']`. **This feature only writes `'paid'`.** |
| `subtotal` | `integer NOT NULL` | Σ line totals (incl. extras), minor units, server-computed |
| `discount_total` | `integer NOT NULL DEFAULT 0` | Σ `(base_price − unit_price) × quantity`, informational |
| `total` | `integer NOT NULL` | grand total charged; `== subtotal` in MVP |
| `amount_paid` | `integer NOT NULL` | collected amount; `== total` for a paid sale (`< total` reserved for bookings) |
| `created_at` | `integer NOT NULL DEFAULT (unixepoch())` | |
| `updated_at` | `integer NOT NULL DEFAULT (unixepoch())` | |

Indexes (Rule 6):
```sql
CREATE INDEX folios_org_agent_idx   ON folios (organization_id, agent_id);
CREATE INDEX folios_org_created_idx ON folios (organization_id, created_at); -- daily cash drawer (later)
```

### `folio_lines` (new table) — one service+slot in the cart

| Column | Type | Notes |
|---|---|---|
| `id` | `text` PK | |
| `organization_id` | `text NOT NULL` → `organizations(id)` | carried directly |
| `folio_id` | `text NOT NULL` → `folios(id)` | parent folio |
| `service_id` | `text NOT NULL` → `services(id)` | reference (reporting), not a display source |
| `slot_id` | `text NOT NULL` → `slots(id)` | the decremented inventory unit; release target on cancel |
| `service_name` | `text NOT NULL` | **snapshot** at sale time |
| `slot_date` | `text NOT NULL` | **snapshot** `YYYY-MM-DD` |
| `slot_start_time` | `text NOT NULL` | **snapshot** `HH:MM` |
| `quantity` | `integer NOT NULL` | number of people; `>= 1`; spots decremented from the slot |
| `base_price` | `integer NOT NULL` | **snapshot** unit base price |
| `minimum_price` | `integer NOT NULL` | **snapshot** unit floor enforced at sale |
| `unit_price` | `integer NOT NULL` | actual sold unit price; `minimum_price <= unit_price <= base_price` |
| `line_total` | `integer NOT NULL` | `unit_price × quantity + Σ extra(price × quantity)` |
| `created_at` | `integer NOT NULL DEFAULT (unixepoch())` | |

Indexes (Rule 6):
```sql
CREATE INDEX folio_lines_org_folio_idx ON folio_lines (organization_id, folio_id);
CREATE INDEX folio_lines_org_slot_idx  ON folio_lines (organization_id, slot_id); -- cancellation release (later)
```

### `folio_line_extras` (new table) — extras attached to a line

| Column | Type | Notes |
|---|---|---|
| `id` | `text` PK | |
| `organization_id` | `text NOT NULL` → `organizations(id)` | carried directly |
| `folio_id` | `text NOT NULL` → `folios(id)` | folio-level convenience for the receipt read |
| `folio_line_id` | `text NOT NULL` → `folio_lines(id)` | parent line |
| `extra_id` | `text NOT NULL` → `service_extras(id)` | reference |
| `name` | `text NOT NULL` | **snapshot** |
| `price` | `integer NOT NULL` | **snapshot** unit price (no discount ever) |
| `quantity` | `integer NOT NULL DEFAULT 1` | `>= 1` |
| `created_at` | `integer NOT NULL DEFAULT (unixepoch())` | |

Index (Rule 6): `CREATE INDEX folio_line_extras_org_folio_idx ON folio_line_extras (organization_id, folio_id);`

> Migrations: `0010_create_folios.sql`, `0011_create_folio_lines.sql`,
> `0012_create_folio_line_extras.sql` (one table per file, FK order: folios → lines →
> line_extras), matching the `0001`–`0009` style.

---

## Business rules (enforced server-side)

From SPEC → Key Business Rules:

1. **Controlled discount (US-AG06, Pricing & Discounts).** For every line,
   `minimum_price <= unit_price <= base_price` using the **snapshot** prices read from
   the DB at confirm time. `unit_price < minimum_price` → `400 PRICE_BELOW_MINIMUM`
   (clear, dedicated). `unit_price > base_price` (a negative "discount") →
   `400 VALIDATION_ERROR`. The floor is the admin's number, not the client's.
2. **No discount on extras.** Extra `price` always comes from the live `service_extras`
   row (snapshotted onto the folio); the client cannot send an extra price.
3. **Real-time inventory & race protection (US-AG11, Inventory).** Confirming decrements
   each referenced slot **atomically and conditionally**:
   `UPDATE slots SET booked = booked + :qty, updated_at = …
    WHERE id = :slotId AND organization_id = :org AND status = 'active'
      AND capacity - booked >= :qty`.
   If a decrement affects **0 rows** (slot full, gone, inactive, or foreign-org) the sale
   is **rejected** and every already-applied decrement in this confirm is **compensated**
   (re-incremented) before returning `409 SLOT_UNAVAILABLE`. No folio is written. (D1 has
   no interactive transactions in the Workers binding; see "Atomicity" below.)
4. **Only active, in-org, sellable inventory.** A line's `slot_id` must resolve to an
   `active` slot whose parent service is `active`, in the caller's org; otherwise the
   confirm fails `404 NOT_FOUND` (no leakage of cross-org existence). Inactive services /
   slots are invisible to the POS reads and unsellable on confirm.
5. **Server owns totals.** `line_total`, `subtotal`, `discount_total`, `total` are
   computed from snapshots; any client-supplied total is ignored. `quantity >= 1`,
   integer; extras `quantity >= 1`, integer.
6. **Distinct slots per cart.** Two lines may not reference the same `slot_id`
   (the UI merges quantities); a duplicate → `400 VALIDATION_ERROR`. This keeps the
   decrement one-update-per-slot and dodges intra-cart self-contention.
7. **Folios are immutable and never deleted.** This feature only creates them. Status
   transitions (`booking → paid`, `* → cancelled`) belong to later features.

### Atomicity (D1 has no interactive transactions)

The Workers D1 binding offers `batch()` (an all-or-nothing batch on **error**) but **not**
interactive transactions, and a conditional `UPDATE` that matches **0 rows is not an
error** — so a batch cannot conditionally abort on "sold out." The MVP approach:

1. **Validate** the whole cart against snapshots (prices, ownership, active status) —
   pure reads, no writes.
2. **Decrement** each distinct slot with the conditional `UPDATE … RETURNING id`,
   in order, tracking which succeeded.
3. On the **first** decrement that returns 0 rows → **compensate**: issue
   `UPDATE slots SET booked = booked - :qty WHERE id = :slotId AND organization_id = :org`
   for each already-succeeded slot, then throw `409 SLOT_UNAVAILABLE`. No folio rows
   exist yet, so there is nothing else to roll back.
4. If **all** decrements succeed → insert the `folios` + `folio_lines` +
   `folio_line_extras` rows (a single `db.batch([...])`, atomic on error).

The compensation window is sub-millisecond and bounded by the cart size. The partial
unique index and the `capacity - booked >= :qty` guard are the DB-level backstops. (A
note in `docs/TECH_DEBT.md` records "interactive transactions unavailable on D1; sale
confirm uses validate-decrement-compensate" so the trade-off is tracked.)

---

## Endpoints

All endpoints: **Auth required, `agent` role** (`authMiddleware` + `requireRole('agent')`
on `*`). A suspended caller is stopped by `authMiddleware` (`403 ACCOUNT_SUSPENDED`).
Cross-org / unknown ids resolve to `404 NOT_FOUND` via org-filtered queries (Rules 2 & 4)
— the response never reveals whether the id exists in another org.

### `GET /api/pos/services` — POS catalog list (US-AG03, US-AG10)

Active services in the caller's org, ordered by `name`, each with an **availability
rollup** over its `active` slots dated **today or later** (org-local `YYYY-MM-DD`,
compared lexicographically against a `today` param — see below).

**Query params (optional):**

| Param | Effect |
|---|---|
| `today` | `YYYY-MM-DD` org-local "today" used as the availability horizon floor; defaults to the server's UTC date if omitted (MVP single-timezone, mirrors schedules) |

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
      "available_spots": 34,
      "next_slot_date": "2026-06-15"
    }
  ]
}
```

`available_spots` = Σ `remaining` over the service's active, future slots;
`next_slot_date` = the earliest such slot's date (or `null` if none). These power the
"available / close-to-capacity / full" hint (US-AG10). Inactive services are omitted.

### `GET /api/pos/services/:id` — POS service detail (US-AG03, AG04, AG05, AG10)

One **active** service in the caller's org with its **active extras** and its **active,
future** slots (each with derived `remaining`). This single read powers the
select-service → choose-slot → pick-extras flow. `404` if the service is unknown,
inactive, or in another org.

**Query params (optional):** `from` / `to` (`YYYY-MM-DD`) bound the slot window; default
`from = today`, no upper bound.

#### Response — 200 OK

```json
{
  "service": {
    "id": "svc_abc",
    "name": "Canyon Sunrise Tour",
    "description": "Guided sunrise hike with breakfast.",
    "base_price": 150000,
    "minimum_price": 120000,
    "extras": [
      { "id": "ext_1", "name": "Professional photo", "price": 25000 }
    ],
    "slots": [
      { "id": "slot_1", "date": "2026-06-15", "start_time": "06:00",
        "capacity": 12, "booked": 2, "remaining": 10 }
    ]
  }
}
```

Only `active` extras and `active` future slots with `remaining > 0`? **No** — return all
active future slots including `remaining = 0` ones so the agent sees "full" explicitly
(US-AG10); the confirm guard, not the read, blocks selling them.

### `POST /api/pos/folios` — Confirm sale (US-AG04, AG05, AG06, AG08, AG11)

#### Request body

```json
{
  "customer_name": "Jane Tourist",
  "customer_email": "jane@example.com",
  "customer_phone": "+525512345678",
  "lines": [
    {
      "slot_id": "slot_1",
      "quantity": 2,
      "unit_price": 130000,
      "extras": [
        { "extra_id": "ext_1", "quantity": 2 }
      ]
    }
  ]
}
```

| Field | Rule |
|---|---|
| `customer_name` | optional, nullable string |
| `customer_email` | **required, format-valid email** (`z.string().trim().email()`); missing/malformed → `400` |
| `customer_phone` | optional, nullable string (E.164-ish) |
| `lines` | required, non-empty array; **distinct** `slot_id` across lines (rule 6) |
| `lines[].slot_id` | required string; must resolve to an active slot of an active service in the caller's org |
| `lines[].quantity` | required integer `>= 1` |
| `lines[].unit_price` | required integer `>= 0`; validated `minimum_price <= unit_price <= base_price` against the **snapshot** |
| `lines[].extras` | optional array; each `extra_id` must be an active extra of that line's service |
| `lines[].extras[].extra_id` | required string |
| `lines[].extras[].quantity` | required integer `>= 1` |

- `organization_id` / `agent_id` / `status` / any `*_total` are **never** read from the
  body (Rules 1 & 3; Zod strips unknowns). `service_id` is **derived from the slot**, not
  accepted from the client.
- The folio is created `status = 'paid'`, `amount_paid = total`.

#### Response — 201 Created

```json
{
  "folio": {
    "id": "fol_xyz",
    "status": "paid",
    "customer_name": "Jane Tourist",
    "customer_email": "jane@example.com",
    "customer_phone": "+525512345678",
    "subtotal": 310000,
    "discount_total": 40000,
    "total": 310000,
    "amount_paid": 310000,
    "created_at": 1750000000,
    "lines": [
      {
        "id": "fl_1",
        "service_id": "svc_abc",
        "slot_id": "slot_1",
        "service_name": "Canyon Sunrise Tour",
        "slot_date": "2026-06-15",
        "slot_start_time": "06:00",
        "quantity": 2,
        "base_price": 150000,
        "minimum_price": 120000,
        "unit_price": 130000,
        "line_total": 310000,
        "extras": [
          { "id": "fle_1", "extra_id": "ext_1", "name": "Professional photo", "price": 25000, "quantity": 2 }
        ]
      }
    ]
  }
}
```

`line_total = 130000×2 + 25000×2 = 310000`; `discount_total = (150000−130000)×2 = 40000`.

### `GET /api/pos/folios/:id` — Folio read-back (US-AG08)

Returns one folio **owned by the caller agent** (`organization_id` + `agent_id = self`),
same shape as the confirm response (lines + extras). `404` if not found, not owned by the
caller, or in another org. (Admin/cross-agent folio access is a reports-feature concern.)

---

## Error responses (all endpoints)

| Status | Code | Condition |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Body fails Zod: empty `lines`, `quantity < 1`, non-integer, duplicate `slot_id`, `unit_price > base_price` |
| 400 | `PRICE_BELOW_MINIMUM` | A line's `unit_price` is below the snapshot `minimum_price` (US-AG06 floor) |
| 401 | `UNAUTHORIZED` | No / unrefreshable session |
| 403 | `FORBIDDEN` | Authenticated as `admin`, not `agent` |
| 403 | `ACCOUNT_SUSPENDED` | Caller's own account is suspended (from `authMiddleware`) |
| 404 | `NOT_FOUND` | A `slot_id` / `extra_id` / service / folio is unknown, inactive, or in another org |
| 409 | `SLOT_UNAVAILABLE` | At confirm time a slot can no longer satisfy the requested quantity (sold out / race) |

> **Two new `ErrorCode`s introduced & consumed by this feature: `PRICE_BELOW_MINIMUM`
> (400) and `SLOT_UNAVAILABLE` (409).** Add both to the `ErrorCode` union in
> `src/types/errors.ts`. The global error handler maps `ApiError.status` → response, so
> no handler-map change is needed. Record both in `docs/TECH_DEBT.md` as
> introduced-and-consumed here (no open debt) — mirroring the `CONFLICT` entry. They are
> distinct from the generic `VALIDATION_ERROR`/`CONFLICT` because the frontend renders
> them as specific, actionable states ("below minimum price" inline on the discount
> field; "this time just sold out" on the slot).

---

## Scenarios

### US-AG03 / US-AG10 — Browse catalog with live availability

#### Scenario 1 — Agent lists POS services with availability rollup
**Given** an authenticated `agent` of `org_a` with an active service `svc_a` having two
active future slots (`remaining` 10 and 12) and one inactive service
**When** `GET /api/pos/services`
**Then** Status `200`; only `svc_a` is returned; `available_spots = 22`;
`next_slot_date` is the earlier slot's date; the inactive service is absent.

#### Scenario 2 — Service detail returns active extras + active future slots
**Given** `svc_a` with two active extras (one inactive extra) and active future slots
(one with `remaining = 0`) plus one past-dated slot
**When** `GET /api/pos/services/svc_a`
**Then** Status `200`; only the two active extras appear; the future slots appear (incl.
the `remaining = 0` one) ordered by date then time, each with derived `remaining`; the
past slot and inactive extra are absent.

#### Scenario 3 — Inactive / unknown / foreign service detail → 404
**Given** an `agent` of `org_a`
**When** `GET /api/pos/services/:id` targets an inactive service, an unknown id, or a
service of `org_b`
**Then** Status `404 NOT_FOUND`; existence in another org is not revealed.

### US-AG04 / US-AG05 / US-AG06 / US-AG08 — Build cart & confirm

#### Scenario 4 — Confirm a single-line sale decrements the slot and creates a folio
**Given** `agent` of `org_a`, active `slot_1` with `capacity 12`, `booked 0`
**When** `POST /api/pos/folios` with one line `{slot_1, quantity: 2, unit_price: base_price}`
**Then** Status `201`; a `folios` row exists in `org_a` with `agent_id = caller`,
`status = 'paid'`, `total = base_price×2`, `amount_paid = total`; one `folio_lines` row
snapshots `service_name`/`slot_date`/`slot_start_time`/`base_price`/`minimum_price`;
`slot_1.booked` is now `2`.

#### Scenario 5 — Extras are added, snapshotted, and summed; no discount on extras
**Given** active `slot_1` and an active extra `ext_1` (`price 25000`) of its service
**When** the line includes `extras: [{ext_1, quantity: 2}]`
**Then** Status `201`; a `folio_line_extras` row snapshots `name`/`price = 25000`,
`quantity = 2`; `line_total = unit_price×qty + 25000×2`; the extra price is taken from
the DB, not from any client-sent value.

#### Scenario 6 — Manual discount within range is accepted; totals server-computed
**Given** `svc_a` `base_price = 150000`, `minimum_price = 120000`
**When** a line sets `unit_price = 130000`, `quantity = 2`
**Then** Status `201`; `unit_price` stored `130000`; `line_total` includes `260000`;
`discount_total = (150000−130000)×2 = 40000`; any client-supplied total is ignored.

#### Scenario 7 — Discount below minimum → 400 PRICE_BELOW_MINIMUM, nothing written
**Given** `minimum_price = 120000`
**When** a line sets `unit_price = 119000`
**Then** Status `400 PRICE_BELOW_MINIMUM`; no folio, line, or extra rows are written; no
slot is decremented.

#### Scenario 8 — Price above base (negative discount) → 400 VALIDATION_ERROR
**When** a line sets `unit_price > base_price`
**Then** Status `400 VALIDATION_ERROR`; nothing written.

#### Scenario 9 — Multi-line cart decrements every slot atomically
**Given** active `slot_1` (svc_a) and `slot_2` (svc_b), both with capacity
**When** a two-line cart confirms
**Then** Status `201`; one folio with two lines; both `slot_1.booked` and `slot_2.booked`
increase by their quantities.

#### Scenario 10 — US-AG11 race: a slot cannot satisfy quantity → 409, full compensation
**Given** active `slot_1` `capacity 12 / booked 11` (1 left) and active `slot_2` with room
**When** a cart requests `slot_1 ×2` and `slot_2 ×1` (slot_2 listed first, so it
decrements before slot_1 fails)
**Then** Status `409 SLOT_UNAVAILABLE`; **no folio is written**; `slot_2.booked` is
**unchanged** (its successful decrement was compensated back); `slot_1.booked` stays `11`.

#### Scenario 11 — Confirm against an inactive / foreign slot → 404
**When** a line's `slot_id` is an inactive slot, a slot of `org_b`, an unknown id, or a
slot whose parent service is inactive
**Then** Status `404 NOT_FOUND`; nothing written; no decrement.

#### Scenario 12 — Extra not belonging to the line's service → 404
**Given** `ext_b` is an extra of a different service
**When** a line for `slot_1` (svc_a) includes `ext_b`
**Then** Status `404 NOT_FOUND`; nothing written.

#### Scenario 13 — Empty cart / duplicate slot / bad quantity → 400
**When** `lines` is `[]`, or two lines share a `slot_id`, or any `quantity` is `0` /
negative / non-integer
**Then** Status `400 VALIDATION_ERROR`; nothing written.

#### Scenario 14 — Folio read-back returns the caller's folio with lines + extras
**Given** the agent created `fol_1`
**When** `GET /api/pos/folios/fol_1`
**Then** Status `200`; the full folio shape (lines + extras + totals) is returned.

#### Scenario 15 — Reading another agent's / foreign / unknown folio → 404
**Given** `fol_b` belongs to another agent (or `org_b`)
**When** the caller `GET /api/pos/folios/fol_b`
**Then** Status `404 NOT_FOUND`.

#### Scenario 16 — Admin is forbidden from POS
**Given** a user with `role = 'admin'`
**When** any `/api/pos/*` endpoint is called
**Then** Status `403 FORBIDDEN`.

### Multitenancy isolation (required — Scenarios B1 / B3 / B4)

Per `CLAUDE.md` and `docs/multitenancy/multitenancy.spec.md`, every tenant-scoped route
MUST ship cross-org isolation tests built on `seedTwoOrgs`.

#### Scenario 17 — B4: POS catalog/detail scoped to caller's org
**Given** services & slots exist in both `org_a` and `org_b`
**When** the `org_a` agent lists POS services / reads a service detail
**Then** only `org_a` rows ever appear.

#### Scenario 18 — B3: Cross-org confirm & folio read → 404, targets untouched
**Given** `slot_b` belongs to `org_b`
**When** the `org_a` agent confirms a cart citing `slot_b`, or reads a folio of `org_b`
**Then** Status `404 NOT_FOUND`; `slot_b.booked` is unchanged; nothing leaks.

#### Scenario 19 — B1: Injected `organizationId` / `agent_id` / `status` / totals ignored
**Given** an `org_a` agent confirms a sale
**When** the body includes `"organizationId": "org_b"`, `"agent_id": "other"`,
`"status": "booking"`, or a forged `"total"`
**Then** those fields are stripped/ignored; the folio's `organization_id = org_a`,
`agent_id = caller`, `status = 'paid'`, and `total` is the server's computed value.

---

## Definition of Done

- [ ] Migrations `0010_create_folios.sql` + `0011_create_folio_lines.sql` +
      `0012_create_folio_line_extras.sql` create all three tables with `organization_id`
      (Rule 5) and org-leading indexes (Rule 6), incl. `folio_lines_org_slot_idx` for
      future cancellation release
- [ ] Drizzle schema: `folios` + `folioLines` + `folioLineExtras` tables and inferred types
- [ ] `'PRICE_BELOW_MINIMUM'` (400) + `'SLOT_UNAVAILABLE'` (409) added to the `ErrorCode`
      union (`src/types/errors.ts`); both documented in `docs/TECH_DEBT.md` as
      introduced-and-consumed here
- [ ] New `src/routes/pos/` (`index.ts`, `handler.ts`, `schema.ts`), mounted at
      `/api/pos` with `authMiddleware` + `requireRole('agent')` on `*`
- [ ] POS reads return **only active** services / extras / slots in the caller's org;
      `remaining` derived in the response, never stored; availability rollup computed
- [ ] Confirm enforces `minimum_price <= unit_price <= base_price` from snapshots;
      below-min → `PRICE_BELOW_MINIMUM`; above-base → `VALIDATION_ERROR`
- [ ] Confirm derives `service_id` from the slot, validates extras belong to the line's
      service, snapshots `service_name`/slot date+time/`base_price`/`minimum_price`/extra
      `name`+`price`, and computes all totals server-side (client totals ignored)
- [ ] Atomic conditional decrement per distinct slot; **compensation** re-increments on
      any failure; sold-out → `409 SLOT_UNAVAILABLE` with **no** folio written
      (validate-decrement-compensate documented in `docs/TECH_DEBT.md`)
- [ ] Folio created `status = 'paid'`, `amount_paid = total`; folios immutable (no
      update/delete in this feature)
- [ ] All reads/writes filter by `c.var.user.organizationId` (Rules 2 & 4); `agent_id` /
      `organization_id` / `status` / totals never from the body (Rules 1 & 3); folio
      read-back additionally filtered by `agent_id = self`
- [ ] Scenarios 1–16 covered by `test/pos/pos-controlled-discount.test.ts`
- [ ] Scenarios 17–19 (B1/B3/B4) covered using `seedTwoOrgs`
- [ ] Frontend: `posService`, `features/pos/` (types/schemas/hooks), a cart Zustand store,
      POS catalog page, service/slot/extra selection, discount input clamped to
      `minimum_price`, checkout/confirm, folio receipt view; agent-only **Sell** nav
      destination
- [ ] `pnpm --filter api-guideme test` green; `pnpm build:app` clean
- [ ] `docs/SPEC.md` MUST-HAVE item **Mobile point of sale with controlled discount
      (US-AG03, US-AG04, US-AG05, US-AG06, US-AG08)** ticked
</content>
</invoke>
