# Feature: Fast Sale via Bottom Sheet & People-First Reactive Slot Matrix

## Context

Today, an agent on the POS catalog (`PosCatalogPage`) taps a service card and
**navigates** to a separate full-page route (`/pos/service/:id`, `PosServicePage`).
That page loads the service detail (slots + extras) and presents the selection
interface in this order: **slot picker first**, then — only after a slot is chosen —
the People counter, the discount field, the extras, and the *Agregar al carrito*
button. Adding fires a success `Snackbar` with a *Ver carrito* action.

Two problems for a field agent making rapid, repeated sales:

1. **The full-page navigation tears down the catalog.** The agent loses their scroll
   position, their category/date filter context, and the sense of "where I was" in the
   list. Every sale is a round-trip.
2. **Slot-before-people is the wrong order for groups.** The agent must eyeball each
   slot's remaining count and mentally check "does my group of 6 fit?" The system
   knows the answer and should filter for them.

This feature delivers both stories:

- **US-AG31** — tapping a service card opens an animated **Bottom Sheet** (overlay +
  slide-up) carrying the selection interface, **without leaving the catalog**. On a
  successful *Agregar al carrito* the sheet slides down (closes) automatically and a
  floating **Snackbar** ("Agregado al carrito · Ver carrito") returns control of the
  catalog to the agent instantly.
- **US-AG32** — inside the sheet the **People control `[ − 1 + ]`** is the **first**
  interactive element. As the agent changes the party size, the time-slot matrix
  **filters synchronously**, hiding from the DOM every slot that cannot seat the whole
  group, so the agent only ever picks a slot that fits.

**User Stories:** **US-AG31** (fast sale via bottom sheet), **US-AG32** (people-first
reactive slot filter).

**Builds on / refines:**
- `docs/pos/pos-controlled-discount.spec.md` — the POS service-detail read
  (`getPosService`) and the selection interface (People counter, discount field with
  the `minimum_price` floor, extras, confirm) this feature **re-homes** into a sheet.
  The discount/extras/confirm logic is unchanged; only the **container** and the
  **ordering** change.
- `docs/pos/default-filtered-catalog.spec.md` (US-AG30) — the sheet **inherits the
  catalog's `selectedDate`** (the `posFilters` store) into the detail read's `from`/`to`
  exactly as `PosServicePage` does today, so the sheet shows the same day context the
  agent filtered the catalog to.
- `docs/catalog/flexible-capacity.spec.md` (US-A36) — the story's
  `slot.remaining + slot.max_extra_seats >= partySize` fit test maps **exactly** onto
  the existing `effectiveRemaining(slot, is_flexible, flex_capacity_pct) >= partySize`
  (`effectiveRemaining = remaining + flexMargin`, see § "The `max_extra_seats` mapping").

**Out of scope (own features / later):**
- **No API change.** The detail read already returns each slot's `capacity` / `booked`
  / `remaining` and the service's `is_flexible` / `flex_capacity_pct`; the fit filter is
  computed entirely client-side. The catalog list stays lightweight (US-AG30) — the
  sheet, like the page before it, fetches the detail on open.
- The **checkout / confirm-sale** flow (`/pos/checkout`, customer fields, payment
  method, folio generation) is untouched. *Agregar al carrito* still only stages a cart
  line; the agent finishes the sale on the checkout screen as today.
