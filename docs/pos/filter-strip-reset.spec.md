# Feature: The POS filter strip states its scope, and can be returned to it

> Process: `docs/PROCESS.md`. **Status: BUILT.** Refines `docs/pos/date-filter-calendar-sheet.spec.md`
> (US-AG35) and amends its SPEC.md registration to match what actually shipped.

## Context

The `/pos` filter strip has two controls — a category button and a calendar button — and in its
**default state both render as bare icons**. Nothing on screen says what the catalog is showing.

What it is showing is not small. `contextPills(today)[0]` (`features/pos/dates.ts:100`) resolves to
**`hoy → domingo próximo`** — up to **7 days** of inventory. An agent who opens `/pos` on a Monday
is looking at a week of departures and has no way to know it from the screen. On a Sunday the same
window is **1 day**. Same two mute icons, a sevenfold difference in what is listed.

Worse, **the default state is unreachable once left.** `usePosFilters` documents `setSelection(null)`
as *"clear to the default"*, and on `develop` that call has **zero call sites**:

| `setSelection` call site (develop) | Argument |
|---|---|
| `PosCatalogPage.tsx:416` (`onPickDay`) | `{ from: d }` |
| `PosCatalogPage.tsx:420` (`onPickRange`) | `{ from, to }` |

Once an agent picks a day, the only routes back to the week view are a **page reload** (the store is
in-memory) or navigating away and back — neither discoverable, and the second one is a lie in
waiting, because the same store is *inherited by the service-detail view* (US-AG30), so the stale
day silently scopes the drill-in too. `PosDatePickerSheet` is one-way by construction: its footer
holds **`Aplicar`** and nothing else, so an agent who opens the calendar *to undo* their filter finds
the exit behind the sheet they just opened.

Two smaller defects fall out of the same neglect:

- The multi-category chip read **`2 categorías`** — a count with no name. The agent learns how many
  filters are on, never which.
- **US-AG35's registration in `SPEC.md` describes a strip that was never built.** It specifies
  *"category chips, a visual divider, dynamic week-based context pills (`ESTA SEMANA`, `ESTE FIN`,
  `SIG. SEMANA`)"*. None of those render. `PILL_LABELS` (`dates.ts:90`) is referenced only by
  `dates.ts` and `dates.test.ts` — copy that was decided in the model and never reached the view.
  That drift is *why* the default ended up nameless: the labels existed, so the question looked
  answered.

## Scope boundary

This feature must not change what the catalog **requests**, only what it **says**:

- **`app-turistear/src/features/pos/dates.test.ts` must pass unedited.** `contextPills` and its
  ranges are untouched; this feature reads `[0]` exactly as before.
- **With no explicit selection, `usePosServices` receives byte-identical arguments** to develop
  (`today`, `defaultWeek.from`, `defaultWeek.to`). Naming the default must not move the default.
- **No route, handler, schema or migration is touched.** `GET /api/pos/services` and
  `GET /api/pos/availability/days` are untouched.
- **`posPreferences.hideSoldOut` is never written by this feature.** It is a persisted Settings
  preference, not a strip filter (D8).

## Design decisions

