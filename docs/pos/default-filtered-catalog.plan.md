# Implementation Plan — Default-Filtered POS Catalog & Lightweight Availability Query (US-AG30)

> **Spec:** `docs/pos/default-filtered-catalog.spec.md`
> **Stack (API):** Hono · Drizzle · Cloudflare D1 · Vitest (`cloudflare:test`)
> **Stack (App):** React 18 · MUI · TanStack Query · Zustand
> **Refines:** the POS catalog read (`listPosServices`) and the agent catalog page;
> reuses US-A37 category chips and US-A36 effective-remaining math. **No migration.**

This is a **read-shape + frontend** change: swap the catalog's Σ-remaining count for a
windowed boolean `has_availability`, add the Date filter + "Ocultar agotados" toggle,
and lift the selected date into a small global store the detail view inherits. The
service-**detail** read is untouched (it still needs per-slot remaining to sell).

---

## Phases

```
Phase 1 → API: window the availability query + swap available_spots → has_availability
Phase 2 → API tests (scenarios 1–6 + multitenancy B4)
Phase 3 → FE infra (posFilters store, posService `date` param + type swap, hooks)
Phase 4 → FE UI (filter bar: Date + categories + hide-sold-out; boolean chip; detail inheritance)
Phase 5 → Review against spec + SPEC checklist
```

Phases 1→2 (backend) are independently shippable (the FE keeps compiling once the type
swaps in Phase 3). Phases 3→4 depend on Phase 1's payload.

---

## Phase 1 — API: windowed `has_availability`

**File:** `api-turistear/src/routes/pos/handler.ts` (`listPosServices`).

1. Read the new optional `date` query param alongside the existing `today`.
2. Compute the window bounds:
   - `date` present → `windowFrom = windowTo = date`.
   - `date` absent → `windowFrom = today`, `windowTo = addDays(today, 2)` — a small
     helper that adds days to a `YYYY-MM-DD` string (mirror the naive-calendar approach
     already used here; `Date.UTC` + slice is fine for the MVP single-timezone model).
3. In the availability query, add `lte(slots.date, windowTo)` to the existing
   `gte(slots.date, windowFrom)` filter (today the lower bound is `today` and there is
   no upper bound — this bounds it).
4. Replace the `availableSpots` SUM-projection consumption: keep the same effective-
   remaining `sum(...)` expression but derive the boolean in the result map:
   `has_availability: a ? Number(a.availableSpots) > 0 : false`. (Leave the SQL as a sum;
   `sum > 0` is the exact test since effective remaining is always ≥ 0.) Drop
   `available_spots` from the returned object; keep `next_slot_date` (= `min(date)` over
   the same windowed slots).
5. Leave `is_flexible` / `flex_capacity_pct` / `category` and the org-scoping untouched.

> Multitenancy: unchanged — both queries already filter on `agent.organizationId`. No new
> route, no new Zod schema (read-only, params only), so no Rule-1 surface.

## Phase 2 — API tests

**File:** `api-turistear/test/pos/pos-catalog-availability.test.ts` (new).

- Seed an org + agent (reuse existing POS test helpers / `seedTwoOrgs`).
- **Scenario 1** — slot on `today+2`, no `date` → `has_availability: true`; assert the
  item has **no `available_spots`** key and **no `slots`** key.
- **Scenario 2** — slot on `today+5`, no `date` → `false`.
- **Scenario 3** — slot on `today+1` only; `date=today` → `false`; `date=today+1` → `true`.
- **Scenario 4** — Soft Cap slot full on raw capacity but margin > 0 → `true`.
- **Scenario 5** — in-window slot(s) with effective remaining 0 → `false`.
- **Scenario 6** — no in-window slot → `false` and `next_slot_date: null`.
- **Scenario 11 (B4)** — `seedTwoOrgs`: `org_a` agent sees only `org_a`'s service; the
  `org_b` service never sets availability for `org_a`.
- Gate: `pnpm --filter api-turistear test` green (the api gate is vitest, no tsc step).

## Phase 3 — Frontend infra

1. **`app-turistear/src/store/posFilters.ts`** (new Zustand store):
   `selectedDate: string | null` + `setSelectedDate`. Default `null` (= "Hoy").
