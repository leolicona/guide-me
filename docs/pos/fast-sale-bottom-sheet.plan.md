# Implementation Plan — Fast Sale via Bottom Sheet & People-First Reactive Slot Matrix (US-AG31, US-AG32)

> **Spec:** `docs/pos/fast-sale-bottom-sheet.spec.md`
> **Stack (App):** React 18 · MUI v6 · TanStack Query · Zustand
> **Refines:** the POS catalog → service-detail interaction. **Frontend-only — no API,
> no migration.** Reuses `getPosService`, `effectiveRemaining` (US-A36), and the
> `posFilters.selectedDate` inheritance (US-AG30).

This is a **pure re-home + re-order** of the existing `PosServicePage` selection body:
extract it into a shared panel (people-first, reactive slot filter), wrap it in a bottom
sheet, and open that sheet from the catalog instead of navigating. The discount floor,
extras math, `effectiveRemaining` cart cap, and confirm call move **verbatim**.

---

## Phases

```
Phase 1 → Extract ServiceSelectionPanel (re-ordered: people → filtered slots → price/extras → confirm)
Phase 2 → ServiceSheet (SwipeableDrawer + usePosService scoped by selectedDate)
Phase 3 → Wire PosCatalogPage (tap → open sheet, no nav; lift the success Snackbar)
Phase 4 → Reconcile PosServicePage / route (render shared panel, or remove route)
Phase 5 → Review against spec + SPEC checklist; build + lint
```

Phase 1 is the load-bearing extraction; 2–4 consume it. The whole change keeps `tsc -b`
compiling at each phase boundary.

---

## Phase 1 — `ServiceSelectionPanel` (shared body, re-ordered + reactive)

**File:** `app-turistear/src/features/pos/components/ServiceSelectionPanel.tsx` (new).

1. Move the selection JSX + handlers out of `PosServicePage`: `partySize` (was
   `quantity`, default 1), `slot`, `priceInput`, `extraQtys`, `handleAdd`,
   `resetSelection`, the discount validation (`belowMin`/`aboveBase`/`priceInvalid`), and
   the `flexRemaining`/`inFlexZone` derivations.
2. **Re-order** so the People control renders **first** (US-AG32), then the slot matrix,
   then (gated on a selected slot) the price field, extras, and confirm button.
3. **People control:** rename `quantity` → `partySize`; compute
   `maxParty = Math.max(1, ...slots.map(s => effectiveRemaining(s, service.is_flexible,
   service.flex_capacity_pct)))`. `+` disabled at `partySize >= maxParty`; `−` at 1.
4. **Reactive filtered matrix:** derive
   `fittingSlots = service.slots.filter(s => effectiveRemaining(s, …) >= partySize)` and
   pass it to `SlotPicker` (instead of `service.slots`). `SlotPicker` is unchanged.
5. **Selection coherence:** in an effect (or a derived guard at render), if `slot` is set
   but no longer in `fittingSlots`, call `setSlot(null)` (+ reset price/extras) so the
   downstream price/extras/confirm collapse (Scenario 9).
6. **People-before-slot decoupling:** the counter no longer resets to 1 on slot select
   (it is chosen first). When a slot is selected, seed `priceInput` from
   `service.base_price` (as today). On add, `quantity = partySize`,
   `slot.remaining = flexRemaining` (Effective Capacity cap, US-A36) — unchanged.
7. Replace the local snackbar trigger: `handleAdd` calls `onAdded()` after `addLine`
   (the owner closes/snackbars). The panel keeps **no** `Snackbar` of its own.
8. Empty-matrix fallback: when `fittingSlots.length === 0`, render a quiet
   `Typography` ("No hay horarios para {partySize} personas") in place of the picker.

Props: `{ service: PosServiceDetail; onAdded: () => void }`.

## Phase 2 — `ServiceSheet` (bottom sheet)

**File:** `app-turistear/src/features/pos/components/ServiceSheet.tsx` (new).

1. Props `{ serviceId: string | null; onClose: () => void; onAdded: () => void }`.
2. Derive the detail range from the global store (mirror `PosServicePage` today):
   ```ts
   const selectedDate = usePosFilters((s) => s.selectedDate)
   const range = selectedDate ? { from: selectedDate, to: selectedDate } : undefined
   const { data: service, isLoading, isError } = usePosService(serviceId ?? undefined, range)
   ```
   Ensure `usePosService` is disabled when `serviceId` is null (guard the hook's
   `enabled` on a truthy id so a closed sheet does not fetch).
