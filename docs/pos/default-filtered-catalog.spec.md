# Feature: Default-Filtered POS Catalog & Lightweight Availability Query

> **Status: BUILT (US-AG30), AMENDED 2026-08-21 (US-AG56 / BUG-031).** The amendment corrects a
> false premise in § API surface — *"effective remaining is always ≥ 0"* — that made
> `Σ effective_remaining > 0` stand in for *"any slot is sellable"*, and promotes `next_slot_date`
> from a lightweight hint to a contract that also carries the **time**. Decisions **D7–D14**;
> scenarios **S12–S17**; closes this spec's Open decision **2**. Nothing in US-AG30's original
> scope is superseded — the window, the filters and the payload's shape all stand.


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
(US-A36).

> **Amended by BUG-031 / US-AG56 (2026-08-21).** This paragraph used to continue:
> *"Effective remaining is always ≥ 0, so `Σ effective_remaining over window slots > 0` is an
> exact, single-query test for 'any slot in window is sellable.'"* **The premise is false.**
> `updateService` turns Soft Cap off without validating against seats already sold under the old
> margin, so a slot can sit at `booked > capacity` with `flex_capacity_pct = 0` and contribute a
> **negative** term — silently cancelling out a sibling that *is* sellable. A `Σ > 0` test answers
> *"is the fleet net-positive"*, not *"is any one of them sellable"*, and those diverge exactly
> when a per-slot value goes negative. The test is now **per slot**, matching `listAvailabilityDays`
> (US-AG35), which had been right all along — the two were never made to agree in a test.

**The test is per slot, and it also produces the departure** (D7–D9 below). One aggregate answers
both questions, so the two fields can never disagree:

```sql
MIN(date || 'T' || start_time)            -- the existing lexicographic departure key
WHERE status = 'active'
  AND date BETWEEN :windowFrom AND :windowTo
  AND (date || 'T' || start_time) > :salesCutoff
  AND ((capacity - booked)
       + CASE WHEN is_flexible THEN (capacity * flex_capacity_pct) / 100 ELSE 0 END) > 0
GROUP BY service_id
```

`has_availability` ≡ `next_slot_date IS NOT NULL`. There is no second query and no Σ.

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
      "next_slot_date": "2026-06-20",
      "next_slot_time": "15:00"
    }
  ]
}
```

- `next_slot_date` / **`next_slot_time`** (new, US-AG56) name the **next departure that
  actually has room** inside the window — `null` together when there is none. Ordering is by the
  **(date, time) pair**, never by date then time: a service full at Tuesday 09:00, open at
  Tuesday 15:00 and open again Wednesday 08:00 answers **Tuesday 15:00**.
  *(Open decision 2 is **closed**: retained, and promoted from "hint" to contract — see D7.)*
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

> **Amended by BUG-032 (2026-08-21).** The snippet above is US-AG30's single-day world. US-AG35
> made the selection a **range** (`{ from, to? }`), and this reader — the sheet's twin included —
> kept taking `selection.from` alone, so a 21–23 Aug filter opened the detail on the 21st and
> called the 22nd's departure nonexistent. Both detail hosts now resolve the window with
> `posWindow(selection, today)` from `features/pos/dates.ts` — the same call the catalog list
> makes. What this section asserts is unchanged and now actually true: **the day context is
> inherited, no re-selection.** All of it, not its first day.

---

### Catalog card — the «Próximo» block (US-AG56, amendment)

`PosCatalogPage` already renders a right-aligned footer block labelled **PRÓXIMO** beside the
`MoneyText` price, gated on `item_type === 'tour' && next_slot_date`. It gains the departure time
as a **second line under the date**:

```
DESDE                    PRÓXIMO
$1,200                 VIE 27 JUN
                           15:00