- **Multi-slot selection** in one sheet (adding several slots before closing). The sheet
  closes on the first successful add, matching the story ("the panel must slide down
  automatically"). The agent re-taps the card for another line.
- Swipe-gesture fine-tuning / drag-to-resize heights. A single comfortable sheet height
  with internal scroll is in scope; a draggable multi-detent sheet is not.

---

## Data Model

**No migration. No API change.** This feature is **frontend-only**. Every field it
needs — slot `capacity` / `booked` / `remaining`, service `is_flexible` /
`flex_capacity_pct` / `extras` / `minimum_price` / `base_price` — is already in the
`getPosService` payload consumed by `PosServicePage` today.

---

## The `max_extra_seats` mapping

The story phrases the fit test as `slot.remaining + slot.max_extra_seats >= partySize`.
The GuideMe payload has **no per-slot `max_extra_seats` field**; the overbooking margin
lives on the **service** as `is_flexible` + `flex_capacity_pct` (US-A36), and the client
already derives the per-slot margin in `features/pos/capacity.ts`:

```
flexMargin(capacity)      = is_flexible ? floor(capacity × flex_capacity_pct / 100) : 0   // = "max_extra_seats"
effectiveRemaining(slot)  = (capacity − booked) + flexMargin(capacity)
                          = slot.remaining + flexMargin(capacity)
                          = slot.remaining + slot.max_extra_seats     ✓ (identical)
```

So the story's filter is implemented as the existing, server-mirrored
`effectiveRemaining(slot, is_flexible, flex_capacity_pct) >= partySize` — **no new
math, no new field**. A Hard Cap service has `flexMargin = 0`, so the test degrades to
`slot.remaining >= partySize`, exactly as a strict-capacity reading expects.

---

## Frontend

### New shared component — `features/pos/components/ServiceSelectionPanel.tsx`

Extract the selection **body** currently inlined in `PosServicePage` into a presentational
panel, re-ordered **people → slots → price/extras → confirm**, so it can render inside the
bottom sheet (and, if the route is retained, inside the page). Props:

```ts
interface ServiceSelectionPanelProps {
  service: PosServiceDetail
  onAdded: () => void   // fired after a successful addLine — the sheet uses it to close + snackbar
}
```

Internal order and behaviour:

1. **People control `[ − 1 + ]`** — the **first** interactive element (US-AG32). Local
   `partySize` state, default **1**, minimum **1**. The `+` is capped at
   **`maxParty`** = the largest `effectiveRemaining` across the service's loaded slots
   (so the agent can never request a group no slot in the window can seat); `−` is
   disabled at 1.
2. **Reactive time-slot matrix** — `SlotPicker` fed a **filtered** slot list:
   `slots.filter(s => effectiveRemaining(s, …) >= partySize)`. Slots that do not fit are
   **removed from the array** (hidden from the DOM, US-AG32), not merely disabled.
   - Changing `partySize` re-derives the list synchronously (pure render; no fetch).
   - If the **currently selected** slot drops out of the filtered set (party grew past
     its capacity), the selection is **cleared** so the agent re-picks a fitting slot.
   - When the filtered set is empty, show a quiet inline empty-state ("No hay horarios
     para N personas"). *(With `maxParty` capping the counter this is unreachable in the
     happy path; it is a defensive fallback.)*
3. **Discount price field** — unchanged from today: clamped to
   `[minimum_price, base_price]`, inline helper text, shown once a slot is selected.
4. **Extras** — unchanged stepper list, shown once a slot is selected.
5. **`Agregar al carrito`** — unchanged `addLine` call (passes `quantity = partySize`,
   `slot.remaining = effectiveRemaining` so the cart's soft-cap is the Effective
   Capacity, US-A36). On success it calls `onAdded()` instead of toggling a local
   snackbar — the **owner** (sheet) decides what happens next.

> The discount-floor enforcement, extras math, and `effectiveRemaining` cart cap are
> **lifted verbatim** from `PosServicePage`; this feature only re-orders and re-homes them.

### New component — `features/pos/components/ServiceSheet.tsx`

A bottom sheet wrapping `ServiceSelectionPanel`:

- MUI **`SwipeableDrawer` `anchor="bottom"`** (mobile-first: swipe-down to dismiss; on
  desktop the backdrop click / a close affordance dismisses). Rounded top corners
  (`borderTopLeftRadius`/`Right` 16px), a small grab "puller", elevation kept minimal
  per the elegant-minimalist system; the backdrop provides the **overlay darken**
  (US-AG31) and the drawer provides the **slide-up animation**. *(Open decision 1 —
  `SwipeableDrawer` vs plain `Drawer`.)*
- Props: `serviceId: string | null` (null ⇒ closed), `onClose: () => void`,
  `onAdded: () => void`.
- On open (`serviceId` non-null) it runs `usePosService(serviceId, range)` where `range`
  is derived from the global `posFilters.selectedDate` — **identical** to how
  `PosServicePage` scopes the detail today (US-AG30 inheritance). Shows a spinner while
  loading, an error alert on failure, and `ServiceSelectionPanel` once the detail
  arrives.
- The sheet content is internally scrollable with a capped max height (≈ 85vh) so a
  long extras list never pushes the People control / confirm off-screen.

### `pages/PosCatalogPage.tsx`

- Card tap **no longer navigates**. `CardActionArea onClick` sets local
  `openServiceId` state instead of `navigate(POS_SERVICE…)`, so the catalog stays
  mounted underneath the sheet (scroll, filters, and chip state preserved — US-AG31's
  "keeping the rest of the catalog in view").
- Render `<ServiceSheet serviceId={openServiceId} onClose={() => setOpenServiceId(null)}
  onAdded={handleAdded} />`.
- **`handleAdded`** closes the sheet (`setOpenServiceId(null)`) and opens the success
  `Snackbar` — the snackbar is **lifted to the catalog page** (from `PosServicePage`) so
  it survives the sheet unmounting and floats over the catalog with a *Ver carrito*
  action routing to `/pos/checkout`.

### Route `/pos/service/:id` (`PosServicePage`)

*(Open decision 2.)* **Default:** keep the route and rewrite `PosServicePage` to render
the shared `ServiceSelectionPanel` in a full-page `Card` (reusing the extracted body),
so deep links / browser-back / no-sheet contexts still work and there is **one** source
of selection logic. The catalog's primary path is the sheet; the page is a thin
fallback. *(Alternative: remove the route entirely and rely solely on the sheet.)*

---

## Scenarios

### US-AG31 — Fast sale via bottom sheet

#### Scenario 1 — Tapping a card opens the sheet over the catalog
**Given** the agent is on the POS catalog with services listed
**When** they tap a service card
**Then** the background dims (overlay) and a panel slides up from the bottom carrying
the selection interface; the catalog remains mounted beneath (no route change, scroll
and filter chips preserved).

#### Scenario 2 — Successful add closes the sheet and fires the snackbar
**Given** the sheet is open with a slot selected and a valid price
**When** the agent taps *Agregar al carrito*
**Then** the line is staged in the cart, the sheet slides down and closes automatically,
and a floating Snackbar "Agregado al carrito" with a *Ver carrito* action appears over
the catalog.

#### Scenario 3 — Ver carrito routes to checkout
**Given** the success Snackbar is showing
**When** the agent taps *Ver carrito*
**Then** they navigate to `/pos/checkout` with the staged line(s) in the cart.

#### Scenario 4 — Dismissing without adding
**Given** the sheet is open
**When** the agent swipes it down / taps the backdrop
**Then** the sheet closes, **no** cart line is added, and the catalog is unchanged.

#### Scenario 5 — Day context is inherited
**Given** the agent filtered the catalog to `today + 1` (US-AG30)
**When** they open a service in the sheet
**Then** the sheet's slot matrix shows that day's slots (the detail read is scoped
`from = to = today+1`), matching the catalog's date context.

### US-AG32 — People-first reactive slot filter

#### Scenario 6 — People control is the first element
**Given** the sheet has opened for a service
**When** it renders
**Then** the `[ − 1 + ]` People control is the first interactive element, above the
time-slot matrix, defaulting to **1**.

#### Scenario 7 — Increasing the party hides slots that no longer fit
**Given** slot A has effective remaining 2 and slot B has effective remaining 8
**When** the agent sets the party size to 5
**Then** slot A is **removed from the DOM** and only slot B remains selectable; lowering
the party back to 2 brings slot A back.

#### Scenario 8 — Soft Cap margin counts toward the fit
**Given** a Soft Cap slot with raw `remaining` 4 and a flexible margin of 2
(`effectiveRemaining` = 6)
**When** the agent sets the party size to 6
**Then** the slot still shows (6 ≥ 6), matching US-A36; at party 7 it is hidden.

#### Scenario 9 — Selecting then growing the party past the slot clears the selection
**Given** the agent selected slot A (effective remaining 3) at party 2
**When** they raise the party to 4
**Then** slot A disappears from the matrix and the prior selection is cleared (price /
extras / confirm collapse until a fitting slot is picked).

#### Scenario 10 — The People counter cannot exceed any slot's capacity
**Given** the service's largest in-window slot has effective remaining 8
**When** the agent holds the `+`
**Then** the counter stops at 8 (`maxParty`), so at least one slot always fits; the
empty-matrix state is never reached in the happy path.

#### Scenario 11 — Quantity carries to the cart
**Given** the agent set the party to 5 and selected a fitting slot
**When** they tap *Agregar al carrito*
**Then** the staged cart line has `quantity = 5` (no re-entry of the count), priced at
the (possibly discounted) unit price.

---

## Definition of Done

- [x] `features/pos/components/ServiceSelectionPanel.tsx` — shared selection body,
      re-ordered **people → filtered slots → price/extras → confirm**; party-size cap =
      `maxParty` (max `effectiveRemaining` across slots); slot list filtered by
      `effectiveRemaining(slot) >= partySize`; selection cleared when the chosen slot
      drops out (in the increment handler, not an effect); `onAdded` fired after `addLine`.
- [x] `features/pos/components/ServiceSheet.tsx` — `SwipeableDrawer anchor="bottom"`,
      overlay + slide-up, internal scroll capped ≈ 85vh; loads `usePosService` scoped by
      the inherited `selectedDate`; shows spinner/error/panel.
- [x] `pages/PosCatalogPage.tsx` — card tap sets `openServiceId` (no navigation);
      renders `ServiceSheet`; the success Snackbar (with *Ver carrito*) is lifted here
      and fires on `onAdded`.
- [x] `pages/PosServicePage.tsx` — kept the route (open decision 2 default), rewritten to
      render `ServiceSelectionPanel` in a page `Card`; **no duplicated selection logic**.
- [x] `SlotPicker` consumes the pre-filtered slot list unchanged (full-but-fitting slots
      may still be styled by its existing flex-zone logic; non-fitting slots never reach
      it).
- [x] Scenarios 1–11 are **frontend behaviours** (verified by build/lint); no API
      test (no server change). Existing API tests unaffected (no backend change).
- [x] SPEC.md updated (US-AG31, US-AG32, Phase-2 entry, glossary) — done.
- [x] `pnpm build:app` (`tsc -b` + vite) clean; `pnpm lint:app` clean (0 errors).

---

## Open decisions (defaults chosen — confirm or override)

1. **Sheet mechanism** — *default:* MUI `SwipeableDrawer anchor="bottom"` (swipe-to-close,
   mobile-first) with a grab puller. *Alternative:* plain `Drawer anchor="bottom"`
   (backdrop/close-button dismiss only, no swipe).
2. **Keep the `/pos/service/:id` route?** — *default:* keep it, rewired to render the
   shared `ServiceSelectionPanel` full-page (deep-link / fallback; single source of
   logic). *Alternative:* remove the route and make the sheet the only path to a service.
3. **People-counter upper bound** — *default:* cap `+` at `maxParty` (max effective
   remaining across the service's in-window slots), guaranteeing ≥ 1 fitting slot.
   *Alternative:* leave `+` unbounded and rely on the empty-matrix state when the group
   fits nowhere.
4. **Non-fitting slots: hide vs disable** — *default:* **hide** (remove from the DOM), as
   US-AG32 states literally. *Alternative:* keep them visible but disabled/greyed (more
   context, but contradicts the story's wording).
5. **Close on add: single-line vs keep-open** — *default:* close on the first successful
   add (story-mandated "slide down automatically"); a second line means re-tapping the
   card. *Alternative:* keep the sheet open to stage multiple slots before closing (out
   of scope here).
