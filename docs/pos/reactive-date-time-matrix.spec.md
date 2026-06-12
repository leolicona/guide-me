# Feature: Reactive Date & Time Matrix + Flexible-Capacity Visual Warning

## Context

The POS Bottom Sheet (US-AG31) already inherits the catalog's `selectedDate` and renders
a people-first, reactively-filtered slot list (US-AG32) via `SlotPicker`. Two gaps remain
against the agent's mental model of "pick a day, then a time":

1. **The slot list isn't a true day matrix.** Today `SlotPicker` groups whatever slots the
   detail read returns, with **absolute** date headings (`lun, 12 jun 2026`), and a day with
   no slots simply vanishes. When the catalog date is an explicit pick, the sheet shows
   **only that one day** (US-AG31 inheritance scopes `from = to = date`); on the "Hoy"
   anchor it shows **today-onward, unbounded**. Neither matches "show me this day and the
   next two."
2. **The flexible-capacity warning is party-blind.** `SlotPicker` already paints a slot
   orange and labels it "Cupo flexible", but only when the slot is **strictly full**
   (`remaining <= 0`) — independent of how many people the agent picked. It never tells the
   agent "your group of 4 is dipping 1 spot into the cushion."

This feature closes both gaps:

- **US-AG33** — the sheet inherits the catalog date and renders a **3-day matrix**
  (the inherited day + the next two), one **row per day** with a **relative label**
  (`Hoy`, `Sáb`, `Dom`), time-slot chips **flex-wrapping** beside the label, and a muted
  **"Agotado"** state for a day with no available time slots.
- **US-AG34** — when the chosen party size dips into a slot's overbooking cushion
  (`partySize > slot.remaining` yet `partySize <= effectiveRemaining`), the slot chip turns
  **orange** and shows **"Usando X cupos extra"** (`X = partySize − slot.remaining`),
  **without blocking** the add.

**User Stories:** **US-AG33** (reactive 3-day date/time matrix with catalog inheritance),
**US-AG34** (flexible-capacity visual warning — orange state).

**Builds on / refines:**
- `docs/pos/fast-sale-bottom-sheet.spec.md` (US-AG31/AG32) — **refines US-AG31's date
  inheritance**: the sheet's detail read is now scoped to a **3-day window**
  `[anchor, anchor+2]` (`anchor = selectedDate ?? today`) instead of single-day / unbounded.
  Keeps US-AG32's people-first fit filter (`effectiveRemaining ≥ partySize`) — the matrix
  applies it **per day**.
- `docs/pos/default-filtered-catalog.spec.md` (US-AG30) — the 3-day window mirrors the
  catalog's availability window (`AVAILABILITY_WINDOW_DAYS = 2`), so the detail view and the
  catalog read agree on "the next 3 days."
- `docs/catalog/flexible-capacity.spec.md` (US-A36) — `effectiveRemaining` and the
  `slot.max_extra_seats` ⟷ `flexMargin(capacity)` mapping power the orange warning.
  **US-AG34 supersedes** the party-independent flex highlight currently in `SlotPicker`.

**Out of scope (own features / later):**
- **No API change, no migration.** `getPosService` already accepts `from`/`to` and returns
  per-slot `capacity` / `booked` / `remaining` + `is_flexible` / `flex_capacity_pct`. The
  matrix, the relative labels, the sold-out state, and the orange warning are all derived
  client-side.
- A scrollable **week/month** picker or a date *range* inside the sheet. The matrix is
  exactly three days anchored on the inherited date.
- Changing the **catalog** Date filter UI (US-AG30) — only the **sheet's** consumption of
  the inherited date changes.
- Reworking the People counter or the discount/extras/confirm controls (US-AG31/AG32).

---

## Data Model

**No migration. No API change. Frontend-only.** Every field the matrix and the warning need
is already in the `getPosService` payload.

---

## Window & label derivation

