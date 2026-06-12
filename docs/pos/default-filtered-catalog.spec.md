# Feature: Default-Filtered POS Catalog & Lightweight Availability Query

## Context

Today the POS catalog (`GET /api/pos/services`) returns, per active service, a
**Σ-remaining spot count** (`available_spots`) and `next_slot_date`, computed over
**every** active future slot (`date ≥ today`). The catalog page renders the count
as an availability chip and shows the category chips (US-A37). There is no Date
filter, no "hide sold out" control, and no shared day context between the catalog
and the service-detail drill-in.

This feature makes the catalog **open fast and pre-filtered** for an agent in the
field:

- A **Date filter anchored to "Hoy"** (default), so the agent sees what is sellable
  now without choosing anything.
- The existing **category chips** (US-A37) — reused, no change to their contract.
- An **"Ocultar agotados" toggle, on by default**, so sold-out services drop out of
  the grid until the agent opts to see them.
- A **lightweight** payload: the catalog read drops the spot count for a single
  boolean **`has_availability`**, evaluated over a bounded **availability window**
  (a rolling 3-day window by default, or the single selected date) — no slot-level
  data crosses the wire for the list view.
- The **selected date is lifted into global state** and **inherited by the
  service-detail view**, so the agent keeps their day context across the drill-in.

**User Story:** **US-AG30** (default-filtered catalog: Date + categories + hide-sold-out;
lightweight `has_availability` over a 3-day window or the selected date; date in global
state, inherited by the detail view).

**Builds on / refines:**
- `docs/pos/pos-controlled-discount.spec.md` — the POS catalog read
  (`listPosServices`) and the service-detail read (`getPosService`, already
  `from`/`to`-scoped) this feature extends.