3. **`SwipeableDrawer anchor="bottom"`**, `open={serviceId !== null}`, `onClose`,
   `onOpen` no-op. Paper sx: `borderTopLeftRadius: 16, borderTopRightRadius: 16,
   maxHeight: '85vh', overflowY: 'auto'`, comfortable padding; a small puller Box.
   `disableSwipeToOpen`.
4. Body: header (service name + close `IconButton`), then spinner while `isLoading`,
   error `Alert` on `isError`, else `<ServiceSelectionPanel service={service}
   onAdded={onAdded} />`.

> Verify MUI's `SwipeableDrawer` is acceptable on the targeted devices; if the swipe
> backdrop transition feels heavy, fall back to plain `Drawer` (open decision 1) — the
> props are nearly identical.

## Phase 3 — Wire `PosCatalogPage`

**File:** `app-turistear/src/pages/PosCatalogPage.tsx`.

1. Add `const [openServiceId, setOpenServiceId] = useState<string | null>(null)` and
   `const [added, setAdded] = useState(false)`.
2. Card `CardActionArea onClick`: replace `navigate(ROUTES.POS_SERVICE.replace(...))`
   with `setOpenServiceId(service.id)` (catalog stays mounted; scroll + chips preserved).
3. Render at the end of the page:
   ```tsx
   <ServiceSheet
     serviceId={openServiceId}
     onClose={() => setOpenServiceId(null)}
     onAdded={() => { setOpenServiceId(null); setAdded(true) }}
   />
   ```
4. **Lift the success Snackbar** from `PosServicePage` to here (the exact `Snackbar` +
   filled success `Alert` + *Ver carrito* → `navigate(ROUTES.POS_CHECKOUT)`), driven by
   `added`. `useNavigate` is already imported.
5. Drop now-unused imports if the card no longer needs `navigate` for service routing
   (it still needs it for the snackbar action).

## Phase 4 — Reconcile `PosServicePage` / route

**File:** `app-turistear/src/pages/PosServicePage.tsx` *(open decision 2)*.

- **Default (keep route):** strip the inlined selection body and instead render
  `<ServiceSelectionPanel service={service} onAdded={() => setAdded(true)} />` inside the
  existing page `Card`, keeping the page's own header/back-button and its own Snackbar.
  This removes the duplicated logic while preserving deep-link / browser-back support.
- **Alternative (remove route):** delete `PosServicePage`, drop `ROUTES.POS_SERVICE` and
  its `<Route>` registration, and remove the import. Only choose this if deep-linking to a
  service is explicitly unwanted.

Either way: **no selection logic lives in two places** after this phase.

## Phase 5 — Review

- Walk spec Scenarios 1–11; confirm each as a frontend behaviour.
- Confirm tap-to-open keeps the catalog mounted (scroll/filter/chip state intact).
- Confirm people-first ordering, reactive hide-from-DOM filtering, `maxParty` cap, and
  selection-clear-on-grow.
- Confirm Soft Cap margin counts via `effectiveRemaining` (Scenario 8) and the cart line
  carries `quantity = partySize` (Scenario 11).
- Confirm `selectedDate` inheritance (Scenario 5) still scopes the sheet's detail read.
- Confirm the success Snackbar fires from the catalog and *Ver carrito* → checkout.
- Gates: `pnpm build:app` (`tsc -b` + vite) clean; `pnpm lint:app` clean.
- Tick the SPEC Phase-2 entry **Fast Sale via Bottom Sheet** *(US-AG31, US-AG32)*.

---

## Checklist

### Components
- [x] `features/pos/components/ServiceSelectionPanel.tsx` — people-first, reactive
      `effectiveRemaining >= partySize` filter, `maxParty` cap, selection-clear-on-grow,
      `onAdded` callback; discount/extras/confirm lifted verbatim
- [x] `features/pos/components/ServiceSheet.tsx` — `SwipeableDrawer` bottom, scoped
      `usePosService` (disabled when closed), spinner/error/panel, ≈85vh scroll

### Pages / routing
- [x] `PosCatalogPage` — card tap → `setOpenServiceId` (no nav); render `ServiceSheet`;
      lifted success Snackbar with *Ver carrito*
- [x] `PosServicePage` — renders shared `ServiceSelectionPanel` (route kept per open
      decision 2); no duplicated selection logic

### Docs
- [x] `docs/SPEC.md` — US-AG31 + US-AG32 + Phase-2 entry + glossary (done)
- [x] Spec DoD ticked in `docs/pos/fast-sale-bottom-sheet.spec.md`

### Gates
- [x] `pnpm build:app` clean · `pnpm lint:app` clean (0 errors) · API tests unaffected (no backend change)