The window's **width depends on how the agent set the catalog date** (confirmed): the
default "Hoy" anchor expands to three days; an **explicit single-date pick stays one day**
(a hyper-specific search shouldn't get two extra days of visual noise).

- **"Hoy" anchor (`selectedDate === null`):** day axis = `[today, today+1, today+2]`;
  detail read scoped `from = today`, `to = addDays(today, 2)`.
- **Explicit date (`selectedDate = d`):** day axis = `[d]` (one row); detail read scoped
  `from = to = d` — unchanged from US-AG31.
- This replaces only US-AG31's **"Hoy" unbounded** scoping (now bounded to 3 days, matching
  US-AG30's window); the explicit-date single-day scoping is **retained**.
- **Relative label** for a day `d`: `d === today → "Hoy"`, else the capitalized short
  weekday in `es-MX` (`Sáb`, `Dom`, …), suffixed with the day-of-month for disambiguation
  (`Sáb 14`).

## The `max_extra_seats` mapping (US-AG34)

As in US-AG32, the story's per-slot `max_extra_seats` is the service's flexible margin —
there is **no such field**; the client derives it:

```
max_extra_seats          = flexMargin(capacity) = is_flexible ? floor(capacity × flex_capacity_pct / 100) : 0
effectiveRemaining(slot) = slot.remaining + max_extra_seats           (capacity.ts)

usingCushion(slot, party) = party > slot.remaining && party <= effectiveRemaining(slot)
extraUsed(slot, party)    = party − slot.remaining            // the "X" in "Usando X cupos extra"
```

A Hard Cap slot has `max_extra_seats = 0`, so `usingCushion` is never true — it can only be
shown-normal or (if `party > remaining`) hidden by the US-AG32 fit filter.

---

## Frontend

### `features/pos/components/SlotPicker.tsx` → day matrix (reworked in place)

Single consumer (`ServiceSelectionPanel`), so reworked in place. New/changed props:

```ts
interface SlotPickerProps {
  slots: PosSlot[]            // all slots in the 3-day window (unfiltered by party)
  days: string[]             // the 3 anchor day strings, in order (always rendered)
  today: string              // real org-local today, for the "Hoy" label
  partySize: number          // US-AG34 + US-AG32 — drives per-day fit + the orange warning
  selectedId: string | null
  onSelect: (slot: PosSlot) => void
  isFlexible?: boolean
  flexCapacityPct?: number
}
```

Rendering, **one row per `days` entry** (always three rows):

1. **Day label** = relative label (above). Muted/disabled when the day has **no available
   fitting slot**.
2. **Per-day fitting slots** = `daySlots.filter(s => effectiveRemaining(s,…) >= partySize)`
   (US-AG32 fit filter, applied per day — non-fitting slots stay out of the DOM).
3. If `fitting.length === 0` → render the day label in the disabled state with a trailing
   **"(Agotado)"** and **no chips** (US-AG33). *(Open decision 3 — one "Agotado" state for
   both "all full" and "no schedule that day," vs. a distinct "Sin horarios".)*
4. Else render the fitting slot chips in a **flex-wrap** row beside/under the label:
   - **Orange (US-AG34):** when `usingCushion(slot, partySize)` → warning-toned border +
     text, caption **"Usando {extraUsed} {cupo|cupos} extra"**. Non-blocking: the chip is
     fully selectable.
   - **Normal:** caption shows the time + `{remaining}/{capacity}` (unchanged).
   - **Selected:** secondary accent wins over the orange tone (selection is always legible).

The previous `isFlexZone`-based (party-independent) styling is **removed** — US-AG34's
party-aware `usingCushion` replaces it.

### `features/pos/components/ServiceSelectionPanel.tsx`

- Computes `anchor`, the 3 `days`, and `today`; passes `slots = service.slots`,
  `days`, `today`, and `partySize` to `SlotPicker` (it no longer pre-filters into
  `fittingSlots` — the matrix filters per day, so non-fitting slots are hidden **and** a
  fully-unavailable day still shows its "Agotado" row).
- `maxParty` (the People-counter cap, US-AG32) is unchanged — still the max
  `effectiveRemaining` across all window slots, so at least one slot fits somewhere.
- The old global "No hay horarios para N personas" empty state is removed (superseded by
  the per-day Agotado rows); a guard for a service with **zero** slots in the window remains
  ("No hay horarios disponibles para este servicio.").

### Detail-read range — `ServiceSheet.tsx` and `PosServicePage.tsx`

Both currently build `range = selectedDate ? { from, to: same } : undefined`. Replace with a
shared 3-day window so the sheet and the deep-link page agree:

```ts
const today = todayStr()
const anchor = selectedDate ?? today
const range = { from: anchor, to: addDays(anchor, 2) } // US-AG33 — 3-day window
const { data: service } = usePosService(id, range)
```

A tiny `addDays(date, n)` / `todayStr()` frontend helper mirrors the API's naive-calendar
arithmetic (single-timezone MVP model).

---

## Scenarios

### US-AG33 — Reactive 3-day date/time matrix

#### Scenario 1 — Explicit catalog date shows exactly that one day
**Given** the catalog `selectedDate` is `today + 1` (an explicit pick)
**When** the agent opens a service in the sheet
**Then** `getPosService` is called with `from = to = today+1`, and the matrix shows a
**single** day row for `today + 1` (no extra days appended).

#### Scenario 2 — "Hoy" anchor bounds to three days
**Given** `selectedDate` is `null` (the "Hoy" anchor)
**When** the sheet opens
**Then** the read is scoped `from = today`, `to = today+2` (no longer unbounded), and three
day rows render with the first labelled **Hoy**.

#### Scenario 3 — On the Hoy anchor, all three rows render with relative labels
**Given** the "Hoy" anchor and a service with slots only on `today`
**When** the matrix renders
**Then** all three day rows are present with relative labels (e.g. **Hoy**, **Sáb 14**,
**Dom 15**); the two slot-less days render their label in the disabled **"(Agotado)"**
state.

#### Scenario 4 — Time chips flex-wrap under their day
**Given** a day has more time slots than fit one line
**When** the row renders
**Then** the chips wrap to the next line (flex-wrap) beside/under that day's label, never
overflowing horizontally.

#### Scenario 5 — A day that runs out of fitting slots goes "Agotado"
**Given** the anchor day's only slots can't seat the current party (all effective-full or
too small)
**When** the matrix renders
**Then** that day's label is disabled with **"(Agotado)"** and shows no chips, while the
other days still list their fitting slots.

### US-AG34 — Flexible-capacity visual warning (orange)

#### Scenario 6 — Dipping into the cushion paints the slot orange
**Given** a Soft Cap slot with `remaining = 3` and `max_extra_seats = 2`
(`effectiveRemaining = 5`)
**When** the agent sets the party to **4**
**Then** that slot chip turns orange and shows **"Usando 1 cupo extra"**
(`4 − 3 = 1`).

#### Scenario 7 — Within strict capacity, no warning
**Given** the same slot (`remaining = 3`)
**When** the party is **3** (or less)
**Then** the chip renders in the normal tone with no cushion warning.

#### Scenario 8 — The warning never blocks the sale
**Given** the orange slot from Scenario 6 is shown
**When** the agent selects it and taps *Agregar al carrito*
**Then** the line is staged normally (`quantity = 4`); the orange state is advisory only.

#### Scenario 9 — Full-cushion boundary, then hidden past it
**Given** the slot with `effectiveRemaining = 5`
**When** the party is **5** → the chip is orange **"Usando 2 cupos extra"**; at party **6**
the slot no longer fits and is **hidden** (US-AG32), and its day may fall to "Agotado".

#### Scenario 10 — Hard Cap never shows orange
**Given** a Hard Cap service (`max_extra_seats = 0`)
**When** the agent raises the party
**Then** no slot ever turns orange — a slot is either shown in the normal tone
(`partySize <= remaining`) or hidden once `partySize > remaining`.

---

## Definition of Done

- [x] `ServiceSheet` + `PosServicePage` scope the detail read to `[today, today+2]` on the
      "Hoy" anchor, or `[d, d]` for an explicit date `d` (single day), via a shared
      `addDays` helper (`features/pos/dates.ts`).
- [x] `SlotPicker` reworked into a day matrix: renders one row per `days` entry (3 on the
      Hoy anchor, 1 for an explicit date) with relative labels (`Hoy` / weekday + day-of-month); per-day fit filter
      (`effectiveRemaining ≥ partySize`); flex-wrap chip rows; muted **"(Agotado)"** day
      state when a day has no fitting slot.
- [x] `SlotPicker` slot chip turns orange + shows **"Usando X cupos extra"** when
      `partySize > remaining && partySize <= effectiveRemaining` (`X = partySize − remaining`);
      selectable + non-blocking; selected accent overrides the orange tone.
- [x] Party-independent `isFlexZone` styling removed from `SlotPicker` (superseded).
- [x] `ServiceSelectionPanel` passes `slots` / `days` / `today` / `partySize`; drops the
      pre-`fittingSlots` and the global per-party empty state; keeps `maxParty` and the
      zero-slots guard.
- [x] Scenarios 1–10 are **frontend behaviours** (verified by build/lint); no API
      test (no server change). Existing API tests unaffected (no backend change).
- [x] SPEC.md updated (US-AG33, US-AG34, Phase-2 entry, business rule, glossary) — done.
- [x] `pnpm build:app` (`tsc -b` + vite) clean; `pnpm lint:app` clean (0 errors).

---

## Open decisions (defaults chosen — confirm or override)

1. **"Agotado" semantics under the party filter** — *default:* a day shows **"(Agotado)"**
   whenever it has **no slot that seats the current party** (full *or* too small for the
   group). This makes "sold out" relative to the party — more useful in the field, but a
   day with capacity for a smaller group still reads "Agotado." *Alternative:* "Agotado"
   only when every slot is effective-full (party-independent), and a separate "Sin cupo
   para N" note when the day has availability but not for this group.
2. **Day labels** — *default:* `Hoy` for the real today, otherwise capitalized short
   weekday + day-of-month (`Sáb 14`). *Alternative:* `Hoy` / `Mañana` / weekday, or weekday
   without the day number.
3. **No-schedule vs sold-out** — *default:* one muted **"(Agotado)"** state covers both a
   day with no schedule and a day fully booked. *Alternative:* distinguish **"Sin
   horarios"** (no schedule that day) from **"Agotado"** (booked out).
4. **Cushion-warning copy** — *default:* **"Usando X cupos extra"** (singular "cupo" at
   X = 1). *Alternative:* "X sobre cupo" / "Sobreventa: X".