| # | Decision | Why |
|---|---|---|
| **D1** | The reset lives **on each chip as a ✕**, not as a third strip-wide "Limpiar" chip. | Each control clears exactly what it set, so scope is never ambiguous; it costs no width on a strip that already scrolls on mobile; it keeps working unchanged when a third filter joins. With at most two filters active, "clear everything" is two taps. |
| **D2** | What gets a name is the **default**, not the reset. | The original brief was "name the reset chip". The real defect is that the *default state* has no representation on screen — a reset button would have given the agent a way out of a state they still could not read. Naming the default makes the strip a sentence at rest and makes the ✕'s destination obvious. |
| **D3** | The calendar's resting label is **«Esta semana»** — one static string, all seven days. | `contextPills(today)[0]` is **always** `(today, comingSunday)`: both branches compute the same `comingSunday` and only the never-rendered internal key flips `esta_semana`/`este_fin`. So a static label is true every day. The domain already calls this range `esta_semana`. On a Sunday the span collapses to today alone — not a lie: the week has one day left. |
| **D4** | Rejected: **«Próximos»**. | Open-ended forward reading, which the bounded `hoy → domingo` window is not; and it collides with **«Próximo»**, already printed on every catalog card for `next_slot_date` — one word, two meanings, 200px apart. |
| **D5** | The category chip's resting label names the **axis** (**«Categorías»**), not the empty state. | **«Todas»** is already the `PosCategorySheet` chip for the empty selection. Reusing it on the strip would give one word two jobs one tap apart. |
| **D6** | Multi-select reads **«Tours +1»**, not «2 categorías»; the first is taken in `SERVICE_CATEGORIES` order, not tap order. | A real name beats a count — the agent reads *what* is filtered, not only how many. Canonical order means the same selection always renders the same label however it was assembled; tap order makes deselect-then-reselect flip the visible name with the set unchanged. |
| **D7** | The `+N` is lossy, so the chip's **accessible name carries the full list** (`"Filtrar por categoría — Tours, Transporte"`). | `aria-label` overrides inner text: left generic, a screen-reader user would never learn which categories are active. Whenever the UI compresses visually, the accessible name must stop being generic or the compression becomes real loss. |
| **D8** | The ✕ clears **date** and **categories** only. `hideSoldOut` is untouched. | It is a persisted preference set in Settings, not a strip filter. Resetting it from the catalog would surprise the agent on a later session, in a screen they never visited. |
| **D9** | The ✕ is a **sibling `<button>`**, never nested in the chip body. The pill's styling moves to a non-interactive container. | A button inside a button is the nesting/a11y fault the ⚡ Express control already avoids on the catalog card (`PosCatalogPage`). Moving the style, not the behaviour, lets both children own real hit areas at the full 48px (brief: *reach & repetition*). |
| **D10** | `PosDatePickerSheet` gains a **«Limpiar»** text button beside `Aplicar`, and **closes** on clear. | Mirrors `FolioStateSheet`'s footer so the app speaks one filter language. Closing mirrors `onPickDay`/`onPickRange`: every footer action that commits a filter change also dismisses, so `Limpiar` is not the one control that leaves the agent staring at a sheet. |
| **D11** | `PosCategorySheet`'s **«Todas» does not close.** | There, clearing is a chip inside a live multi-select (the catalog re-filters behind the sheet; `Listo` dismisses), not a footer action. Closing would break the agent who taps «Todas» to start over and pick a different category immediately. |
| **D13** | The sheet's «Limpiar» returns each **host** to *its own* default, not to a shared one. | `PosDatePickerSheet` has **two** hosts: `/pos` (default = the «Esta semana» window) and the dashboard's `DayStrip` (default = **«Hoy»**, `selected === null`, which its own first pill already sets). Wiring `onClear` per host keeps the sheet ignorant of what "default" means, which is why it can serve both. Found by CI, not by the local build — see *Known behaviour change*. |
| **D12** | The **context pills are not built.** US-AG35's `SPEC.md` line is amended to describe the strip that shipped. | The pills were specified, never rendered, and their absence is what left the default nameless. Naming the default resolves the same need at a fraction of the strip width. `PILL_LABELS` stays in `dates.ts` (its tests assert it) and is logged as debt rather than deleted here, to keep this diff to one idea. |

## Frontend

