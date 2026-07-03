# Feature: POS Date Filter — Quick-Day Strip + Calendar Bottom Sheet

## Context

US-AG30 (`docs/pos/default-filtered-catalog.spec.md`) gave the `/pos` catalog a
**Date filter anchored to "Hoy"** that drives a windowed `has_availability` read and
is inherited by the service-detail / Bottom Sheet. Its **Date control UI** was left as
an *open decision* (#4: a "Hoy" chip + a native date input). The interim build shipped
a flat horizontal strip of ~14 day pills plus a native `Elegir fecha` picker.

This feature **replaces that interim control** with the intended, elegant design — and
makes it explicit that **both the agent and the admin-seller** get it on the same
`/pos` surface (the admin sells through the same POS flow, US-A31).

The Date filter becomes two cooperating pieces:

1. **Inline Filter Strip (Categories + Semantic Date)** — a single, horizontally scrollable row that packs the **category chips** and a **dynamic, week-based date filter**, separated by a visual divider `|`, plus a **calendar button**. It adapts intelligently to the day of the week:
   - *Mon-Thu:* `[ Todas ] [ Tours ] ... | [ ESTA SEMANA ] [ ESTE FIN ] [ 🗓️ ]`
   - *Fri-Sun:* `[ Todas ] [ Tours ] ... | [ ESTE FIN ] [ SIG. SEMANA ] [ 🗓️ ]`
   The calendar supports single-day and multi-night **date ranges** (vital for lodging).

2. **Calendar Bottom Sheet** — tapping the calendar button slides up a Bottom Sheet
   (the same overlay+slide-up pattern as US-AG31) holding a **month grid of square day
   chips**. Days that **have sellable availability** are emphasized and selectable;
   past days and days with nothing to sell are muted/disabled. A **month control**
   (`‹ Junio 2026 ›`) pages between months. Picking a day sets the filter, closes the
   sheet, and reflects in the strip.

The catalog still **defaults to the current day** on open — nothing changes about the
default filter or the windowed `has_availability` contract; this is the **selection
UI** for the date that US-AG30 already models (`selectedDate: string | null`).

**User Stories:**

- **US-AG35** *(agent)* — an inline horizontally scrollable strip combining category chips, semantic dynamic date context (`ESTA SEMANA`, `ESTE FIN`, etc.) based on the day of the week, and a calendar Bottom Sheet that supports date ranges for lodging, defaulting to the current contextual week.
- **US-A45** *(admin-seller)* — the **same** Date filter and calendar sheet on `/pos`,
  by virtue of selling through the same POS flow (US-A31). No admin-specific divergence.

**Builds on / refines:**
- `docs/pos/default-filtered-catalog.spec.md` (**US-AG30**) — reuses `selectedDate`
  (the global `store/posFilters.ts` state) and the windowed `has_availability` read
  unchanged. **Supersedes US-AG30 Open decision #4** (Date control UI) and the interim
  14-pill strip.
- `docs/pos/fast-sale-bottom-sheet.spec.md` (**US-AG31**) — reuses the Bottom Sheet
  (`SwipeableDrawer` anchored bottom) pattern for the calendar picker.
- `docs/admin-vendor/admin-vendor-capabilities.spec.md` (**US-A31**) — the admin sells
  through the same POS catalog, so US-A45 is satisfied by the shared component.

**Out of scope (later / own features):**
- A date **range** picker. The filter stays a **single day** (or the "Hoy" anchor),
  per US-AG30.
- Persisting the selected date / visible month across reloads (the filter state is
  in-memory for the session, like the cart).
- Server-side **category** filtering. Category narrowing stays client-side (US-A37).
- Changing the catalog/detail availability **contracts**. Only the date-**selection**
  UI changes; `has_availability` and the detail read are untouched.

---

## Data Model

**No migration.** Availability is derived at query time from existing `slots` /
`services` columns (same effective-remaining math as US-AG30 / US-A36). Nothing new is
persisted.

---

## API surface

### Month availability — `GET /api/pos/availability/days` (**new, lightweight**)

So the calendar can mark *which* days are sellable without pulling slots, a tiny read
returns just the **set of dates that have availability** in a single month. The
**server owns the range** — the caller names a month, not a free `from`/`to` span — so
there is no caller-controlled width to abuse and no arbitrary day-cap to defend.

**Query params**

| Param | Type | Notes |
|---|---|---|
| `month` | `YYYY-MM` (required) | The visible month. The server derives the scan range as `[firstOfMonth, lastOfMonth]` itself (a fixed ≤ 31-day width by construction). Malformed values → `400`. |
| `today` | `YYYY-MM-DD` (optional) | Org-local "today" anchor (existing param). Days before it are never returned — for the current month the effective range floor is `max(firstOfMonth, today)`; a fully-past month yields `[]`. |

**Response** — the dates (ascending) with ≥ 1 **active** slot whose **effective
remaining** (`(capacity − booked) + flexible margin`, US-A36) is `> 0`:

```json
{ "days": ["2026-06-15", "2026-06-16", "2026-06-19", "2026-06-27"] }
```

- **Org-scoped** (Rule: every read filters by `organizationId`). A foreign org's slots
  can never light up a day for this org.
- **Service-agnostic by default** — a day is "available" if **any** active service has
  a sellable slot that day. *(Open decision 2 — scope to the active category chip.)*
- No slot-level or per-service data crosses the wire — only the date strings.
- The query width is bounded **structurally** (one month) rather than by a magic-number
  range cap, so a malformed or hostile request can never force a wide scan.

### Catalog / detail reads — unchanged

`GET /api/pos/services` (US-AG30) and `GET /api/pos/services/:id` keep their contracts.
The picked day still flows through `selectedDate` → `?date=` / `from`/`to` exactly as
US-AG30 specifies.

---

## Frontend

### Global state — unchanged

Still the single `selectedDate: string | null` from `store/posFilters.ts` (US-AG30):
`null` = the "Hoy" anchor (rolling 3-day window); a concrete `YYYY-MM-DD` = that single
day. The **visible month** in the sheet is **local** component state (resets on close).

### Inline Filter Strip (`PosCatalogPage`)

A single `overflow-x: auto` row, separated by a visual divider `|`:

1. **Category Chips** — e.g. `[ Todas ]`, `[ Tours ]`, `[ Aventura ]`. One tap filters the list locally (US-A37). Replaces the old `PosCategorySheet`.
2. **Divider** — `|`
3. **Dynamic Context Pills** — intelligent date range shortcuts that adapt to the current day of the week:
   - **Lunes a Jueves:** `[ ESTA SEMANA ]` (default, from today to Sunday) and `[ ESTE FIN ]` (Friday to Sunday).
   - **Viernes a Domingo:** `[ ESTE FIN ]` (default, today to Sunday) and `[ SIG. SEMANA ]` (next Mon to Sun).
4. **Calendar button** (`🗓️`, `calendar_month`) — opens the **Calendar Bottom Sheet** for precise single-day or **range selection**.

The `selectedDate` state is upgraded from `string | null` to `DateSelection | null`, where `DateSelection = { from: string; to?: string }`.

### Calendar Bottom Sheet (`PosDatePickerSheet`, new)

A `SwipeableDrawer anchor="bottom"` (reusing US-AG31's sheet styling — rounded top,
puller, glass paper) containing:

- **Month header** — `‹  Junio 2026  ›`. The chevrons page the **visible month**;
  the back-chevron is **disabled** for months entirely before `today` (no past paging
  past the current month). *(Open decision 4 — allow viewing past months read-only.)*
- **Weekday header row** — `L M M J V S D` (Monday-first, es-MX).
- **Square day chips** — a 7-column grid of the month's days as **square** cells
  (`aspect-ratio: 1`, rounded `lg`):
  - **Available** (date ∈ the `availability/days` response) → selectable; a small
    accent (Indigo) availability dot; selected day = filled Indigo.
  - **Unavailable** (today-onward, no sellable slot) → visible but **disabled/muted**.
  - **Past** (`< today`) → disabled, faint.
  - **Today** gets a subtle ring even when unselected.
- Tapping an available day sets `selectedDate`, **closes** the sheet, and the strip
  reflects it. A `Hoy` shortcut in the sheet footer clears to `null`.

Availability marks come from **`usePosAvailableDays(month)`** (TanStack Query, `month`
= `YYYY-MM`), keyed on the visible month; it refetches on month change. While loading,
day chips render in a neutral (not-yet-known) state and become enabled as data arrives.

---

## Scenarios

### US-AG35 — Inline Filter Strip (frontend)

#### Scenario 1 — Defaults to current week context (Mon-Thu)
**Given** today is `2026-06-15` (Mon) and the agent opens `/pos`
**Then** the strip shows `[ ESTA SEMANA ]` (active) and `[ ESTE FIN ]` alongside the calendar, and the catalog fetches availability from today to Sunday.

#### Scenario 2 — Defaults to weekend context (Fri-Sun)
**Given** today is `2026-06-19` (Fri)
**Then** the strip reads `[ ESTE FIN ]` (active) and `[ SIG. SEMANA ]`, filtering from today to Sunday.

#### Scenario 3 — Tapping a context pill changes the range
**When** the agent taps `[ ESTE FIN ]` on a Tuesday
**Then** the catalog re-reads with `?from=...&to=...` scoping exactly to Friday-Sunday of the current week.

### US-AG35 — Calendar Bottom Sheet (frontend)

#### Scenario 4 — Opening the calendar
**When** the agent taps the calendar button
**Then** a Bottom Sheet slides up showing the **current month** as a grid of square day
chips with `‹ Mes Año ›` navigation.

#### Scenario 5 — Available days are marked; unavailable/past are disabled
**Given** `GET /api/pos/availability/days?from=…&to=…` returns
`["2026-06-15","2026-06-19","2026-06-27"]`
**Then** only those chips are selectable (with the availability dot); other
today-onward days are muted/disabled, and days `< today` are faint/disabled.

#### Scenario 6 — Picking a day from the calendar
**When** the agent taps `27` (available)
**Then** `selectedDate = 2026-06-27`, the sheet **closes**, the catalog re-reads for
that day, and — since `27` is outside the three strip pills — the **calendar button**
shows the active/selected style with the chosen date (Scenario 3 still governs the
pills).

#### Scenario 7 — Month navigation
**When** the agent taps `›`
**Then** the visible month advances, `usePosAvailableDays` refetches for the new
month's range, and the back-chevron is **disabled** when the visible month is the
current month (no paging into fully-past months).

#### Scenario 8 — "Hoy" shortcut inside the sheet
**When** the agent taps the sheet's **Hoy** shortcut
**Then** `selectedDate = null`, the sheet closes, and the **`HOY`** pill is active.

### US-A45 — Admin parity

#### Scenario 9 — Admin gets the identical control
**Given** an **admin** on `/pos` (selling via US-A31)
**Then** the same quick-day strip and calendar Bottom Sheet render and behave exactly
as for the agent — no admin-only divergence.

### Multitenancy isolation (required — Scenario B4)

#### Scenario 10 — B4: month availability is org-scoped
**Given** `org_a` has a sellable slot on `2026-06-19` and `org_b` has one on
`2026-06-20`
**When** an `org_a` user calls `GET /api/pos/availability/days?month=2026-06`
**Then** `2026-06-19` is returned and `2026-06-20` is **not** — `org_b`'s slot can never
light up a day for `org_a`.

---

## Definition of Done

- [x] `GET /api/pos/availability/days?month=YYYY-MM` returns org-scoped available dates
      within that month (effective remaining > 0, US-A36); the server derives the
      `[firstOfMonth, lastOfMonth]` range itself (no caller-controlled width); never
      returns days `< today`; malformed `month` → `400`. *(+ optional `categories` filter — Open decision 2 alternative, scopes the dots to the active category chips.)*
- [x] Inline filter strip renders horizontally scrollable category chips, a visual divider, and dynamic week-based context pills (`ESTA SEMANA` / `ESTE FIN` / `SIG. SEMANA`) plus a calendar button. State supports date ranges.
- [~] Calendar supports range selection for lodging. **Deviation:** Tours evaluate availability over the **whole selected range** `[from, to]` (per SPEC.md §Inventory "availability window" / US-AG30), **not** the start date only (Option 3). Confirm which reading is intended.
- [x] `PosDatePickerSheet`: Bottom Sheet with a month grid of square day chips, month
      navigation, availability marks from `usePosAvailableDays`, past/unavailable days
      disabled, and a `Hoy` shortcut. Picking a day/range sets the selection and closes.
- [x] The interim 14-pill strip + native `Elegir fecha` picker (and the interim 3-pill quick-day strip + category sheet) are removed.
- [x] Admin and agent render the identical control on `/pos` (US-A45 / US-A31) — one shared component, no role branching.
- [x] Scenarios 5, 10 covered in `test/pos/pos-availability-days.test.ts` (B4 via
      `seedTwoOrgs`). Scenarios 1–9 are frontend behaviours. *(Range window also covered in `pos-catalog-availability.test.ts`.)*
- [x] SPEC.md updated (US-AG35, US-A45, Phase-2 entry, glossary, US-AG30 cross-ref).
- [x] `pnpm --filter api-guideme test` green; `pnpm build:app` clean (`tsc -b` + vite).

---

## Open decisions (defaults chosen — confirm or override)

1. **Quick-day count** — *default:* `HOY` + the **next two** days (3 pills), matching
   the request's examples. *Alternative:* `HOY` + next three (mirrors the 3-day
   availability window's `today … today+2` more literally, i.e. 4 pills).
2. **Month-availability scope** — *default:* **service-agnostic** (a day is available
   if *any* service is sellable that day) and **ignores the "Ocultar agotados"
   toggle** (the calendar always shows true availability). *Alternative:* scope the
   day marks to the **active category chip** (and/or the toggle), so the calendar
   mirrors the current grid filter.
3. **Out-of-strip selection display** — *default:* the **calendar button** takes the
   active style and shows the chosen date. *Alternative:* insert a transient 4th pill
   for the picked day, ahead of the calendar button.
4. **Past months** — *default:* the back-chevron stops at the **current month**
   (no past paging). *Alternative:* allow viewing past months read-only (all days
   disabled).
5. **New endpoint vs. client-only** — *default:* add the lightweight
   `availability/days` read so the calendar can **mark** sellable days. *Alternative:*
   no endpoint — every today-onward day is selectable (no availability marks), letting
   the catalog's own `has_availability` read reveal emptiness after the pick. (Cheaper
   to ship, but loses the "available days" cue the request calls for.)
6. **Week start** — *default:* **Monday-first** (`L M M J V S D`, es-MX convention).
   *Alternative:* Sunday-first.
```
