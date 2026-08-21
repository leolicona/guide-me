# Feature: The POS Sale Sheet Becomes a Calendar

> **Status: SPEC.** Story **US-AG57**. Builds on `default-filtered-catalog.spec.md` (US-AG56 —
> the corrected `next_slot_date` is this sheet's opening anchor) and
> `date-filter-calendar-sheet.spec.md` (US-AG35 — the month grid the seller already knows).
> **Retires** `SlotPicker.tsx` and, with it, US-AG33's fixed three-day day-axis inside the sheet.

## Context

There are two ways to pick a date in this product and they look nothing alike.

**Reagendar** (US-AG52, `RescheduleSheet.tsx`) is a month grid with availability dots: one tap
lands on a day, and that day's remaining times appear underneath as chips, with `◀ ▶` stepping
only between days that can seat the group.

**Selling** (US-AG31/AG33, `ServiceSheet` → `ServiceSelectionPanel` → `SlotPicker`) is a flat
list of at most **three days**, inherited from whatever the catalog was filtered to. There is no
month, no navigation and no way to see the fourth day without closing the sheet, changing the
catalog's date filter, and reopening it.

So the seller learns a calendar for the rare gesture (moving an existing booking) and is denied
it for the constant one (making a sale). A customer at the counter asking *"¿y el próximo
sábado?"* costs three navigations.

This feature makes the sale sheet **calendar-first**, using the same grid — and pays for it by
retiring the three-day list rather than stacking one on the other.

**User Story:** **US-AG57** — as a seller, I want to pick the departure date for a sale on a
**month calendar** with availability marks, the same one I already use to reschedule, so a
customer asking about a date outside the next three days does not cost me three navigations.

## Scope boundary

Stated as a mechanical test, per `PROCESS.md`:

- Every **existing case** in `test/pos/pos-availability-days.test.ts` passes with its assertions
  **unchanged** — the org-wide, category-scoped behaviour of `GET /api/pos/availability/days` is
  untouched; this feature only *adds* optional parameters and an *additional* response field.
  *(Corrected during the build: this originally read "the file passes unedited", which the build
  falsified — S9 seeds an affiliate allow-list whose FK to `services` blocks the file's shared
  teardown, so three `DELETE`s and a link-release `UPDATE` were added to it. No existing
  assertion changed. The boundary is about **behaviour**, and saying "unedited" made it a claim
  about the file, which is a different and weaker thing.)*
- **S7 is the boundary made mechanical**: without `service_id` the response body must have no
  `sold_out` key at all.
- `RescheduleSheet` renders and behaves identically after being migrated to the shared
  `mode="single"` prop, and `test/pos/pos-bookings-reschedule.test.ts` passes unedited.
- The lodging stay sheet (`LodgingStaySheet`), the only **range** consumer of
  `DateRangeCalendar`, is untouched in behaviour.
- Express (`ExpressSalePanel`) is untouched: it is today-only by D5 and gets no calendar.

## Design decisions

| # | Decision | Why |
|---|---|---|
| **D1** | **Calendar-first, always** — the month grid replaces the three-day matrix; there is no toggle and no tab. | Two ways to pick a date is the defect. A collapsible "Ver calendario" would have kept the fast path for walk-ups, but it also keeps both mental models alive forever; the anchor (D5) is what protects the common case instead. |
| **D2** | Availability marks come from **`GET /api/pos/availability/days`** extended with `service_id` and `party`, **not** from downloading slots. | `RescheduleSheet` derives its dots by fetching **60 days of slots** (~90 KB with zones). That is fine for a rare admin gesture and wrong for a sheet the POS opens on every card tap, on a phone, in the field. The endpoint already runs this exact query; adding two params returns ~1 KB of date strings per month. |
| **D3** | The response gains **`sold_out: string[]`**, present only when `service_id` is passed. | D8 needs three day states and `days: string[]` can only express two. Keeping `days` meaning exactly what it means today leaves the org-wide consumer (`PosDatePickerSheet`) untouched. |
| **D4** | `party` filters **server-side**, with the same effective-capacity arithmetic as the sale. | The alternative — returning counts and filtering in the client — ships inventory numbers the list view deliberately stopped shipping (US-AG30), and would let the client and the server disagree about who fits. |
| **D5** | The calendar **opens on** the catalog's filter → else the corrected `next_slot_date` → else today; then navigates freely, **never mutating the global filter**. | Preserves the seller's filtering work without turning a *search* filter into a *sales* restriction. Because US-AG56 made `next_slot_date` the next departure **with room**, the default landing is a day that can actually be sold — which is what keeps the walk-up case at two taps despite D1. |
| **D6** | Once a day is chosen the grid **collapses** to one editable line (`📅 Sáb 22 de ago · Cambiar`). | The sheet caps at 85vh (~717px at 390×844). Grid (~380px) + pager + chips + zone + extras + footer does not fit, and the one control that must never be scrolled away is *Agregar al carrito*. The calendar has done its job by then. |
| **D7** | `DateRangeCalendar` gains a real **`mode="single"`**, and `RescheduleSheet` is migrated to it in this PR. | It is a *range* component; `RescheduleSheet.tsx:246` already fakes single-day selection with `{check_in: activeDate, check_out: null}` + `v.check_out ?? v.check_in`. The POS would be the second copy, and two copies of a workaround is how it becomes permanent. |
| **D8** | A day the service **does not operate** and a day that is **sold out** render **differently**: non-operating is flat and inert, sold-out is tinted with its own legend entry. | US-AG33 decided this deliberately for the three-day list ("never mislabeled Agotado, which means sold out and would imply it runs"). Retiring the list must not silently retire the distinction: *"ese día no sale"* and *"ese día ya se llenó"* are different conversations with the customer. This is the one place this feature costs more than copying `RescheduleSheet`. |
| **D9** | The absent-from-the-map day now means **non-operating**, inverting `dayRemaining`'s current *"absent = the server decides"* contract. | With D3 the client knows the full truth for the fetched month, so "absent" stops meaning "unknown". Callers that do **not** pass the new day-state map keep the old contract, so the lodging sheet is unaffected. |
| **D10** | Time chips read **«29 lugares»**, and US-AG34's amber cushion warning **survives** with an icon. | The shorter phrasing fits a chip and is how a seller speaks. But the cushion warning is the only signal that a sale is eating into controlled overbooking, and `DESIGN_TOKENS.md` forbids colour-only state — so it keeps its wording and gains an icon rather than being dropped for brevity. |
| **D11** | `SlotPicker.tsx` is **deleted**, not left unused. | `ServiceSelectionPanel` is its only consumer. A component kept "just in case" is a second renderer of the same concept, which is the condition this feature exists to end. |
| **D13** | A day whose departures have **all passed the sales cutoff** reads **Agotado**, not non-operating. The cutoff lives inside the classification `CASE`, not in the `WHERE`. | *Added during the build — the interview never reached this branch.* The service **does** run that day; only the selling window closed. Telling the seller *"no sale ese día"* when the truth is *"ya salieron"* is the same class of lie D8 exists to prevent, and «Agotado» is exactly what "you cannot sell it" means to the person at the counter. |
| **D12** | Changing `party` **re-classifies days** and clears a selected slot that no longer fits. | Already US-AG32's rule inside the sheet (`incrementParty` clears a non-fitting slot); D4 simply extends it to the calendar, so the grid never offers a day the chosen group cannot take. |

## Data Model

**No migration.** This feature adds no column, no table and no write. `GET
/api/pos/availability/days` gains two optional query params and one conditional response field.

## Business rules (enforced server-side)

1. A day is **available** ⟺ it has ≥ 1 active slot that is past neither the sales cutoff (US-A47)
   nor sold out, with **effective remaining ≥ `party`** (`slotHasRoomSql` generalised from
   `> 0`). *Enforced server-side; the sheet mirrors it only for painting.*
2. A day is **sold out** ⟺ it has ≥ 1 active, past-cutoff slot, but none satisfying rule 1.
3. A day is **non-operating** ⟺ it has no active slot at all. It is never called *Agotado* (D8).
4. `sold_out` is returned **only** when `service_id` is present. Without it the response is
   byte-identical to today's.
5. Every query stays org-scoped (`organizationId`), including the new `service_id` filter — a
   foreign org's service id returns an empty month, never another org's calendar.

## Authorization — who may do this

Unchanged: `agent`, `admin`, `affiliate` (the `pos` router's existing `requireRole`). An
**affiliate** may only pass a `service_id` on their curated allow-list; a non-curated id returns
an empty month, mirroring `getPosService`'s 404 defence-in-depth.

## API surface

### `GET /api/pos/availability/days` (extended)

| Param | Type | Notes |
|---|---|---|
| `month` | `YYYY-MM` | Unchanged, required. |
| `today` | `YYYY-MM-DD` | Unchanged, optional. |
| `categories` | csv | Unchanged, optional. Ignored when `service_id` is present (a service is its own scope). |
| `service_id` | uuid (**new**) | Scope the month to one service. Enables `sold_out`. |
| `party` | int ≥ 1 (**new**) | Seats the day must be able to take. Default 1. |

```json
{ "days": ["2026-08-27", "2026-08-28"], "sold_out": ["2026-08-21", "2026-08-22"] }
```

Days appearing in **neither** array are **non-operating** (D9).

### Error responses

`VALIDATION_ERROR` (400) for a malformed `month`, a non-uuid `service_id`, or `party < 1` —
the existing `zValidator` hook, no new codes.

## Frontend

- **`DateRangeCalendar`** gains `mode?: 'range' | 'single'` (default `'range'`, so no existing
  caller changes) and `dayState?: Map<string, 'available' | 'sold_out'>`. When `dayState` is
  passed, an absent day is **non-operating**: flat, no tint, not tappable (D9). The legend
  becomes **`■ Agotado`** / **`• Con lugares`** (D8).
- **`RescheduleSheet`** migrates to `mode="single"`, deleting its `check_out ?? check_in`
  workaround (D7). No visual change.
- **`ServiceSelectionPanel`** replaces `SlotPicker` with: the month grid → a day pager
  (`◀ Sábado 22 de ago ▶`) → that day's time chips. After a pick the grid collapses to
  `📅 Sáb 22 de ago · Cambiar` (D6). Zones, extras, total and the pinned footer are unchanged.
- **`SlotPicker.tsx`** is deleted (D11).
- Time chips: `HH:MM` over «N lugares», amber + icon over «⚠ N cupos extra» when the party dips
  into the Soft Cap cushion (D10, US-AG34 preserved).

Typography, colour and radii come from the existing primitives; this spec re-decides none of them
(`PROCESS.md` § The design system has exactly one source).

## Scenarios

### US-AG57 — day classification (API)

#### S1 — A day with room for the party is available
**Given** a service with a departure on `D` seating 4 and `party=4`
**When** the month is read with `service_id`
**Then** `D` is in `days` and not in `sold_out`.

#### S2 — A day that operates but cannot take the party is sold out, not absent
**Given** the only departure on `D` has 2 effective seats and `party=4`
**When** the month is read
**Then** `D` is in **`sold_out`** — it operates, so it must not read as non-operating (D8).

#### S3 — A day the service does not run appears in neither array
**Given** the service has no active slot on `D`
**Then** `D` is in neither `days` nor `sold_out` (D9).

#### S4 — `party` re-classifies, it does not filter the month away
**Given** a departure on `D` with 3 effective seats
**Then** `party=3` puts `D` in `days`; `party=4` moves it to `sold_out` (D12).

#### S5 — Soft Cap margin counts toward the party
**Given** a Soft Cap departure full on raw capacity with a margin of 2, and `party=2`
**Then** the day is in `days` — same arithmetic as the sale (US-A36).

#### S6 — A departure past the sales cutoff cannot make a day available
**Given** `D`'s only roomy departure has passed the cutoff and a full one has not
**Then** `D` is in `sold_out`, never in `days` (US-A47 unchanged).

#### S7 — Without `service_id` the response is unchanged
**Given** no `service_id`
**Then** the body has `days` only and **no `sold_out` key** — `pos-availability-days.test.ts`
passes unedited (rule 4).

### Multitenancy isolation (required)

#### S8 — B4: a foreign `service_id` returns an empty month
**Given** `seedTwoOrgs`, and org B's service has sellable slots all month
**When** org A's agent reads the month with **org B's** `service_id`
**Then** `days` and `sold_out` are both empty — never org B's calendar.

#### S9 — An affiliate may not probe a non-curated service
**Given** an affiliate whose allow-list excludes service `X`
**When** they read the month with `service_id=X`
**Then** the month is empty, mirroring `getPosService`'s 404 defence-in-depth.

## Definition of Done

- [ ] `availabilityDaysQuerySchema` accepts `service_id` + `party`; `listAvailabilityDays`
      returns `sold_out` only when `service_id` is present.
- [ ] `slotHasRoomSql` generalised from `> 0` to `>= party` with `party = 1` preserving today's
      behaviour for all four existing callers.
- [ ] Scenarios S1–S9 covered; `pos-availability-days.test.ts` passes **unedited**.
- [ ] `DateRangeCalendar`: `mode="single"`, `dayState`, the three-state paint and the new legend.
- [ ] `RescheduleSheet` migrated to `mode="single"`; `pos-bookings-reschedule.test.ts` unedited.
- [ ] `ServiceSelectionPanel` is calendar-first with the collapsing grid; `SlotPicker.tsx`
      deleted; US-AG34's cushion warning still renders, icon-paired.
- [ ] `LodgingStaySheet` behaviour unchanged (range mode is the default).
- [ ] `SPEC.md`: US-AG57 story + Features-by-Phase line + glossary term.
- [ ] `pnpm --filter api-turistear test` green; `pnpm build:app` clean.

## Deferred — and why each is safe to defer

- **Prefetching the adjacent month.** Navigating to September costs one ~1 KB request and a brief
  empty grid. Safe because the grid renders immediately with every day non-operating and settles
  on arrival; adding prefetch later changes no contract.
- **Express gets no calendar.** D5 of `express-sale.spec.md` makes it today-only on purpose — the
  customer is at the counter. Safe because nothing about this feature makes that decision harder
  to revisit.

## Known behaviour change

The sheet no longer inherits the catalog's date filter as a **restriction**, only as a starting
point (D5). A seller who filtered the catalog to Saturday and opens a service can now sell them
Sunday without closing the sheet. This is the intended change, and it means the catalog filter
and the sheet's date can legitimately differ — the cart line records the slot, so nothing
downstream reads the filter.
