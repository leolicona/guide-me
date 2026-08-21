# Feature: The POS filter strip states its scope, and can be returned to it

> Process: `docs/PROCESS.md`. **Status: BUILT.** Refines `docs/pos/date-filter-calendar-sheet.spec.md`
> (US-AG35) and amends its SPEC.md registration to match what actually shipped.
>
> **Amended 2026-08-21 (post-merge of #109).** **D3 is superseded by D14**: the calendar chip's
> resting label adapts to how much of the week is left rather than reading one static string. The
> amendment answers this spec's own *Open* question about Sunday, and closes **TECH_DEBT 26** by
> making the dead `PILL_LABELS` copy live — collapsed into the one function it always served (D15).

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

- **The date ranges must not move.** *(Amended for D15: `dates.test.ts` can no longer pass unedited,
  because the function it names is deleted.)* The replacement boundary is an **equivalence proof**:
  every concrete expected value the `contextPills` suite asserted for index `0` — Mon `2026-08-03`,
  Wed `2026-08-05`, Thu `2026-08-06`, Fri `2026-08-07`, Sun `2026-08-09` — is ported **verbatim** to
  `defaultWindow`, alongside the two 14-day invariants (`from <= to`, and `from === today` on every
  day of the week). Same inputs, same outputs, different function name.
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
| **D3 (superseded by D14)** | ~~The calendar's resting label is **«Esta semana»** — one static string, all seven days.~~ | `contextPills(today)[0]` is **always** `(today, comingSunday)`: both branches compute the same `comingSunday` and only the never-rendered internal key flips `esta_semana`/`este_fin`. So a static label is true every day. The domain already calls this range `esta_semana`. On a Sunday the span collapses to today alone — not a lie: the week has one day left. |
| **D14** | The resting label **adapts to how much of the week the window still covers**: **«Esta semana»** (Mon–Thu) · **«Fin de semana»** (Fri–Sat) · **«Hoy»** (Sun). | D3 was right that the *formula* is identical every day and wrong that the *extent* is: the window is **7 days on a Monday and 1 day on a Sunday**. A static label hides a **7×** variation in what is listed — the very defect this feature exists to fix, reintroduced in miniature. The Mon–Thu / Fri–Sun boundary is inherited unchanged from `contextPills` (`idx <= 3`); only Sunday is a new branch, and there the window genuinely *is* today. «Hoy» is already this product's word for exactly one day (`SlotPicker` relative labels, `DayStrip`'s first pill, the admin nav), so on a Sunday the strip and the sheet's day matrix agree rather than compete. |
| **D15** | `contextPills` collapses into **`defaultWindow(today)`** + **`defaultWindowLabel(today)`**. `PILL_LABELS`, `ContextPillKey`, `ContextPill` and the never-read second pill are deleted. | D14 makes the labels **live**, which is the escape clause TECH_DEBT 26 named. Half-reviving them — live copy beside a zombie two-pill structure branching on the same `mondayIndexOf` — would be the worst state: two weekday branchers, one real. The types had **zero consumers outside `dates.ts`**, and only index `0` was ever read. Labels no longer map to `ContextPillKey` anyway (`este_fin` covered Fri–**Sun**; D14 splits Sunday off), so reusing the keys was never on the table. |
| **D16** | The calendar chip's **accessible name carries the window**: `«Abrir calendario — Esta semana»` / `«— SÁB 14»`. | Same reasoning as D7, now applying to the calendar: a dynamic visible label behind a static `aria-label` means a screen-reader user hears "Abrir calendario" and never learns which window is active. |
| **D17** | Picking today on a **Sunday** is **not** normalised back to the default. | `DayStrip` does normalise (`onSelect(d === today ? null : d)`) because *its* default is always a single day. On `/pos` the default is a window that collapses to one day **only on Sundays**, so normalising would be a special case for one weekday. The ✕ already distinguishes "default" from "explicit pick", which is the distinction that matters — the labels differing («Hoy» vs «DOM 23») is the tell, not a bug. |
| **D18** | Rejected: labelling by **count** («7 días» / «3 días» / «Hoy»). | Maximally honest about extent and useless as an anchor — an agent thinks in "esta semana", not in "5 días". The semantic label plus the ✕'s destination carries the same information in the vocabulary the work already uses. |
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

