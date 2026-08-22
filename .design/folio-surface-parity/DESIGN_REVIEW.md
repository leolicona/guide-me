# Design Review: Folio Surface Parity (`/folios` + `/history`)

Reviewed against: `.design/design-system/DESIGN_BRIEF.md` + `DESIGN_TOKENS.md`, and
`docs/oversight/folio-surface-parity.spec.md` (US-AG58 · US-AG59 · US-A93 · US-UX07)
Philosophy: **Elegant Field Minimalism** — legible in sunlight · one confident accent · reach & repetition
Date: 2026-08-22
Build reviewed: `feat/venta-vocabulary` (PRs #126–#128 merged, #129 open), seeded local DB

## Screenshots Captured

| Screenshot | Breakpoint | Description |
|---|---|---|
| `screenshots/review-list-admin-desktop-1280.png` | Desktop 1280×800 | Admin *Ventas* list, rail nav, pending-work bar |
| `screenshots/review-list-admin-tablet-768.png` | Tablet 768×1024 | Admin list, all five pending-work pills visible |
| `screenshots/review-list-admin-mobile-375.png` | Mobile 375×812 | Admin list, pills scrolling inside `FilterStrip` |
| `screenshots/review-list-seller-desktop-1280.png` | Desktop 1280×800 | Seller list — same chassis, no pending-work bar |
| `screenshots/review-list-seller-tablet-768.png` | Tablet 768×1024 | Seller list |
| `screenshots/review-list-seller-mobile-375.png` | Mobile 375×812 | Seller list incl. the 200-day-old sale (no window) |
| `screenshots/review-list-seller-empty-filter-mobile-375.png` | Mobile 375×812 | Empty state naming «zzz» · Cancelado + *Quitar filtros* |
| `screenshots/review-detail-admin-desktop-1280.png` | Desktop 1280×800 | Admin detail, QR collapsed |
| `screenshots/review-detail-admin-mobile-375.png` | Mobile 375×812 | Admin detail with *Cancelar venta* |
| `screenshots/review-detail-seller-desktop-1280.png` | Desktop 1280×800 | Seller detail, QR expanded |
| `screenshots/review-detail-seller-mobile-375.png` | Mobile 375×812 | Seller detail — same anatomy, no destructive verb |

> All screenshots are in `.design/folio-surface-parity/screenshots/`.
> The bottom nav appears mid-page in full-page captures: it is `position: fixed`, so it renders
> once at its viewport offset. A capture artifact, not a layout defect.

## Status

| Finding | State |
|---|---|
| 1 — seller's card silent about a petition | **fixed** — BUG-035, spec D17 (this PR) |
| 3 — admin overlays mounted on the seller surface | **fixed** (this PR) |
| 2 — heading order `H1 → H6 → H3` | **fixed** — theme default + the reviewed screens; app-wide sweep is TECH_DEBT #30 |
| 4, 5, 6 — ISO date · 20 px phone target · empty `Historial` card | **fixed** (folio-detail polish PR) |
| 7, 8 — QR block has no container · renders with no ticket | **8 fixed** with the polish PR; 7 open |
| 9 — long titles truncate at 375 px | open — could-improve, unscheduled |

## Summary

The parity holds visually. Put the two details side by side and the only difference is the verb
set — same header, same chip order, same card grammar, same money hierarchy — and the two lists
differ only by the pending-work bar and the byline, exactly as **D13** says they should. Rail
colours are byte-exact against `DESIGN_TOKENS` (`#B45309` / `#15803D` / `#B91C1C`).

The biggest finding is the one the epic's own premise predicts: **on the seller's list, a sale
whose customer is waiting on an answer renders a green rail and says nothing about the petition.**
Hiding the admin *verb* also downgraded the *state*, which is the "capability, never information"
line crossed in the direction nobody was watching.

## Must Fix

1. **The seller's card is silent about an open petition — and paints it green.**
   `folioCardState.ts:212` derives the rail from the **surface-filtered** `folioAction`, so on the
   seller surface a folio with `cancellation_request: 'pending'` falls through to `'message'` →
   `rail: 'success'`. Measured on the running app: *Lucía Ortega* and *Carlos Peña* — both with a
   live petition — render `borderLeftColor: rgb(21,128,61)` and the verb *Enviar mensaje*, with no
   text anywhere naming the request. The admin's card for the same two folios says *Revisar
   solicitud* on an amber rail. See `screenshots/review-list-seller-desktop-1280.png` (cards 2–3)
   against `screenshots/review-list-admin-mobile-375.png` (cards 2–3).
   This contradicts **US-AG50** in its own words: *"I want my list to show the state my own sale is
   actually in — … that the customer asked to cancel — because today those states live only on
   admin screens I cannot open, **and my card shows a sale that looks fine**."* It looks fine.
   *Fix: make `folioAttention` surface-blind (compute from the folio's pending work, not from the
   filtered verb), and give the seller an icon-paired line naming it — «El cliente pidió cancelar»
   — so the rail colour has a text anchor, per DESIGN_TOKENS §3 (state is never colour-alone).*
   *(Predates this epic — US-A84 shipped the surface-aware action — but the epic is what makes it
   a contradiction rather than an omission.)*

2. **Heading order is broken on both detail surfaces: H1 → H6 → H3 → H6.**
   Measured in the DOM: `H1 "Leo Licona"`, `H6 "Entregar boletos"`, `H3 "Historial"`,
   `H6 "Boletos de acceso"`. Cause: `components/SectionCard.tsx:38` renders its title as
   `Typography variant="h3"` with no `component`, so the type scale picks the tag. A screen-reader
   user navigating by heading gets an outline that jumps down five levels and back up three.
   WCAG 1.3.1. *Fix: `variant="h3" component="h2"` on the SectionCard title (keeps the visual
   scale, fixes the outline) and give the two non-card section headings the same level.*
   *(Primitive-level and app-wide; these screens are where it surfaced.)*

## Should Fix

3. **Four admin-only overlays are mounted on the seller's detail.**
   `FolioWorkActions.tsx` renders its two `ConfirmSheet`s and two `FormSheet`s at lines 243–359,
   **outside every `rung ===` branch** — so *«¿Verificar el pago?»*, *«¿Aprobar la cancelación?»*,
   *«Rechazar solicitud»* and *«Rechazar pago»* exist in the seller's DOM. They are
   `aria-hidden="true"` and `visibility: hidden`, so they are **not** announced and **not**
   tabbable — no keyboard or privilege leak. But it is dead markup on every seller render, it
   contradicts PR-3's own claim that *"the seller's surface renders none of them"*, and it adds
   four more `keepMounted` drawers to a screen that needs none — which is precisely the
   multiplication **BUG-033** is about (a closed sheet leaving an ancestor `aria-hidden`).
   *Fix: wrap the four overlays in `isAdmin && (…)`, as `FolioDetailScreen` already does with the
   page's own three.*

4. **The ticket card prints a raw ISO date.**
   `TicketQr.tsx:23` renders `{line.slot_date} · {line.slot_start_time}` → *«2026-09-07 · 08:00»*,
   two lines below *«Salida: 7 sep 2026, 8:00 a.m.»* and *«Vendido por Ana Ramírez · 22 ago 2026,
   11:05 a.m.»* from `useOrgDateFormatter`. See `screenshots/review-detail-seller-desktop-1280.png`.
   Pre-existing, but US-A93 just put this card on the admin's screen too, doubling its audience.
   *Fix: format through `useOrgDateFormatter`, like every other date on the page.*

5. **The phone link is a 20 px touch target.**
   Measured at 375 px: the `tel:` link in the detail's contact row is 103×20. The brief's floor is
   ≥48 px (`DESIGN_TOKENS` spacing) and WCAG's is 44. This is the "call the customer" affordance on
   a phone held one-handed at a counter — the reach law's exact use case. See
   `screenshots/review-detail-seller-mobile-375.png`. *Fix: give the link the 48 px min-height the
   WhatsApp `IconButton` beside it already has.*

6. **The empty `Historial` card pushes the money down.**
   `FolioTimeline.tsx:360-364` renders a full `SectionCard title="Historial"` whose only content is
   *«Sin historial»*. On both details it sits **above** the payment card, so a folio with no events
   spends a whole card telling the reader nothing while the dominant figure moves further down —
   against law #1 (money reads first). See both `review-detail-*-mobile-375.png`.
   *Fix: return `null` when `rows.length === 0`.*

## Could Improve

7. **The QR block is the only section on the detail without a container.** *«Boletos de acceso»* and
   its `Ver`/`Ocultar` toggle sit on the page background while every sibling block is a
   `SectionCard`, so the app's strongest structural signal drops for one section.
   *Suggestion: host it in a `SectionCard` with the toggle as its `action` slot.*

8. **The section renders even when no line has a ticket**, producing a card whose entire content is
   *«No hay boleto disponible para esta línea.»* — and it is **expanded by default** for the seller.
   *Suggestion: render the block only when at least one line has a `qr_token`.*

9. **Long card titles truncate mid-phrase at 375 px** (*«Chichén Itzá desde Cancún · Jue 20, …»*),
   hiding the departure time — the second half of what the title exists to say.
   *Suggestion: let the title wrap to two lines at ≤ 400 px, as the detail's `<h1>` already does.*

## What Works Well

- **The parity is real, not asserted.** The seller's detail differs from the admin's by exactly one
  visible thing — the absent *Cancelar venta* — and the two lists by exactly two: the pending-work
  bar and the byline. That is D13 rendered, not just written down.
- **D4 is visible in a screenshot**: the seller's list ends with a sale from *3 feb* — 200 days old,
  reachable by scrolling, with no window footer — while the admin's says *«Últimos 30 días, más
  todo lo que tiene trabajo pendiente»*. Two honest and different scope claims on one chassis.
- **The empty state now names what emptied it** on the surface that used to lie about it:
  *«Sin resultados para «zzz» · Cancelado.»* + *Quitar filtros*.
- **Functional colour is exactly on token** and always icon- or word-paired: *Venció hace 2 d*,
  *Debe hace 8 d*, *Reembolsar*, *A favor* — never colour alone.
- **Money reads first** everywhere: `$2,400.00` at h4 dominates its card, captions carry the words.
- **US-UX07 landed cleanly**: back buttons, titles, empty states and the destructive verb all say
  *venta*; the search placeholder still says *folio* where it means the printed reference.
- **The QR default flips by audience** — expanded for the seller at the counter, collapsed for the
  admin — which is the D8 argument made visible rather than argued.