- `docs/catalog/service-categories.spec.md` (US-A37) — the category chips reused
  here. This feature only changes **how the present-category set is derived** (from
  the services that survive the "hide sold out" filter, keeping US-A37's "a chip
  only for a category with ≥ 1 available service" promise honest under the toggle).
- `docs/catalog/flexible-capacity.spec.md` (US-A36) — `has_availability` is computed
  over **effective** remaining (raw remaining + the Soft Cap flexible margin), so a
  fully-booked-but-flexible service still reads available.

**Out of scope (own features / later):**
- Server-side category filtering. Category narrowing stays **client-side** over the
  loaded list (US-A37's model); only the **date** reaches the server.
- A date *range* picker. The filter is a single day (or the default 3-day-window
  anchor); multi-day ranges are not in scope.
- Persisting the selected date across sessions / reloads. The global state is
  in-memory for the session (resets on reload), matching the cart store.
- Changing the **detail** read's payload. The detail screen keeps its full slot list
  (it needs per-slot remaining to sell); only the **catalog list** goes lightweight.

---

## Data Model

**No migration.** This feature is read-shape + frontend only. `has_availability` is
*derived* at query time from existing `slots` / `services` columns; nothing new is
persisted.

---

## API surface

### POS catalog — `GET /api/pos/services` (refines `listPosServices`)

**Query params**

| Param | Type | Notes |
|---|---|---|
| `today` | `YYYY-MM-DD` (optional) | Org-local "today" anchor (existing param). Defaults to the server's UTC date. Anchors the default 3-day window. |
| `date` | `YYYY-MM-DD` (optional, **new**) | An explicit single day the agent selected. When present, the availability window collapses to **`[date, date]`**. When absent, the window is the rolling **`[today, today + 2]`** (3 calendar days inclusive). |

**Availability window**

- `date` absent → window = `today … today + 2` (the "next 3 days").
- `date` present → window = that single date.

A service's **`has_availability`** is `true` ⇔ it has ≥ 1 **active** slot whose
`date` is inside the window **and** whose **effective remaining** is > 0, where
effective remaining = `(capacity − booked) + (isFlexible ? floor(capacity × flex_capacity_pct / 100) : 0)`
(US-A36). Effective remaining is always ≥ 0, so `Σ effective_remaining over window slots > 0`
is an exact, single-query test for "any slot in window is sellable."

**Response shape** — `available_spots` is **removed**; `has_availability` replaces it.

```json
{
  "services": [
    {
      "id": "svc_1",
      "name": "Canyon Sunrise Tour",
      "description": "…",
      "base_price": 150000,
      "minimum_price": 120000,
      "is_flexible": false,
      "flex_capacity_pct": 0,
      "category": "tours",
      "has_availability": true,
      "next_slot_date": "2026-06-20"
    }
  ]
}
```

- `next_slot_date` is **retained** — it is the cheap `min(slots.date)` over the same
  windowed slots (or `null` when the service has no slot in the window). It is still a
  useful, lightweight UI hint ("Próximo: …") and adds no slot-level payload. *(Open
  decision 2 — drop it for strict "boolean only," or keep it.)*
- The order (active services by name), org scoping, and the `is_flexible` /
  `flex_capacity_pct` / `category` fields are unchanged from US-A36/US-A37.

> Multitenancy unchanged: both the service query and the windowed-availability query
> already filter by `agent.organizationId` (Rule: every read is org-scoped). A foreign
> org's slots can never seed `has_availability` or a category chip for this org.

### POS service detail — `GET /api/pos/services/:id` (unchanged contract)

No payload change. The detail read already accepts `from` / `to`; the frontend now
**passes the inherited date** into them (below). The server behaviour is untouched.

---

## Frontend

### Global filter state (`store/posFilters.ts`, new Zustand store)

A tiny session store holding the **shared day context** (the only state the story
requires to be global — the toggle and category selection stay local to the page):

```ts
interface PosFiltersState {
  // null = the default "Hoy" anchor → catalog uses the rolling 3-day window, and the
  // detail view shows "today onward". A concrete YYYY-MM-DD = an explicit pick →
  // catalog evaluates only that day, and the detail view scopes to that day.
  selectedDate: string | null
  setSelectedDate: (date: string | null) => void
}
```

- `null` (default) ⟺ the UI shows the **"Hoy"** anchor selected; the catalog requests
  the rolling 3-day window; the detail inherits `from = today` (today onward — current
  behaviour).
- A concrete date `d` ⟺ the agent picked a day; the catalog requests `date = d` (single
  day); the detail inherits `from = d, to = d`.

A single nullable field (no derivable `isToday` boolean) maps exactly to the story's
"next 3 days **or** the selected date," avoiding redundant state.

### Catalog service client (`services/posService.ts`)

`listPosServices(today?, date?)` adds the optional `date` param; the response type
swaps `available_spots: number` for `has_availability: boolean`. `usePosServices`
keys on `[..., today, date]` so changing the date refetches.

### Catalog page (`pages/PosCatalogPage.tsx`)

A compact **filter bar** above the grid:

1. **Date control** — a "Hoy" chip (active when `selectedDate === null`) + a native
   date input (MUI `TextField type="date"`). Tapping "Hoy" clears to `null`; picking a
   date sets `selectedDate`. *(Open decision 3 — chip + native input vs. quick chips
   "Hoy / Mañana / Elegir".)*
2. **Category chips** — unchanged from US-A37, **but** the present-category set is
   derived from the services that survive the "hide sold out" filter (see below), so a
   chip never advertises a category that has nothing sellable.
3. **"Ocultar agotados" `Switch`** — **local** `useState`, default **`true`**. When on,
   services with `has_availability === false` are filtered out of the grid (and out of
   the present-category derivation). The category and toggle selections reset on
   navigation; only the date is global.

Filter precedence (all client-side over the loaded list):
`hide-sold-out` → derive present categories → `category` chip → render grid.

The availability chip on each card now reads from the boolean: **Disponible** vs.
**Agotado** (no "N disponibles" count — that granularity lives on the detail screen).

### Service detail page (`pages/PosServicePage.tsx`)

Reads `selectedDate` from the global store and passes it into `usePosService`:

```ts
const selectedDate = usePosFilters((s) => s.selectedDate)
const range = selectedDate
  ? { from: selectedDate, to: selectedDate } // explicit day → just that day
  : undefined                                 // "Hoy" anchor → today onward (default)
const { data: service } = usePosService(id, range)
```

So an agent who filtered the catalog to a date drills into a detail that already
shows that day's slots — the day context is inherited, no re-selection.

---

## Scenarios

### US-AG30 — Lightweight windowed availability (API)

#### Scenario 1 — Default window is the next 3 days
**Given** an active service whose only sellable slot is on `today + 2`
**When** `GET /api/pos/services` is called with no `date`
**Then** the service's `has_availability` is `true`; the payload has **no
`available_spots`** field and **no slot list**.

#### Scenario 2 — A slot outside the 3-day window does not count
**Given** an active service whose only sellable slot is on `today + 5`
**When** `GET /api/pos/services` is called with no `date`
**Then** `has_availability` is `false` (the slot is beyond `today + 2`).

#### Scenario 3 — Selected date collapses the window to one day
**Given** a service sellable on `today + 1` but **not** on `today`
**When** `GET /api/pos/services?date=<today>` is called
**Then** `has_availability` is `false`; calling it with `date=<today+1>` returns
`true`.

#### Scenario 4 — Effective (Soft Cap) remaining counts as available
**Given** a Soft Cap service whose only in-window slot is full on raw capacity but
has a flexible margin > 0
**When** `GET /api/pos/services` is called
**Then** `has_availability` is `true` (effective remaining > 0), matching US-A36.

#### Scenario 5 — A fully sold-out service reads unavailable
**Given** an active service whose in-window slots all have effective remaining 0
**When** the catalog is read
**Then** `has_availability` is `false`.

#### Scenario 6 — A service with no slots in window
**Given** an active service with no active slot inside the window
**When** the catalog is read
**Then** `has_availability` is `false` and `next_slot_date` is `null`.

### US-AG30 — Filters & state inheritance (frontend)

#### Scenario 7 — Hide-sold-out is on by default
**Given** the catalog returns one available and one sold-out service
**When** the page first renders
**Then** only the available service is in the grid; toggling "Ocultar agotados" off
reveals the sold-out one (shown with an **Agotado** chip).

#### Scenario 8 — Category chips reflect only sellable categories
**Given** the only `dining` service is sold out and a `tours` service is available,
with "Ocultar agotados" on
**When** the page renders
**Then** the chips show **Todos · Tours** — no `Gastronomía` chip (its only service is
hidden); turning the toggle off brings the `Gastronomía` chip back.

#### Scenario 9 — Selected date is inherited by the detail view
**Given** the agent picks `today + 1` in the Date filter and opens a service
**When** the service-detail page loads
**Then** it requests `from = today+1, to = today+1` and shows that day's slots;
returning to the catalog keeps `today + 1` selected.

#### Scenario 10 — "Hoy" anchor shows today-onward on the detail
**Given** `selectedDate` is `null` (default "Hoy")
**When** the agent opens a service
**Then** the detail requests `from = today` with no `to` (today onward — current
behaviour, unregressed).

### Multitenancy isolation (required — Scenario B4)

#### Scenario 11 — B4: windowed availability is org-scoped
**Given** `org_a` has an available in-window `tours` service and `org_b` has an
available `dining` service
**When** an `org_a` agent calls `GET /api/pos/services`
**Then** only `org_a`'s service is returned; `org_b`'s service never appears and can
never set `has_availability` or seed a chip for `org_a`.

---

## Definition of Done

- [x] `listPosServices` accepts an optional `date` param; availability is evaluated
      over `[today, today+2]` by default or `[date, date]` when `date` is present.
- [x] The catalog payload replaces `available_spots` with `has_availability: boolean`
      (computed over **effective** remaining, US-A36); `next_slot_date` retained over
      the same window; **no slot list** in the catalog read.
- [x] `getPosService` contract unchanged; the frontend passes the inherited date into
      its `from`/`to`.
- [x] New `store/posFilters.ts` Zustand store with `selectedDate: string | null`.
- [x] `services/posService.ts` + `usePosServices` carry `date`; the response type uses
      `has_availability`. `PosServiceSummary.available_spots` → `has_availability`.
- [x] `PosCatalogPage`: Date control (Hoy chip + date input), reused category chips
      (present set derived from the hide-sold-out-filtered list), and a default-on
      "Ocultar agotados" switch. Availability chip reads the boolean.
- [x] `PosServicePage` inherits `selectedDate` into `usePosService`'s range.
- [x] `AvailabilityChip` (or its replacement) renders from a boolean
      (Disponible / Agotado).
- [x] Scenarios 1–6, 11 covered in `test/pos/pos-catalog-availability.test.ts`
      (B4 via `seedTwoOrgs`). Scenarios 7–10 are frontend behaviours.
- [x] SPEC.md updated (US-AG30, Phase-2 entry, business rule, glossary) — done.
- [x] `pnpm --filter api-guideme test` green (317); `pnpm build:app` clean (`tsc -b` + vite).

---

## Open decisions (defaults chosen — confirm or override)

1. **Drop the spot count entirely?** *default:* yes — replace `available_spots` with
   `has_availability`; catalog cards show only **Disponible / Agotado**. This removes
   the "N disponibles" low-stock hint *from the catalog list* (it remains on the
   detail screen, which keeps per-slot remaining). *Alternative:* keep both — but that
   contradicts the story's "must **only** return a boolean."
2. **`next_slot_date`** — *default:* keep it (cheap `min(date)`, useful "Próximo: …"
   hint, no slot-level data). *Alternative:* drop it for a strict boolean-only payload.
3. **3-day window bound** — *default:* `today … today + 2` inclusive (3 calendar days,
   today counts as day 1). *Alternative:* `today … today + 3` (today + next 3).
4. **Date control UI** — *default:* a "Hoy" chip + a native date input (free pick).
   *Alternative:* quick chips (Hoy / Mañana / Elegir fecha).
5. **Detail scope on an explicit date** — *default:* `from = to = date` (only that
   day, matching the filter). *Alternative:* `from = date` with no `to` (that day
   onward).
6. **Hide-sold-out scope** — *default:* local component state, default **on**, resets
   on navigation (only the date is global). *Alternative:* lift it into the global
   store too.
