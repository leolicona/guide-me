# Implementation Plan — Reactive Date & Time Matrix + Flexible-Capacity Visual Warning (US-AG33, US-AG34)

> **Spec:** `docs/pos/reactive-date-time-matrix.spec.md`
> **Stack (App):** React 18 · MUI v6 · TanStack Query · Zustand
> **Refines:** the POS Bottom Sheet (US-AG31/AG32). **Frontend-only — no API, no
> migration.** Reuses `getPosService` (`from`/`to`), `effectiveRemaining` / `flexMargin`
> (US-A36), and the `posFilters.selectedDate` inheritance (US-AG30).

Two tightly-coupled frontend changes: (a) scope the sheet's detail read to a **3-day
window** and turn `SlotPicker` into a **3-row day matrix** with relative labels + sold-out
states (US-AG33); (b) make the per-slot flexible-capacity highlight **party-aware** (orange
"Usando X cupos extra", US-AG34), replacing the current party-blind `isFlexZone` style.

---

## Phases

```
Phase 1 → Date helper + 3-day window in ServiceSheet & PosServicePage
Phase 2 → Rework SlotPicker → 3-day matrix (rows, relative labels, Agotado, flex-wrap) + party-aware orange
Phase 3 → ServiceSelectionPanel: pass slots/days/today/partySize; drop pre-filter + global empty state
Phase 4 → Build + lint + scenario walk + SPEC checklist
```

Phase 2 is the load-bearing rework; Phases 1 & 3 feed it the window + props.

---

## Phase 1 — 3-day window scoping

**Files:** `app-turistear/src/features/pos/components/ServiceSheet.tsx`,
`app-turistear/src/pages/PosServicePage.tsx`, + a small date helper.

1. Add a shared frontend date helper (e.g. `features/pos/dates.ts` or extend an existing
   util): `todayStr()` (already inline in `PosCatalogPage` — lift it) and
   `addDays(date, n)` mirroring the API's `Date.UTC + slice` arithmetic.
2. In both `ServiceSheet` and `PosServicePage`, replace the `range` + day-axis derivation.
   **Explicit date stays one day; only the "Hoy" anchor expands to three** (confirmed):
   ```ts
   const today = todayStr()
   const days = selectedDate ? [selectedDate] : [today, addDays(today, 1), addDays(today, 2)]
   const range = { from: days[0], to: days[days.length - 1] } // [d,d] explicit · [today,today+2] Hoy
   const { data: service } = usePosService(id, range)
   ```
   Thread `days` + `today` into `ServiceSelectionPanel`. The `usePosService` query key
   already includes `range`, so changing the anchor refetches.

## Phase 2 — `SlotPicker` → 3-day matrix + party-aware orange

**File:** `app-turistear/src/features/pos/components/SlotPicker.tsx`.

1. **Props:** add `days: string[]`, `today: string`, `partySize: number`. Keep `slots`,
   `selectedId`, `onSelect`, `isFlexible`, `flexCapacityPct`.
2. **Relative label** helper: `d === today → "Hoy"`, else
   `new Date(d+'T00:00:00').toLocaleDateString('es-MX',{weekday:'short'})` capitalized +
   day-of-month (`Sáb 14`).
3. **Render one row per `days` entry** (3 on the Hoy anchor, 1 for an explicit date), in order:
   - `daySlots = slots.filter(s => s.date === d)` (already time-ordered from the read).
   - `fitting = daySlots.filter(s => effectiveRemaining(s, isFlexible, flexCapacityPct) >= partySize)`.
   - `fitting.length === 0` → label in disabled tone + trailing **"(Agotado)"**, no chips.
   - else → label + a **flex-wrap** `Box` of chips.
4. **Per-chip styling:**
   - `cushion = partySize > slot.remaining && partySize <= effectiveRemaining(slot,…)` →
     `warning.main` border/text + caption **`Usando ${partySize - slot.remaining} ${n===1?'cupo':'cupos'} extra`**.
   - normal → existing `{remaining}/{capacity} disponibles` caption.
   - `selected` (secondary accent) overrides the cushion tone.
   - Chips stay `ButtonBase` + `onSelect`; **none are disabled** for fit (non-fitting are
     filtered out, not disabled — US-AG32).
5. **Remove** the old `isFlexZone` import/branch (party-independent) — superseded by
   `cushion`. Keep `effectiveRemaining`.

## Phase 3 — `ServiceSelectionPanel` wiring

**File:** `app-turistear/src/features/pos/components/ServiceSelectionPanel.tsx`.

The day axis can't be derived from the loaded slots (a sold-out day has none), so the
owner computes it (Phase 1) and threads it down:

1. Add props `days: string[]` + `today: string` to `ServiceSelectionPanel`, supplied by
   `ServiceSheet` / `PosServicePage`.
2. Pass to `SlotPicker`: `slots={service.slots}`, `days`, `today`, `partySize`,
   `selectedId`, `onSelect`, `isFlexible`, `flexCapacityPct`.
3. Remove the `fittingSlots` `useMemo` and the global "No hay horarios para N personas"
   branch (per-day Agotado covers it). Keep `maxParty` (counter cap) and add a guard: if
   `service.slots.length === 0`, render "No hay horarios disponibles para este servicio."
4. `incrementParty`'s clear-selection-on-grow stays (selected slot dropping below fit).

## Phase 4 — Review

- Walk spec Scenarios 1–10 (frontend behaviours).
- Confirm the read is scoped `[anchor, anchor+2]` for both explicit dates and "Hoy".
- Confirm three rows always render, relative labels, flex-wrap, per-day "(Agotado)".
- Confirm orange `usingCushion` + "Usando X cupos extra" + non-blocking add; Hard Cap never
  orange; selected accent overrides orange.
- Confirm `maxParty` cap + clear-on-grow unregressed; zero-slots guard.
- Gates: `pnpm build:app` (`tsc -b` + vite) clean; `pnpm lint:app` clean.
- Tick the SPEC Phase-2 entry **Reactive Date & Time Matrix** *(US-AG33, US-AG34)*.

---

## Checklist

### Components / pages
- [x] `features/pos/dates.ts` — `todayStr()` + `addDays(date, n)`
- [x] `ServiceSheet` + `PosServicePage` — detail read scoped to `[today, today+2]` (Hoy) or
      `[d, d]` (explicit date); thread `days` + `today` into the panel
- [x] `SlotPicker` — day matrix (rows, relative labels, "(Agotado)", flex-wrap) +
      party-aware orange "Usando X cupos extra"; `isFlexZone` styling removed
- [x] `ServiceSelectionPanel` — pass `slots`/`days`/`today`/`partySize`; drop pre-filter +
      global empty state; keep `maxParty` + zero-slots guard

### Docs
- [x] `docs/SPEC.md` — US-AG33 + US-AG34 + Phase-2 entry + business rule + glossary (done)
- [x] Spec DoD ticked in `docs/pos/reactive-date-time-matrix.spec.md`

### Gates
- [x] `pnpm build:app` clean · `pnpm lint:app` clean (0 errors) · API tests unaffected (no backend change)