```

- The time renders as the stored **naive `HH:MM`**, unformatted. `SlotPicker` already prints
  `slot.start_time` raw, so the card and the sheet the agent taps into next speak the same
  string — and no `Date` is constructed, which is what closes the whole class of BUG-007-style
  timezone faults at the render layer.
- Tabular lining figures (the `.numeric` utility) so times align down a scrolled list.
- Type-safety: `PosUnitTypeCard` gains `next_slot_time: null` beside its existing
  `next_slot_date: null`, keeping the `PosCatalogItem` discriminated union exhaustive. Lodging
  cards render no «Próximo» block (unchanged — a stay has no departure time).
- **D12's loss is visible here:** with *Ocultar agotados* off, a sold-out tour card now shows the
  **Agotado** chip and **no** «Próximo» block at all, where it previously showed a date the agent
  could not sell.

Typography, colour and spacing come from the existing block — this amendment re-decides none of
them (`PROCESS.md` § The design system has exactly one source).

### `ServiceSheet` anchor — unchanged code, corrected behaviour

`ServiceSheet.tsx` keeps `const start = anchor ?? nextSlotDate ?? today` **verbatim**. But
`nextSlotDate` now names a departure with room, so the sheet opens on a day the agent can
actually sell instead of on a sold-out one. Two consequences worth recording, since neither is
visible in the diff:

- A service the catalog reports as available opens the sheet on its **real** next departure.
- A **sold-out** service (reachable only with *Ocultar agotados* off) now passes `null` and the
  sheet falls back to **today**. Accepted: the sheet's own matrix still renders the service's
  operating days, so the agent can still read the schedule — they simply start from today.

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

### US-AG56 / BUG-031 — The next departure that actually has room (API)

> Scenarios S12–S17 are the regression surface for BUG-031. S14 in particular would have
> **passed while the bug was present** had it been written as "a sold-out service reads
> unavailable" (Scenario 5 above) — the defect needs a sold-out slot standing *in front of* an
> available one, which no pre-existing scenario arranged.

#### Scenario 12 — A sold-out earlier time does not win the day
**Given** an active service with two in-window departures on the same date — `09:00` with
effective remaining `0`, and `15:00` with effective remaining `3`
**When** `GET /api/pos/services` is read
**Then** `next_slot_date` is that date and **`next_slot_time` is `"15:00"`**; `has_availability`
is `true`.

#### Scenario 13 — A fully sold-out day yields to the next day
**Given** every departure on `today` is sold out and `today + 1` has one departure at `08:00`
with room
**When** the catalog is read
**Then** `next_slot_date` is `today + 1` and `next_slot_time` is `"08:00"` — the ordering is over
the **(date, time) pair**, so no sold-out earlier date can claim the answer (D8).

#### Scenario 14 — A negative slot cannot suppress a sellable sibling *(BUG-031 (b))*
**Given** a service whose Tuesday departure sits at `capacity 40 / booked 43` with
`is_flexible = false` (Soft Cap was turned off after the 43 seats were sold — effective
remaining `−3`), and whose Wednesday departure has `2` seats free
**When** the catalog is read
**Then** `has_availability` is `true` and the next departure is **Wednesday's** — the old
`Σ = −3 + 2 = −1` reported `Agotado` here, contradicting the calendar dots for the same day.

#### Scenario 15 — Soft Cap margin alone is enough to be the next departure
**Given** a Soft Cap service whose only in-window departure is full on raw capacity but has a
flexible margin > 0
**When** the catalog is read
**Then** that departure's date **and time** are returned (effective remaining > 0, US-A36) —
the same arithmetic Scenario 4 asserts for `has_availability`, now also selecting the departure.

#### Scenario 16 — A departure past the sales cutoff is never the answer
**Given** a service whose earliest in-window departure has passed the org's sales cutoff (US-A47)
but still has seats, and a later one that has not
**When** the catalog is read
**Then** the **later** departure's date and time are returned — the cutoff predicate is unchanged
by this amendment and still runs before the remaining-spots test.

#### Scenario 17 — Express eligibility uses the same per-slot test *(D13)*
**Given** a non-zoned service with a sold-out morning departure **today** at `capacity 40 /
booked 43, is_flexible = false` and an afternoon departure today with seats
**When** the catalog is read
**Then** `express_eligible` is `true` — the ⚡ renders, because *some* departure today is
sellable. The old Σ over today reported `false`.

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
- [x] `pnpm --filter api-turistear test` green (317); `pnpm build:app` clean (`tsc -b` + vite).

### Amendment DoD — US-AG56 / BUG-031 (2026-08-21)

- [x] `listPosServices` computes `MIN(date || 'T' || start_time)` over slots filtered by the
      **per-slot** effective-remaining predicate; the `Σ available_spots` column is **deleted**
      (D8, D9).
- [x] `has_availability` is derived as `next_slot_date !== null` — no second query (D9).
- [x] `express_eligible` uses the same per-slot `EXISTS` over today; its Σ is deleted (D13).
- [x] Payload carries `next_slot_time: string | null`, `null` exactly when `next_slot_date` is.
- [x] `PosTourCard.next_slot_time` added; `PosUnitTypeCard.next_slot_time: null` keeps the union
      exhaustive.
- [x] `PosCatalogPage` «Próximo» block renders date over time, raw `HH:MM`, tabular figures.
- [x] `ServiceSheet.tsx` **not modified** — the corrected anchor is a behaviour change with an
      empty diff, recorded in § Frontend rather than in code.
- [x] Scenarios 12–17 covered in `test/pos/pos-catalog-availability.test.ts`; Scenario 17 in
      `test/pos/express-sale.test.ts`.
- [x] The false premise in § API surface is annotated, not silently deleted (`PROCESS.md`
      § Amending a spec).
- [x] `SPEC.md`: US-AG56 story + Features-by-Phase line amended + glossary term.
- [ ] `BUGS.md`: BUG-031 flipped to ✅ FIXED with the merged PR number.
- [x] `TECH_DEBT.md`: the `updateService` negative-remaining hole filed (D14).
- [x] `pnpm --filter api-turistear test` green (**951**, up from 942); `pnpm build:app` clean
      (`tsc -b` + vite). Scenarios 1–11 pass **unedited** — the mechanical proof that US-AG30's
      contract survived. Scenarios 12–14 and the D12 loss were re-run against the restored defect
      and **fail**, so they detect the bug rather than merely describing it.

---

## Decisions — US-AG56 / BUG-031 amendment (2026-08-21)

Numbered from **D7** so they do not collide with the six *Open decisions* below, which this
amendment closes #2 of. Every row is a decision the interview resolved, with the reason that made
it the answer rather than the alternative.

| # | Decision | Why |
|---|---|---|
| **D7** | `next_slot_date` is promoted from *"lightweight UI hint"* to **contract**: the next departure with room, inside the window. | A field the agent quotes to a customer is not a hint. Its "hint" status is precisely why no scenario ever asserted it and why BUG-031 survived two features. |
| **D8** | Ordering is `MIN(date \|\| 'T' \|\| start_time)` — the **(date, time) pair**, not `MIN(date)` then the earliest time of that date. | `MIN(date)` picks the right day and then cannot name a time on it; the pair is the only ordering under which "Tuesday 09:00 sold out → Tuesday 15:00" beats "Wednesday 08:00". The key already exists — `sellableSlotSql` compares departures this way for the sales cutoff. |
| **D9** | `has_availability` ≡ `next_slot_date IS NOT NULL`. The `Σ effective_remaining` query is **deleted**, not fixed. | Two fields answering one question is how they came to disagree. Deriving one from the other makes the contradiction unrepresentable rather than merely untested. Also aligns the card with `listAvailabilityDays` (US-AG35), which was already per-slot. |
| **D10** | Availability means **≥ 1 effective spot**, including the Soft Cap margin — **not** the party size. | The card has no party size; the group is chosen inside the sheet (US-AG32). A card that hides 09:00 because a hypothetical party of 4 would not fit tells a worse lie than one that shows it and lets the sheet filter. Identical threshold to the calendar dots, which is the point of D9. |
| **D11** | "Next available" stays **bounded by the selected window** and never escapes it to find a truly-next departure. | Escaping the window would make `next_slot_date` non-null while `has_availability` is false — reopening D9's contradiction from the other side. Worth stating because the label «Próximo» reads absolute and is not. Note the real default window is `today … coming Sunday` (`defaultWindow`, US-AG55 D15 — formerly `contextPills`), 1–7 days wide, not the 3 days this spec's § API surface still describes — `AVAILABILITY_WINDOW_DAYS` is a server-side fallback the shipped client never triggers. |
| **D12** | A sold-out service loses its «Próximo» block entirely (both fields `null`) rather than gaining a second `next_operating_date` field. | **Named loss.** The card's job is to sell; *Agotado* beside a date the agent cannot sell is the exact confusion being removed. The service's real schedule is one tap away in the sheet, which still renders non-operating and sold-out days per US-AG33. |
| **D13** | `express_eligible` takes the same per-slot `EXISTS` over today. | It carried the identical Σ defect. Leaving it would keep two contradictory definitions of *sellable* in one handler — the condition that produced this bug. |
| **D14** | `updateService` is **not** hardened here against stranding a slot at negative effective remaining. | Separate defect, separate blast radius (it also leaves the slot unsellable-but-scheduled), and the read path must be correct however the write path is later fixed. Deferring is safe because the read no longer *sums*, so a negative slot can only fail to advertise itself — it can no longer suppress a sibling. Filed in `TECH_DEBT.md`. |

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