**New shared primitive — `features/filters/components/ClearableFilterChip.tsx`** (exported from
`features/filters`). A non-interactive `Box` carrying `filterChipSx(active)` with `px: 0` and
`overflow: hidden`, holding two sibling `ButtonBase` children: the body (opens the picker, keeps the
strip's grammar that *an icon here opens a sheet*) and the ✕, mounted only when
`active && onClear`. `clearLabel` names what the ✕ removes; a bare "Limpiar" would leave several
identical buttons for a screen reader.

**`pages/PosCatalogPage.tsx`** — both chips migrate to `ClearableFilterChip`. New module constants
`DEFAULT_RANGE_LABEL` / `DEFAULT_CATEGORY_LABEL` and the `categoryChipLabel()` helper (D3, D5, D6).
The category ✕ calls `setActiveCategories([])`; the calendar ✕ calls `setSelection(null)` — the
first call sites that argument has ever had.

**`features/pos/components/PosDatePickerSheet.tsx`** — a new `onClear` prop; a two-action footer
(`Stack` of text `Limpiar` + contained `Aplicar`), `Limpiar` disabled when there is nothing to undo.
`clear()` resets the local draft, calls `onClear()` and `onClose()`. The draft reset is only for the
closing animation — the sheet re-initialises from props on each open, so without it the grid flashes
the stale days on the way out.

No new state, no new store, no new read. Design system: `.design/design-system/DESIGN_TOKENS.md`.

## Scenarios

### US-AG55 — The strip states its scope and can be returned to it

**S-1 — The default window is named**
Given an agent opens `/pos` with no explicit date selection
Then the calendar chip reads **«Esta semana»** and the category chip reads **«Categorías»**
And neither chip renders a ✕.

**S-2 — Naming the default does not move the default**
Given the same state as S-1
Then `usePosServices` is called with `today`, `defaultWeek.from`, `defaultWeek.to` — unchanged
from before this feature.

**S-3 — A pick replaces the name and reveals the ✕**
Given the agent picks Saturday the 14th
Then the calendar chip reads **«SÁB 14»** and renders a ✕.

**S-4 — The ✕ returns the catalog to the default**
Given an explicit day is selected
When the agent taps the calendar chip's ✕
Then `selection` becomes `null`, the chip reads **«Esta semana»** again, and the service-detail view
inherits "today onward" rather than the abandoned day.

**S-5 — Each ✕ clears only its own axis**
Given both a date and two categories are active
When the agent taps the category ✕
Then the categories clear and **the date selection survives**.

**S-6 — Clearing never touches the sold-out preference**
Given `hideSoldOut` is `true`
When the agent clears either filter, by ✕ or by the sheet's «Limpiar»
Then `posPreferences.hideSoldOut` is still `true`.

**S-7 — Multi-select keeps a name**
Given Tours and Transporte are both active
Then the chip reads **«Tours +1»**, and its accessible name is
**«Filtrar por categoría — Tours, Transporte»**
And the label is identical whichever of the two was tapped first.

**S-8 — The calendar sheet is no longer one-way**
Given an explicit date is selected and the agent opens the calendar sheet
Then the footer offers **«Limpiar»** (enabled)
When they tap it
Then the selection clears **and the sheet closes**, with the strip behind it reading «Esta semana».

**S-9 — The dashboard's day strip clears to its own default**
Given the dashboard's `DayStrip` has an explicit day pinned
When the agent opens its calendar sheet and taps **«Limpiar»**
Then `onSelect(null)` fires — the strip lands back on **«Hoy»**, not on the POS week — and the sheet
closes. The `/pos` filter store is untouched (`DayStrip` never writes it, D5 of the occupancy spec).

**S-10 — «Limpiar» is inert with nothing to undo**
Given no explicit selection
When the agent opens the calendar sheet
Then **«Limpiar»** is disabled.

### Multitenancy isolation

**Not applicable — and deliberately recorded rather than dropped.** This feature adds no route and
no read; it changes labels and client-side state on `/pos`. The catalog and availability reads it
sits on top of are already org-scoped and their isolation tests are unchanged
(`docs/pos/default-filtered-catalog.spec.md`).

## Definition of Done

- [x] `ClearableFilterChip` primitive + `features/filters` export
- [x] Both strip chips migrated; defaults named; `+N` label with a full accessible name
- [x] `PosDatePickerSheet` footer: `Limpiar` + `Aplicar`; clears and closes
- [x] `dates.test.ts` passes unedited (scope boundary) — full app suite: 561 tests, 32 files
- [x] `pnpm build:app` (`tsc -b && vite build`) green — **the only real type check**: `app-turistear/tsconfig.json` is solution-style (`"files": []` + `references`), so a bare `tsc --noEmit` against it checks **zero files** and exits 0
- [x] `pnpm lint:app` reports 0 errors
- [x] `SPEC.md`: US-AG55 story, Features by Phase line, glossary; US-AG35's line amended to the
      strip that shipped (D12)
- [x] `TECH_DEBT.md`: `PILL_LABELS` dead copy (entry 26)

## Deferred — and why each is safe to defer

| What | Why it can wait |
|---|---|
| Deleting `PILL_LABELS` / the unused `este_fin`/`sig_semana` branches of `contextPills` | `dates.test.ts` asserts the labels, so removing them means editing a test this spec's own scope boundary pins. Logged in `TECH_DEBT.md` and removed in its own PR, where the test change is the point rather than collateral. |
| Closing `PosCategorySheet` on «Todas» (D11) | One line whenever the live-multi-select reading is judged wrong. Nothing else depends on the current behaviour. |
| Context pills as real controls (US-AG35 as originally written) | Naming the default answers the same need — "what am I looking at?" — without spending strip width. If ranged browsing later proves common, the pills return as a decided, not a forgotten, feature. |

## Known behaviour change

Agents see **two words that were not there before**: the strip reads «Categorías · Esta semana» at
rest instead of two icons. No request, price, availability or stored value changes. The one
functional gain is that an abandoned date filter is now recoverable in one tap instead of requiring
a page reload — including for the service-detail view that silently inherited it.

The dashboard's `DayStrip` (`/`) hosts the same calendar sheet and therefore also gains **«Limpiar»**,
which returns it to **«Hoy»** (D13). That second host was missed locally because the bare
`tsc --noEmit` used to check it is a no-op against a solution-style `tsconfig.json`; `pnpm build:app`
caught both it and an `sx`-array typing fault. Verify this repo's frontend with `pnpm build:app`.

## Open

| Question | Smallest change that answers it |
|---|---|
| Should «Todas» in `PosCategorySheet` close the sheet, like the date sheet's «Limpiar» (D11)? | Add `onClose()` to its `onClear` handler. |
| Is «Esta semana» right on a Sunday, when the window is one day? | If field use says no, make the label a function of `mondayIndexOf(today)` returning «Hoy» on Sunday — the range stays untouched either way. |