2. **`app-turistear/src/features/pos/types.ts`**: in `PosServiceSummary`, replace
   `available_spots: number` with `has_availability: boolean`. (`PosServiceDetail`
   `Omit`s `available_spots`/`next_slot_date` already — update the Omit to drop
   `has_availability` instead, keeping the detail shape unchanged.)
3. **`app-turistear/src/services/posService.ts`**: `listPosServices(today?, date?)` — append
   `&date=` when provided; response type already flows from the updated summary type.
4. **`app-turistear/src/features/pos/hooks/usePosServices.ts`**: accept `date`, key on
   `[...POS_SERVICES_QUERY_KEY, today ?? null, date ?? null]`, pass through.

## Phase 4 — Frontend UI

1. **`pages/PosCatalogPage.tsx`**
   - Read `selectedDate` / `setSelectedDate` from `usePosFilters`. Compute the org-local
     `today` (reuse whatever the app already uses for the POS day; otherwise a small
     `todayStr()` helper) and call `usePosServices(today, selectedDate ?? undefined)`.
   - **Filter bar** above the grid: a "Hoy" `Chip` (filled/secondary when
     `selectedDate === null`) + an MUI `TextField type="date"` (value = `selectedDate ?? ''`,
     `min = today`; onChange → `setSelectedDate(v || null)`); and an **"Ocultar agotados"**
     `Switch` + label, **local `useState(true)`**.
   - Derive `visibleByAvailability = hideSoldOut ? services.filter(s => s.has_availability) : services`.
     Derive `presentCategories` from `visibleByAvailability` (so a chip only shows for a
     category with a sellable service under the current toggle). Apply the existing
     category chip filter on top → `visibleServices`.
   - Swap the card chip: `AvailabilityChip` now takes the boolean.
2. **`features/pos/components/AvailabilityChip.tsx`**: change props to
   `available: boolean` → **Disponible** (success, outlined) / **Agotado** (outlined). Drop
   the count / `LOW_THRESHOLD` branch (no count in the catalog payload anymore).
3. **`pages/PosServicePage.tsx`**: read `selectedDate`; build
   `range = selectedDate ? { from: selectedDate, to: selectedDate } : undefined`; pass to
   `usePosService(id, range)`. (Inherits the filtered day; "Hoy" → today onward, unregressed.)
4. Gate: `pnpm build:app` (`tsc -b` + vite) clean; `pnpm lint:app`.

## Phase 5 — Review

- Walk spec Scenarios 1–11; mark ✅/❌.
- Confirm the payload is lightweight: catalog read carries **no `available_spots`** and
  **no slot array**; only `has_availability` (+ retained `next_slot_date`).
- Confirm org-scoping unchanged on both catalog queries.
- Confirm hide-sold-out default-on and category-chip derivation from the filtered set
  (US-A37 "chip only for a category with ≥ 1 available service" still holds).
- Confirm date inheritance round-trips catalog ↔ detail and "Hoy" stays unregressed.
- Tick the SPEC Phase-2 entry **Default-Filtered POS Catalog** *(US-AG30)*.

---

## Checklist

### Backend
- [x] `listPosServices`: optional `date` param; window = `[today, today+2]` or `[date,date]`
- [x] Availability query bounded with `lte(slots.date, windowTo)`; effective-remaining sum reused
- [x] Payload: `available_spots` removed, `has_availability: boolean` added; `next_slot_date` kept; no slot list
- [x] `test/pos/pos-catalog-availability.test.ts` Scenarios 1–6 + B4 (Scenario 11)

### Frontend
- [x] `store/posFilters.ts` (`selectedDate: string | null`)
- [x] `PosServiceSummary.available_spots` → `has_availability`; detail Omit updated
- [x] `posService.listPosServices(today?, date?)` + `usePosServices` keying on `date`
- [x] `PosCatalogPage`: Date control (Hoy chip + date input), hide-sold-out switch (default on), category chips over the filtered set
- [x] `AvailabilityChip` boolean (Disponible / Agotado)
- [x] `PosServicePage` inherits `selectedDate` into `usePosService`

### Docs
- [x] `docs/SPEC.md` — US-AG30 + Phase-2 entry + business rule + glossary (done)
- [x] Spec DoD ticked in `docs/pos/default-filtered-catalog.spec.md`