**S-1 — The default window is named, and the name tracks how much week is left** *(amended, D14)*
Given an agent opens `/pos` with no explicit date selection
Then the category chip reads **«Categorías»**, neither chip renders a ✕, and the calendar chip reads:

| Org-local today | Window | Chip |
|---|---|---|
| Mon–Thu | today → coming Sunday (7…4 days) | **«Esta semana»** |
| Fri–Sat | today → Sunday (3…2 days) | **«Fin de semana»** |
| Sun | today alone (1 day) | **«Hoy»** |

**S-1b — The label changes, the window does not**
Given the same catalog on a Thursday and on a Friday
Then the chip reads «Esta semana» and then «Fin de semana»
And `defaultWindow(d).from === d` on both, with `to` the same coming Sunday — the label tracks the
**extent** of an unchanged formula, never a different query shape.

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

**S-11 — Sunday's default and an explicit Sunday read differently, on purpose** *(D17)*
Given org-local today is a Sunday
Then with no selection the chip reads **«Hoy»** with **no ✕**
And after the agent picks that same Sunday in the calendar it reads **«DOM 23» with a ✕**
And both list the same services — the ✕ is what distinguishes default from explicit pick.

**S-12 — The window is in the accessible name** *(D16)*
Given no explicit selection on a Monday
Then the calendar chip's accessible name is **«Abrir calendario — Esta semana»**
And with `SÁB 14` picked it is **«Abrir calendario — SÁB 14»**.

**S-13 — The collapse moved no dates** *(D15, scope boundary)*
Given the concrete days the retired `contextPills` suite pinned — `2026-08-03` (Mon), `-05` (Wed),
`-06` (Thu), `-07` (Fri), `-09` (Sun)
Then `defaultWindow` returns the `from`/`to` those tests asserted for index `0`, verbatim
And across any 14 consecutive days, `from <= to` and `from === today`.

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

## Definition of Done — amendment (D14–D18)

- [ ] `dates.ts`: `defaultWindow` + `defaultWindowLabel`; `contextPills`, `PILL_LABELS`,
      `ContextPillKey`, `ContextPill` deleted
- [ ] `dates.test.ts`: the equivalence proof (S-13) replaces the `contextPills` suite; new coverage
      for the three labels
- [ ] `PosCatalogPage`: resting label from `defaultWindowLabel`; accessible name carries the window
- [ ] `pnpm build:app` green, `pnpm lint:app` 0 errors, full suite passing
- [ ] `SPEC.md`: US-AG55's line amended; glossary «Default window» updated
- [ ] `TECH_DEBT.md`: entry 26 marked CLOSED

## Definition of Done — as originally shipped (#109)

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

**Amendment (D14):** the resting label is no longer one word all week. An agent who learned
«Esta semana» will see **«Fin de semana»** from Friday and **«Hoy»** on Sunday. Nothing about the
query changes — the same `hoy → domingo` window is requested every day; the label now states how
much of it is left, which on a Sunday is one day. No stored value, price or availability moves.

The dashboard's `DayStrip` (`/`) hosts the same calendar sheet and therefore also gains **«Limpiar»**,
which returns it to **«Hoy»** (D13). That second host was missed locally because the bare
`tsc --noEmit` used to check it is a no-op against a solution-style `tsconfig.json`; `pnpm build:app`
caught both it and an `sx`-array typing fault. Verify this repo's frontend with `pnpm build:app`.

## Open

| Question | Smallest change that answers it |
|---|---|
| Should «Todas» in `PosCategorySheet` close the sheet, like the date sheet's «Limpiar» (D11)? | Add `onClose()` to its `onClear` handler. |
