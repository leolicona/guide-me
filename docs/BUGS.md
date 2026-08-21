# Bug Register

Tracks confirmed bugs, root causes, and fixes. Each entry is immutable once closed — it is a historical record, not a living document.

> **Format:** bugs are numbered in reverse-discovery order (newest first). Status: ⚠️ OPEN | ✅ FIXED | 🔍 INVESTIGATING.

---

## BUG-032 — A Closed Bottom Sheet Leaves the Wizard Hidden From Screen Readers — ⚠️ OPEN

**Found:** 2026-08-21, writing the US-A91 wizard tests. Every query for the wizard's footer after a
`BottomSheet` had been opened and closed failed with *"Unable to find an accessible element with
the role button"* — while the button was plainly in the DOM.

**Affected component:** `app-turistear/src/components/BottomSheet.tsx` (and every host built on it:
`FormSheet`, `ConfirmSheet`, `UnitDraftSheet`, the wizard's discard confirm).

### Symptom

After a sheet closes, an ancestor `<div>` of the page content still carries `aria-hidden="true"`.
The content is visible and clickable with a mouse; it is simply **absent from the accessibility
tree**, so a screen reader announces nothing and the whole surface is unreachable by assistive
navigation until a full remount.

Reproduced in jsdom on the **untouched** create path (open the unit sheet from wizard step 2, add a
unit, then query the footer), so it predates US-A91 and is not specific to the attach flow.

### Suspected cause

`BottomSheet` renders MUI's `SwipeableDrawer`, which is `keepMounted` by default (it needs the node
present to support the iOS swipe-to-open gesture). MUI's `Modal` applies `aria-hidden` to the
siblings of an open modal and removes it on close; with two keepMounted drawers mounted by the same
subtree (the draft sheet and the discard `ConfirmSheet`), the un-hiding appears not to complete.

### Impact

Screen-reader users lose the wizard — and any screen where a sheet has been opened and dismissed —
until they navigate away and back. Sighted mouse/touch users are unaffected, which is why it went
unnoticed: nothing looks wrong.

### Not yet verified in a real browser

The reproduction is in jsdom. Before fixing, confirm it in Chrome/Safari with VoiceOver — MUI's
`ariaHidden` bookkeeping is not jsdom-specific, but the ref-counting could behave differently where
transitions actually run.

**Workaround in tests:** `ServiceWizard.test.tsx` queries the wizard chrome with `{ hidden: true }`,
with a comment pointing here. Drop that option when this is fixed — it is the assertion that would
catch a regression.

---

## BUG-031 — The POS Catalog Advertises a Departure That Is Already Sold Out — ⚠️ OPEN

**Found:** 2026-08-21, adding the departure **time** beside the date on the POS service card (the
question "which time do we show?" had no correct answer, because the date it would sit beside was
not the next *sellable* departure).

**Affected component:** `api-turistear/src/routes/pos/handler.ts` (`listPosServices`) and its
contract in `docs/pos/default-filtered-catalog.spec.md` § API surface.

**Severity:** Medium — the catalog makes a factual claim about inventory that the sale then
refuses, on the screen an agent uses to quote a customer standing in front of them.

### Symptom

Two distinct wrong answers from the same aggregate.

**(a) `next_slot_date` names a sold-out departure.** A service whose Tuesday 09:00 is full and
whose Tuesday 15:00 has room advertises **Tuesday** — correct by luck. A service whose *only*
Tuesday departure is full and which has room on Wednesday still advertises **Tuesday**. The agent
quotes a date they cannot sell.

**(b) `has_availability` reads `Agotado` on a service that has seats.** With the numbers below the
card says sold out while the calendar Bottom Sheet lights the same day up.

### Root cause

Both live in one aggregate (`handler.ts:274–302`), whose `WHERE` filters on `status = 'active'`,
the availability window, and the sales cutoff (`sellableSlotSql`) — **and on nothing about
remaining spots**:

```ts
availableSpots: sql`sum((capacity - booked) + CASE WHEN is_flexible …)`,
nextSlotDate:   sql`min(${slots.date})`,     // ← no remaining > 0 predicate
```

`min(date)` therefore ranges over every *scheduled* slot, sold out or not — defect (a). It is also
`min(date)` rather than `min(date, start_time)`, so it could not name a time even if it wanted to.

Defect (b) is subtler, and the spec states the false premise out loud:

> *"Effective remaining is always ≥ 0, so `Σ effective_remaining over window slots > 0` is an
> exact, single-query test for 'any slot in window is sellable.'"*
> — `default-filtered-catalog.spec.md` § API surface

**Effective remaining is not always ≥ 0.** `updateService` (`routes/services/handler.ts:267–269`)
turns Soft Cap off — writing `flex_capacity_pct: 0` — **without validating against seats already
sold under the old margin**:

| Step | capacity | booked | flex % | effective |
|---|---|---|---|---|
| Soft Cap on, margin 10% → ceiling 44 | 40 | — | 10 | — |
| 43 sold on Tuesday (legal) | 40 | 43 | 10 | `−3 + 4 = 1` |
| Admin turns Soft Cap **off** | 40 | 43 | **0** | **`−3`** |

With 2 seats free on Wednesday the window sums to `−3 + 2 = −1`, so `has_availability` is `false`
— while `listAvailabilityDays`, which applies the same arithmetic **per slot**, lights Wednesday
up. One screen, two contradictory answers, from data an admin can produce in three clicks.

A negative slot cannot be *made* sellable by the sum, but it can silently **cancel out** a sibling
that is. A `Σ > 0` test answers "is the fleet net-positive", not "is any one of them sellable" —
and those diverge exactly when a per-slot value goes negative.

### Why it survived

`has_availability` and the calendar dots were built in different features (US-AG30 and US-AG35)
and never had to agree in a test. `next_slot_date` was carried as a "cheap `min(date)` … useful,
lightweight UI hint" (the spec's own Open decision 2) — hint-shaped things do not attract
assertions, and no scenario in the spec ever placed a sold-out slot **before** an available one.

### Fix

Not yet merged — see `docs/pos/default-filtered-catalog.spec.md` (amended) and **US-AG56**. One
aggregate replaces two, carrying the per-slot predicate `listAvailabilityDays` already uses, so
card, calendar and Express share a single definition of *sellable*:

```
MIN(date || 'T' || start_time)            -- the existing lexicographic departure key
WHERE status='active' AND date BETWEEN :from AND :to
  AND (date || 'T' || start_time) > :cutoff
  AND ((capacity - booked)
       + CASE WHEN is_flexible THEN (capacity * flex_pct)/100 ELSE 0 END) > 0
GROUP BY service_id
```

`has_availability` becomes `next_departure IS NOT NULL` — the two fields can no longer disagree,
because there is only one of them. `express_eligible` takes the same `EXISTS` over today.

**Deliberately not fixed here:** `updateService` still lets an admin strand a slot at negative
effective remaining. That is a separate defect with a separate blast radius (it also makes the
slot unsellable-but-scheduled), and the read path must be correct regardless of how the write path
gets fixed. Filed as `TECH_DEBT.md` rather than widened into this change.

---

## BUG-030 — Cancelling an Unverified-Transfer Folio Mints a Refund PIN for Money Never Confirmed — ✅ FIXED

**Found:** 2026-08-07, designing the folio detail's blocking-first action ladder (the question "should
unverified money block the cancel?" turned out to have a money answer, not a UX answer).

**What happens:** `cancelFolio` (US-A21, `api-turistear/src/routes/folios/handler.ts`) guards only
against `status = 'cancelled'`. On a folio whose `payment_verification` is `pending`, the ladder
prices the cancellation over `amount_paid` — which **includes the unconfirmed transfer** — and
`refundFieldsFor` opens `refund_status = 'pending'` with a `refund_amount` and a **refund PIN**: a
physical-cash hand-back obligation for money the company never confirmed receiving. The same hole
exists via the agent's `cancelBooking` on an apartado with an unverified transfer deposit.

**The correct path already exists:** `rejectPayment` (US-A67 D6) cancels the same folio with
`refund_status: 'none'` — "nothing was collected, so nothing to refund" — plus the commission
clawback. The two entrances disagree about whether the money exists.

**Mitigation shipped (frontend):** the detail hides `Cancelar folio` / `Cancelar apartado` while
verification is pending; the work card offers `Verificar` / `Rechazar pago` instead.

**Fix (#80, merged 2026-08-07):** `cancelFolio` and `cancelBooking` refuse (`409`,
`PAYMENT_UNVERIFIED`) while `payment_verification = 'pending'`, pointing at verify/reject.
Deliberately narrow: `rejectPayment` remains the cancel path for unconfirmed money, and the
expiry sweep is untouched (it enters via `cancelFolioPriced`) — an expired hold releases its
seats regardless of what the money is waiting on, pinned by
`test/folios/cancel-unverified-guard.test.ts` (5 scenarios). The UI mirror shipped in #77.

---

## BUG-027 — A Cancellation That Refunded Nothing Renders As "(reembolsado)" — ✅ FIXED

**Discovered:** 2026-08-01, while enumerating every reachable folio case for a lifecycle table
**Affected component:** `app-turistear/src/features/folios/folioCardState.ts` (`folioMoneyAxis`)
and its renderer `components/FolioCard.tsx`
**Severity:** Medium — a factual misstatement about money, on the reconciliation screen

### Symptom

A cancelled folio with `refund_status = 'none'` rendered **"$1,500.00 (reembolsado)"**. Nothing was
refunded. The organization kept every peso.

### Root cause

The money axis asked **one** question where there are **three** answers:

```ts
folio.refund_status === 'pending'
  ? { kind: 'refundOwed',    cents: folio.refund_amount ?? 0 }
  : { kind: 'refundSettled', cents: folio.total }   // ← 'none' lands here too
```

`refund_status` has three values and only two were distinguished, so *never owed* was rendered with
the label belonging to *paid back*. `'none'` on a cancelled folio is set by `cancelFolioPriced`
(`routes/folios/handler.ts:809-815`) when the ladder's retention consumed everything collected —
the case **US-A76 documents by name**: *a 30% deposit against a 50% retention refunds nothing*. Any
org on the inherited default ladder produces it at the terminal tier, so it was not an edge case.

The figure was wrong too: it printed `folio.total`, not what the customer actually paid. An
apartado cancelled after a 90,000 deposit on a 300,000 sale claimed 300,000 had gone back.

### Fix

Three readings for the three states, and each figure is the sum it is about:

| `refund_status` | Reading | Figure |
|---|---|---|
| `pending` | `refundOwed` — *Reembolsar* | `refund_amount` — the debt |
| `refunded` | `refundSettled` — *(reembolsado)* | `refund_amount` — what went back |
| `none` | **`refundNone`** — *(sin reembolso)* | `amount_paid` — what the retention came out of |

The screen-reader label moves with it (`Pagado, sin reembolso`), because the caption alone is not
state when the figure reads as an ordinary amount.

### Tests

`folioCardState.test.ts` (S-2, S-2b, S-2c) and `components/FolioCard.test.tsx` (rendered S-2/S-3).
**Mutation-verified:** collapsing the branch back to two readings turns exactly these red.

### Related changes

Shipped with **BUG-026** — the other label that lied — as Phase 1 of
`docs/folios/folio-state-machine.spec.md`.

---

## BUG-026 — The Same Status Is Called Two Different Things — ✅ FIXED

**Discovered:** 2026-08-04, by the settings/vocabulary audit behind
`docs/folios/folio-state-machine.spec.md`
**Affected component:** `FolioStatusChip.tsx:9` vs `folioCardState.ts:217`, plus
`folioFacets.ts:46` and `FolioHistoryPage.tsx:58`
**Severity:** Low technically, **Medium in the product** — the vocabulary is the model the user
builds in their head

### Symptom

`status = 'booking'` rendered as two different words on screens a seller sees in the same session:

| Surface | Said |
|---|---|
| `FolioStatusChip` (folio detail, history detail) | **"Reserva"** |
| `folioTimeChip` (the list card) | **"Apartado"** |
| The facet strip | **"Reserva"** |
| The history toggle | **"Reservas"** |

### Root cause

No decision was ever made about the word. Each surface picked one, and both were defensible in
isolation — which is exactly how a vocabulary rots without anyone doing anything wrong.

The deeper problem is that **"Reserva" does not distinguish anything**: an apartado and a paid
folio *both* hold inventory. The word names the property they share, so it can only ever be
ambiguous.

### Fix

The word is **retired**, not disambiguated (`folio-state-machine.spec.md` D8). Three terms:

- **Apartado** — partial payment, balance owed
- **Pagado** — paid in full
- **Por verificar** — money received, not confirmed against the bank

All four surfaces now say *Apartado* / *Apartados*. `SPEC.md`'s glossary carries the retirement.

### Tests

`FolioCard.test.tsx` (S-1, the chip and the card together — they must agree, since disagreeing was
the defect) and `folioFacets.test.ts` (S-1, incl. `FACETS.some(f => f.label === 'Reserva') === false`).
**Mutation-verified.**

---

## BUG-029 — The Apartado Creation Cutoff Forbids the Only Useful Values, and Accepts a Born-Dead One — ✅ FIXED

**Discovered:** 2026-08-05, in review of the reschedule spec
**Reporter:** a reviewer reading the validation against `bookingExpiryDate`
**Affected component:** `api-turistear/src/routes/organizations/handler.ts` (the US-A77 coherence
rule) and `routes/pos/handler.ts` (`confirmSale`, which had no equivalent guard)
**Severity:** Medium — no wrong number is computed, but a documented capability is unreachable and
an apartado can be written already expired.

### Symptom

The rule was `cutoff >= buffer`. It is wrong at **both** ends.

**Below the buffer, the useful configurations are rejected.** *"No apartados inside 2 hours"* —
`booking_creation_cutoff_hours: 2` against the default 24 h deadline — returns `400`. The admin's
only legal choices are `0` (no restriction at all) or something ≥ 24 h, so **same-day apartados
cannot be governed**.

**At the boundary, an apartado is born dead.** With `cutoff == buffer == 24`, a sale at exactly 24 h
out passes the creation guard (`hoursOut < cutoff` is `24 < 24`, false) and then:

```ts
nearDeparture = (earliestSlotEpoch - nowSec < bufferSeconds)   //  86400 < 86400  →  false
tourBuffer    = bufferSeconds                                   //  the FAR branch
expiry        = earliestSlotEpoch - 86400                       //  = the instant of sale
```

`booking_expires_at = now`. The sweep cancels it within fifteen minutes.

**And with the default `cutoff = 0` there is no guard at all** — `if (policy.creationCutoffHours > 0)`
skips it — so a sale five minutes before departure computes `salida − 15 min`, an expiry already in
the past.

### Root cause

The rule's stated reasoning was *"an apartado created inside its own settle window is born owing
money it has no time to pay"*. That **ignores the grace stage**, which the same feature documents as
a legitimate birthplace — `apartado-stages.spec.md` S2: *"Sales made close to departure are BORN
here \[in ②], which is why entry is not a separate event."*

A sale 2 h out takes the near branch and gets `salida − 15 min`: one hour forty-five of life. It is
healthy. The validation forbade it while accepting the one case that genuinely is not.

The deeper cause is that the validation **re-derived** the arithmetic it was validating instead of
asking the function that owns it, so the two could disagree — and did.

### Fix

Three parts, because no single one is sufficient:

1. **`cutoff >= buffer` is removed.**
2. **The rule now asks the real function.** `bookingExpiryEpoch` is extracted from
   `bookingExpiryDate` and exported; the validation computes what an apartado created at the
   *tightest legal moment* (`departure − cutoff`) would receive, and requires it to be alive. Same
   arithmetic as production, so it cannot drift. It also now re-checks when
   `booking_grace_offset_minutes` alone changes, which the old rule ignored.
3. **A sale-time guard in `confirmSale`** — the part a settings rule **cannot** provide, because
   whether an apartado is born expired depends on *when the sale happens*, not only on the config.
   With `cutoff = 0` no settings rule can promise anything. `confirmSale` now refuses a booking
   whose computed expiry is already past → `422 BOOKING_TOO_LATE`.

A **full-payment** sale on the same slot is untouched: a completed sale near departure is fine, a
promise to come back and pay is not.

### Tests

`test/organizations/organization-policy.test.ts` — six assertions replacing the one that asserted
the removed rule (kept, not deleted: it also covered the merged-stored-value logic, which survives).
`test/pos/pos-bookings-create.test.ts` — the sale-time guard, plus the walk-in path staying open.

**Mutation-verified:** restoring `cutoff < buffer` and neutering the `confirmSale` guard turns
exactly these six red and nothing else.

### Related changes

Found while reviewing `docs/bookings/booking-reschedule.spec.md` (PR #67), whose Phase 2 reuses
`booking_creation_cutoff_hours` as the destination guard for a reschedule (rule 5) — it would have
inherited the defect.

---

## BUG-028 — Two Org Settings the API Accepts and Nothing Obeys — ✅ FIXED

**Discovered:** 2026-08-04
**Reporter:** an audit of every column on `organizations` for a real consumer, prompted by a
question about how the apartado time limit works
**Affected component:** `api-turistear/src/routes/organizations/schema.ts` (the `PATCH` contract),
`handler.ts` (the read shape), `pos/handler.ts:660-690` (`BookingPolicy`), and — the part that
matters — `docs/SPEC.md` US-A46
**Severity:** Low in code, **Medium in the index.** Nothing computes wrongly; an admin is told
something untrue.

### Symptom

`PATCH /api/organizations` accepted two fields that changed nothing:

| Field | What the caller is told | What happens |
|---|---|---|
| `booking_hold_days` | US-A46: *"the **hold window** (≥ 1) after which an unsettled apartado auto-cancels and releases its spots"* | **nothing.** `200`, the value is stored, and no code reads it |
| `agent_cancellation_enabled` | US-A73's switch, round-tripping through the API | **nothing.** Every cancel route is still `requireRole('admin')` |

`booking_hold_days` was the worse of the two, for three reasons:

1. It **validated** — `z.number().int().min(1)`. It rejected a `0` with a 400 and then ignored the
   `5`. Validation is the strongest signal an API can send that a field is load-bearing.
2. It was carried into `BookingPolicy.holdDays` (`pos/handler.ts:681`), so reading the code it
   looked like a live policy.
3. **`SPEC.md` US-A46 described its behaviour as real.** An admin who read the index and set
   `booking_hold_days: 3` believing their apartados would last three days got `200` and no effect.

### Root cause

The `created_at + holdDays` model was correct when it shipped. It produced the born-expired
apartado (`#29`/`#30`), whose fix moved the calculation to **time-distance to departure**, and
`apartado-stages.spec.md` then made the deadline a transition rather than an event. Neither change
removed the setting that configured the old model — the code comment records the moment:

> *The former `createdAt + holdDays` cap was removed — the hold now lasts until the pre-departure
> buffer regardless of how far out the tour is; **`holdDays` is retained inert**.*

"Retained inert" is a fair description of a column. It is not a fair description of a validated
field in a public contract that the product index documents as working.

`agent_cancellation_enabled` is a different shape and was never a lie: `SPEC.md` US-A73 says
plainly *"**Not yet built** — the switch is not surfaced until the endpoint exists"*, and it is
deliberately absent from `/settings`. The only defect is that the `PATCH` still **accepted** it,
so a caller using the API directly could set `true` and believe they had enabled something.

### Fix

- Both fields removed from `updateOrganizationSchema`. Zod strips unknown keys on a non-strict
  object, so a client still sending them gets `200` and no write — no breaking error.
- `booking_hold_days` removed from the read shape and from `MyOrganization`; `holdDays` removed
  from `BookingPolicy` and from the three call sites that selected it.
- `agent_cancellation_enabled` **stays readable**: it is genuinely reserved, and US-AG44 will need
  it. The `PATCH` line is restored by the PR that builds the endpoint.
- **`SPEC.md` US-A46 amended** — the sentence that described the retired model is struck through
  and replaced with what actually governs the deadline.
- Neither column is dropped. There is no migration: the stored values are harmless history, and
  rewriting a table in D1 to remove two columns buys nothing.

### Tests

`test/organizations/organization-policy.test.ts` — both new assertions were **mutation-verified**:
re-adding the schema lines and the update branches turns exactly those two tests red, and nothing
else.

### Related changes

The audit that found this is recorded in `docs/folios/folio-state-machine.spec.md` (§ Settings
audit), which also notes two findings deliberately left alone: `ack_window_hours` works but has no
UI (tracked as unbuilt at `SPEC.md` *Configuración home*), and the lodging pair
(`lodging_free_cancel_days` / `lodging_cancel_penalty_pct`) is the model this fix copies — a
retired setting that stops being editable and **tells the orgs that set it where the behaviour
went** (`SettingsPage.tsx:488`).

---

## BUG-025 — A Zoned Service Becomes Unsellable Once It Has 100 Sellable Slots — ⚠️ OPEN

**Discovered:** 2026-08-03
**Reporter:** the first real E2E run — GitHub Actions run `30838104788`, dispatched from `main`
minutes after the release put `e2e.yml` there
**Affected component:** `api-turistear/src/routes/pos/handler.ts:555-583` (`getPosService`, the
US-A64 per-zone availability query)
**Severity:** Medium — **latent, not currently breaking sales.** `to` is optional in the contract,
and omitting it on a zoned service with ≥100 sellable slots is a hard `500`. Today the only caller
that omits it is the E2E seed; both POS callers bound the window to 1–3 days and work fine (see
*Who is actually affected*). The exposure is that the endpoint is unsafe for any consumer that
takes the documented default — a report, a script, an integration, or a new screen — and it fails
as a `500 INTERNAL_ERROR` that names nothing.

*(Originally filed as High on the assumption that the POS opened the service unbounded. It does
not. Corrected before this entry was merged — the evidence is in* Who is actually affected *below.)*

### Symptom

`GET /api/pos/services/:id` returns `500 {"error":{"code":"INTERNAL_ERROR"}}` for
`La ruta de la montaña` (`836cedc3-ca26-4be1-824f-f5b2a295abd9`) in dev. 17 other services on the
same org return `200`.

The endpoint accepts a `to` window, which makes the boundary directly measurable:

| `?to=` | slots returned | status |
|---|---|---|
| +98 d | 99 | `200` |
| +99 d | — | **`500`** |

99 slots pass, 100 fail.

### Who is actually affected

**Not the POS.** Both frontend callers always bound the window, so neither can reach the limit:

| Caller | Window | Result |
|---|---|---|
| `ServiceSheet.tsx:54-59` — no date picked | 3 days `[start, start+2]` | `200`, 3 slots |
| `ServiceSheet.tsx:54-59` — explicit date | 1 day | `200`, 1 slot |
| `ServiceSheet.tsx:54-59` — Express (US-AG45 D5) | 1 day (today) | `200`, 1 slot |
| `PosServicePage.tsx:28-31` | 1 or 3 days, same rule | `200` |
| `e2e/setup/seed.setup.ts:37` | **none** | **`500`** |

Verified against the failing service in dev by replaying each call shape. An agent can open
`La ruta de la montaña` and sell it normally.

So the defect is **latent**: `to` is documented as optional, and the one caller that takes that
default is the E2E seed. The risk is the next consumer that does the same — a report, an export, a
script, a new screen — and gets a `500` that names nothing. `getPosService(id, range?)` makes the
range optional at the client layer too, so nothing stops it.

### Root Cause

The per-zone availability query binds **one D1 parameter per slot**:

```ts
.where(
  and(
    eq(slotZones.organizationId, agent.organizationId),   // 1 bound parameter
    inArray(slotZones.slotId, slotRows.map((s) => s.id)), // + 1 per slot
  ),
)
```

**D1 caps a query at 100 bound parameters.** With `organizationId` taking one, 99 slots fits exactly
and the 100th overflows — which is the boundary measured above, to the row.

A controlled comparison across the org's tours isolates it to this query, not to slot volume and
not to zones:

| Service | `zones_enabled` | Slots | Result |
|---|---|---|---|
| Tour nocturno centro | `false` | **197** | `200` |
| La ruta del Barro | `true` | 42 | `200` |
| La ruta del pulque | `false` | 84 | `200` |
| **La ruta de la montaña** | **`true`** | **≥ 100** | **`500`** |

197 slots without zones is fine; 42 slots with zones is fine. Only *zoned* **and** *≥100 slots*
fails — the `inArray` is the sole path that scales its parameter count with the slot list.

The other list-shaped reads in this handler are bounded by `serviceId` rather than by an id array,
so this is the only query in `getPosService` with the exposure. **`confirmSale` and the other
zone-aware paths should be audited for the same pattern before this closes.**

### Fix

Not yet applied. Two candidates, and they are not mutually exclusive:

1. **Give `to` a bounded default server-side.** This is the real fix now that the blast radius is
   known: the failure is entirely about what happens when the caller *omits* the window, so a
   default horizon makes the documented default safe. It also shrinks a response that is already
   too large — 197 departures serve no screen.
2. **Chunk the `inArray`** into batches of ≤ 90 ids and merge the results. Mechanical, and correct
   regardless of what the window ends up being — but it only fixes this one query.

(1) is the better primary fix; (2) is the safety net for whatever window is chosen. Either needs an
API test that seeds ≥ 100 sellable slots on a zoned service — the exact case no existing test
covers, which is why this shipped.

### Why it was not caught sooner

Nothing in Tiers 1–3 can see it: it needs a real D1, a zoned service, and a hundred rows of
accumulated calendar. The E2E seed found it by accident of drift — its previous pick
(`La ruta del pulque`) had lost availability, so "cheapest bookable tour" moved on to the next
service, which happened to be this one.

The seed found it precisely **because** it calls the endpoint the way no screen does — without a
window. That is worth keeping: a test that only replays the UI's own call shape can only ever find
the bugs the UI already exercises. The seed should still pass a window (it needs one departure, not
a year of them), but the discovery came from a caller that took the contract at its word.

---

## BUG-024 — An Apartado Can Be Opened on a Departure That Has Already Left — ⚠️ OPEN

**Discovered:** 2026-08-02
**Reporter:** the E2E suite's first real execution — `docs/testing/frontend-testing.plan.md` Phase 5
**Affected component:** `api-turistear/src/routes/pos/handler.ts:1416-1425` (`confirmSale`, the
US-A77 creation cutoff)
**Severity:** Medium — an agent can take a cash deposit against a tour that already departed. The
folio looks live (`status: booking`, a real balance) but **every settle answers 409
`BOOKING_EXPIRED`**, so the money is collected against something that can never be completed.

### Symptom

Selling an apartado on a slot whose departure has passed returns `201` and a folio with
`status: booking`. Its `booking_expires_at` is in the past on arrival. Settling it — by any method —
fails:

```
POST /api/pos/folios/:id/settle {"method":"transfer",…}
  → 409 {"error":{"code":"BOOKING_EXPIRED","message":"Booking has expired"}}
```

Reproduced against `api-dev` on 2026-08-02 at 19:50Z with a `2026-08-02 14:00` departure: the
folio was created, and its settle-by landed at `19:45Z` — five minutes before it was sold.

### Root Cause

The guard that should stop this is conditional on policy:

```ts
if (policy.creationCutoffHours > 0) {
  const hoursOut = (earliest.epoch - nowSec) / 3600
  if (hoursOut < policy.creationCutoffHours) throw new ApiError('BOOKING_TOO_LATE', 422, …)
}
```

An org that has never configured a creation cutoff sits at `0`, so the whole block is skipped —
including the part that would have rejected a *negative* `hoursOut`. `bookingExpiryDate` then does
its job faithfully (`departure − buffer`) and returns an instant already behind us.

The zero default is deliberate for the **sales** cutoff — the comment above it explains that a cash
walk-in should sell until the last minute. That reasoning covers a completed sale; it does not
cover a promise to come back and pay for a bus that has gone.

### Fix

Not yet applied — found while running the E2E suite, and this is API behaviour, not the test-harness
defect that PR shipped. The likely shape is to reject `hoursOut < 0` unconditionally (a departed
slot is never bookable, at any policy setting) and keep the configurable cutoff as the separate,
stricter rule it already is. Needs an API test alongside it; `seed.setup.ts` asserts
`booking_expires_at` is in the future, so the E2E suite now fails loudly rather than silently if
this ever re-appears through another path.

---

## BUG-023 — Two Money Queues Are Unreachable on a Phone, and the Filter Row Drags the Page — ✅ FIXED

**Discovered:** 2026-08-01
**Fixed:** 2026-08-01
**Reporter:** manual testing of `/folios` on a narrow viewport
**Affected:** `app-turistear/src/pages/FoliosListPage.tsx`,
`app-turistear/src/pages/FolioHistoryPage.tsx`,
`app-turistear/src/pages/CashBalancesPage.tsx`,
`app-turistear/src/features/folios/components/CancellationRequestsTab.tsx`
**Severity:** High — one half hides a money queue from the device the booth actually uses; the other
moves the page out from under a finger mid-interaction.

### Symptom

Two faces of one defect, both on *Ventas*.

**1. Reembolsos and Vencidos cannot be reached below ~600px.** The five tabs measure **569px**
against a **358px** scroller. `<Tabs>` used the default `variant="standard"`, whose scroller is
`overflow-x: hidden` with no scroll buttons — so the two rightmost tabs are clipped with no arrows,
no touch scroll and no indication they exist. Their count badges are invisible too.

| Tab | Right edge at 390px | Reachable |
|---|---|---|
| Folios · Por verificar · Solicitudes | ≤ 359 | yes |
| **Reembolsos** | 484 | **no** |
| **Vencidos** | 585 | **no** |

These are US-A78 and US-A79: cash the company owes customers, and holds sitting on seats with money
still owed. They shipped and had never worked on a phone.

**2. Applying a status filter drags the whole page sideways.** The `ToggleButtonGroup` measures
**397px** and handled no overflow, so below ~412px the *document* became wider than the viewport.
Clicking a button whose right edge sat outside made the browser scroll it into view — taking the
page, and the `Ventas` heading, with it.

| Viewport | scrollX after the click | `Ventas` heading x |
|---|---|---|
| 320px | 0 → **77** | 16 → **−61** *(off screen)* |
| 360px | 0 → 37 | 16 → −21 |
| 390px | 0 → 7 | 16 → 9 |
| 412px+ | 0 | 16 *(no defect)* |

The reporter attributed it to the *Cancelado* button; measurement showed the trigger is whichever
button is clipped at that width — at 320px, `Cancelado` ends at x=316 and is exactly that button.

### Root Cause

One cause, two rows: **a control row wider than the viewport with nothing owning the overflow.**
Where the row itself clips (`Tabs`), content becomes unreachable. Where it does not (the toggle
group), the overflow escalates to the document and the browser's scroll-into-view on focus moves
everything.

`allowScrollButtonsMobile` is the load-bearing half of the tab fix: MUI hides the arrows on mobile
by default, which is precisely the width where they are the only way through.

### Fix

- `<Tabs variant="scrollable" scrollButtons="auto" allowScrollButtonsMobile>`.
- Every status-filter row wrapped in `FilterStrip` — the existing design-system piece
  (`features/filters`) already used by `/pos` and Reportes, which owns the horizontal scroll and
  bleeds to the edge on mobile. Applied to all four rows carrying four or more options, not only
  the reported one: the same defect was present on the seller's *Ventas*, on the *Solicitudes* tab
  of this very screen, and on *Caja* (five options, longer labels).

### Verification

Measured in Chromium at 320 / 360 / 390px, before and after: document overflow **77 / 37 / 7 → 0**,
`scrollX` stays 0, the heading stays at x=16, and *Vencidos* is in view and clickable at every
width.

`FoliosListPage.test.tsx` guards the regression at Tier 1. What it can prove is stated in the file
rather than implied: jsdom has no layout engine, so the overflow itself is unprovable there and was
measured in a browser instead. The test asserts the props that make the rows scrollable are still
present — deleting `variant="scrollable"` is a one-character edit that silently restores the bug.
Confirmed by mutation: removing either fix fails its own case and nothing else.

---

## BUG-022 — A Submitting Sheet's Button Loses Its Accessible Name — ✅ FIXED

**Discovered:** 2026-07-31
**Fixed:** 2026-08-01
**Reporter:** the frontend test harness — axe, `docs/testing/frontend-testing.plan.md` Phase 4
**Affected component:** `app-turistear/src/components/FormSheet.tsx:66-68`,
`app-turistear/src/components/ConfirmSheet.tsx:64-66`
**Severity:** Low–Medium — transient (only while a mutation is in flight), but axe rates
`button-name` **critical**, and it lands at the exact moment a screen-reader user needs to know
what is happening.

### Symptom

While `busy`, both sheets render `{busy ? <CircularProgress /> : label}` — the label is *replaced*,
not supplemented. The control becomes a `<button>` with no text at all, and the spinner is an
unnamed `role="progressbar"`. axe reports two violations: `button-name` (critical) and
`aria-progressbar-name`.

Testing Library cannot find the control by name at all during submit, which is how it surfaced.

### Root Cause

The spinner was treated as a visual state swap. For a sighted user it is, because the button's
position and disabled styling carry the meaning; for a screen-reader user the entire label
disappears, and a disabled unnamed button announces as nothing useful.

### Fix

The spinner swap stays (it is the right visual), but the name is now stated rather than implied:
both buttons carry `aria-label={submitLabel}` / `aria-label={confirmLabel}` plus `aria-busy`, and
the `CircularProgress` is marked `aria-hidden` — the button already announces that it is busy, so a
second, unnamed progressbar inside it was noise as well as a violation.

`BUSY_SHEET_KNOWN_ISSUES` is deleted from `src/test/axe.ts`, which is what verifies the fix: the
sheet tests now run axe with **no tolerated rules**. `BottomSheet.test.tsx` asserts the confirm and
submit buttons are still findable by name while busy, and carry `aria-busy="true"` — the assertion
that used to pin the defect now pins the fix.

---

## BUG-021 — Every Bottom Sheet Is an Unnamed Dialog — ✅ FIXED

**Discovered:** 2026-07-31
**Fixed:** 2026-08-01
**Reporter:** the frontend test harness — axe, `docs/testing/frontend-testing.plan.md` Phase 4
**Affected component:** `app-turistear/src/components/BottomSheet.tsx`
**Severity:** Medium — `BottomSheet` is the canonical overlay, so this affects **every** sheet in
the product: settle, cancel, cash drop, every FormSheet and ConfirmSheet, the POS day picker.

### Symptom

The sheet's paper carries `role="dialog"` + `aria-modal="true"` with no accessible name. A screen
reader announces "dialog" and nothing else, even though the sheet always has a visible title
directly beneath. axe: `aria-dialog-name`, impact **serious**.

### Root Cause

`BottomSheet` accepts `header` as an opaque `ReactNode` and never relates it to the dialog element.
`FormSheet` and `ConfirmSheet` both pass a `<Typography variant="h6">` title through that slot — so
the name exists on screen, it is simply never wired to the role that needs it.

### Fix

`BottomSheet` now takes a **required** `title: string` and sets it as the paper's `aria-label`.
Required, not optional, deliberately: an optional prop fixes the ten sheets that exist today and
does nothing about the eleventh. With it required, an unnamed sheet no longer type-checks — `tsc`
passing is the proof that every call site is named.

`FormSheet` and `ConfirmSheet` forward the title they already receive, so their call sites are
unchanged. The eight direct callers each state a name; the two date sheets (whose header is a month
navigator, not a title) describe what the sheet is FOR — "Seleccionar fecha", "Seleccionar rango de
fechas" — which is a better name than echoing the visible month.

`SHEET_KNOWN_ISSUES` is deleted from `src/test/axe.ts`: the sheet tests now run axe with no
tolerated rules, and `getByRole('dialog', { name })` is asserted directly for BottomSheet,
FormSheet and ConfirmSheet.

---

## BUG-020 — A Ticket WhatsApp Link Is Built for Phone Numbers That Cannot Be Dialled — ⚠️ OPEN

**Discovered:** 2026-07-31
**Reporter:** the frontend test harness — `docs/testing/frontend-testing.plan.md` Phase 1
**Affected component:** `app-turistear/src/features/pos/delivery.ts:106-110` (`ticketWhatsAppUrl`)
**Severity:** Low — the agent taps *Enviar*, WhatsApp opens on a dead number, and the tourist never
receives the portal link. Silent: nothing in the UI says the send failed.

### Symptom

A folio whose `customer_phone` holds a partial number (`123`, a half-typed `998 12`) still renders
an active WhatsApp send button, and tapping it opens `wa.me/123` — which resolves to nothing.

### Root Cause

`normalizePhone` returns **both** `e164` and `valid` (E.164 plausibility: 11–15 digits), and
`isSendablePhone` exists precisely to express the gate. But `ticketWhatsAppUrl` guards on the
wrong one:

```ts
const phone = normalizePhone(ctx.folio.customer_phone).e164
if (!phone) return null      // ← "any digits at all", not "dialable"
```

So it rejects only a phone with *zero* digits. Anything from one digit up produces a link. The
checkout's own gate uses `isSendablePhone`, so the two paths disagree about what "sendable" means.

### Fix

Not yet applied — found while writing tests, and fixing it inside the test PR would have mixed a
behaviour change into a phase that deliberately touches no product code. The fix is one line
(guard on `.valid` instead of `.e164`) plus a decision about what the folio UI should show for an
unusable number. `delivery.test.ts` pins the current behaviour with a comment pointing here; that
expectation flips to `toBeNull()` when this closes.

---

## BUG-019 — The "Invalid Calendar Date" Check Accepts 31 February — ⚠️ OPEN

**Discovered:** 2026-07-31
**Reporter:** the frontend test harness — `docs/testing/frontend-testing.plan.md` Phase 1
**Affected component:** `app-turistear/src/features/schedules/schemas.ts:4-11` (`dateStr`)
**Severity:** Low — reachable only by typing a date rather than picking one, but it sends a date
the calendar does not have to an API that will store it verbatim.

### Symptom

`slotFormSchema` and `scheduleFormSchema` accept `2026-02-31`, `2026-02-30` and `2026-04-31`. The
field shows no error and the value is posted as-is.

### Root Cause

The refine is meant to be the guard behind the regex:

```ts
.refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), 'Fecha de calendario inválida')
```

`Date.parse` rejects an out-of-range **month** (`2026-13-01` → `NaN`) but silently **rolls over**
an out-of-range **day**: `Date.parse('2026-02-31T00:00:00Z')` is a valid timestamp — 3 March 2026.
So the check catches roughly half of what its message promises, and the half it misses is the half
a human actually types.

### Fix

Not yet applied (same reason as BUG-019 — the test phase changes no product code). The fix is to
compare the parsed date back to its input, e.g. reject when
`new Date(\`${s}T00:00:00Z\`).toISOString().slice(0, 10) !== s`. Note the same pattern appears in
`features/catalog/schemas.ts`, whose `dateStr` has **no** refine at all — worth fixing together.
`schedules/schemas.test.ts` pins the current behaviour with a comment pointing here.

## BUG-018 — A Single Mis-Scan Makes a Ticket Permanently Non-Refundable, and Nothing Can Un-Redeem It — ⚠️ OPEN

**Discovered:** 2026-07-31
**Reporter:** Claude Code (found while specifying Express Sale / Group Redemption)
**Affected component:** `api-turistear/src/routes/tickets/handler.ts:113-124` (`scanTicket`),
`api-turistear/src/utils/cancellationPolicy.ts` (D7 — the redeemed-line rule)
**Severity:** Medium — rare, but silent, irreversible, and it costs the customer money. No error,
no log, no admin override; the refund simply stops being owed.

### Symptom

An agent scans a QR at the wrong moment — the wrong departure, a customer who then does not travel,
a stray tap while re-arming the camera. From that instant the folio line is treated as **travelled**:
if the customer later cancels, the refund quote returns **0** no matter how far from departure they
are, and no path in the product can put it back.

Reproducible: sell a tour departing in five days under a ladder whose 120-hour tier refunds 100 %,
scan one pass by accident, then request cancellation. Before the scan the quote is a full refund;
after it, nothing.

### Root Cause

Two correct decisions that combine into an unrecoverable state.

1. **`redeemed_count` is increment-only.** `scanTicket` is the only writer:

   ```ts
   .set({ redeemedCount: sql`${folioLines.redeemedCount} + 1` })
   .where(and(…, sql`${folioLines.redeemedCount} < ${folioLines.quantity}`))
   ```

   There is **no** decrement anywhere in the codebase — no un-redeem endpoint, no admin override,
   no compensating path. A grep for writes to `redeemedCount` returns this one statement, the
   schema default, and read-only selects.

2. **The ladder treats any redemption as full consumption.** `computeCancellationRefund` skips the
   tier evaluation for a line with `redeemedCount > 0` and retains its full total
   (`cancellation-policy-engine.spec.md` D7). That is right for a passenger who travelled — you do
   not refund a trip that was taken. It fires identically on `redeemedCount = 1` of 10.

So the threshold for "this line is spent" is **one** pass, and the state that crosses it is
**write-once**. The customer's refund is destroyed by an agent's slip, and the only remedy today is
the admin's `override_note` path on `POST /api/folios/:id/refund/confirm` — which records a refund
that the quote says is zero, i.e. an out-of-band correction, not a fix.

### Impact and scope

- Predates every current feature; not introduced by Express Sale or Group Redemption.
- **Group redemption (`all_passes`, US-A79) does not create this bug but sharpens it:** the ladder
  already fires at the first pass, so refundability is lost either way — but a mis-scan under
  `all_passes` also burns the whole party's boarding rights in one tap, where `per_pass` burns one.
  This is called out in `docs/scanner/group-redemption.spec.md` § Open.
- Money is only lost when the customer subsequently cancels, so the incident and the loss are
  separated in time and nobody connects them.

### Proposed fix (not yet decided)

Smallest change that closes it: an **admin-only** `POST /api/tickets/:folioLineId/unredeem` taking a
required audit note, decrementing (or zeroing) `redeemed_count`, tenant-scoped like every other
admin folio route. It needs a product decision first — **who may forgive a boarding**, and whether
the correction is visible on the folio history — so it is recorded here rather than specified.

A cheaper mitigation, if the endpoint is judged too much: a **confirmation step in the scanner** when
`quantity > 1`, which reduces the accident rate without making the state recoverable. It does not
close the bug.

---

## BUG-017 — Any Idle Gap Longer Than 15 Minutes Forces a Full Re-Login — ✅ FIXED

**Discovered:** 2026-07-30
**Fixed:** 2026-07-30
**Reporter:** Leo Licona (field report: "as admin I have to enter the password a lot of times during the day")
**Affected component:** `api-turistear/src/middleware/auth.ts:127-131`, `api-turistear/src/utils/cookies.ts:9`
**Severity:** High — the single largest source of forced logins; worst on the smartphones agents use in the field.

### Symptom

An admin or agent types their email and password several times a day, despite a 60-day sliding
refresh token. Reliably reproducible: leave the app idle for more than 15 minutes (screen lock,
backgrounded PWA, a bus ride), return, and land on `/login`.

### Root Cause

Two decisions that are each defensible alone and fatal together:

1. `ACCESS_MAX_AGE = 60 * 15` (`cookies.ts:9`) gave the `gm_access` cookie a 15-minute `Max-Age`,
   even though the JWT it carries lives 10 minutes. The browser therefore *deletes* the cookie
   during any idle gap.
2. `authMiddleware` bailed out the moment `gm_access` was absent (`auth.ts:127-131`), throwing 401
   **without ever reading `gm_refresh`** — which was sitting in the very same request, valid for
   another 60 days.

So transparent renewal only worked inside the narrow window `[T+10min, T+15min]`. Outside it the
401 was unrecoverable, and `authService.ts` turned it into `window.location.replace('/login')`.

The behaviour was codified as intentional in `docs/auth/admin-login-session.spec.md` Scenario 9
("No refresh is attempted") and pinned by a test asserting `refreshSpy` was never called. The spec
conflated "no access token" with "no session" — but possession of a valid refresh token *is* a
session. Distinct from BUG-014's rotation stampede, which is narrower and still open.

### Fix

Both cookies now carry the idle-session window (`SESSION_REFRESH_TTL_SECONDS`); the access cookie
deliberately outlives the token it holds, since the JWT's own `exp` is the real gate and
`auth.ts:136` validates it on every request — the short `Max-Age` bought no security. And
`authMiddleware` now refuses only when **both** cookies are absent; a lone `gm_refresh` falls
through to the existing renewal path. Scenario 9 was re-scoped to "no session cookie at all" and a
new Scenario 7b covers renewal from a lone refresh cookie.

---

## BUG-016 — Manual Cancellation Never Releases Zoned Seats (Zone Counter Permanently Inflated) — ✅ FIXED

**Discovered:** 2026-07-27
**Fixed:** 2026-07-27
**Reporter:** Claude Code (found while specifying the Cancellation Policy Engine)
**Affected component:** `api-turistear/src/routes/folios/handler.ts` (`applyCancellation`)
**Severity:** High — silent, permanent inventory loss on zoned services. No error, no log; the
seats simply stop existing.

### Symptom

Cancelling a folio for a **zoned** service (US-A64 — e.g. a Turibus with *Bajo* / *Alto* decks)
appears to work: the folio flips to `cancelled` and `slots.booked` drops. But the seats are never
resold. The zone shows as fuller than it is, and the next time anything reconciles the slot, the
slot total snaps back up too.

### Root Cause

For a zoned service the authoritative counter is `slot_zones.booked`; `slots.capacity` / `booked`
are **derived** from the zone sums by `reconcileSlotTotals` (`services/zones.reconcile.ts`), so
every existing availability read keeps working unchanged.

`applyCancellation` — the shared commit for the admin cancel and the tourist-request approval —
decremented `slots.booked` directly for every line and **never looked at `zone_id`**:

```ts
const statements = lines.filter((l) => l.slotId).map((line) =>
  db.update(slots).set({ booked: sql`MAX(0, ${slots.booked} - ${line.quantity})` })…)
```

So on a zoned line: the zone row kept its seats (inflated forever → unsellable), and the write to
the derived `slots.booked` was itself doomed — the next reconcile recomputed it from the still-
inflated zone sums and undid it.

Every **other** release site already branched on `zone_id` — `cancelBooking`
(`pos/handler.ts:2613`), `rejectPayment` (`:2502`), and `sweepExpiredBookings`
(`pos/sweep.ts:62`), each pairing a `slot_zones` decrement with `reconcileSlotTotals` in the same
batch. The manual cancellation path was the one that was missed when zoned capacity shipped.

### Fix

`applyCancellation` now branches per line exactly like its three siblings: a zoned line decrements
`slot_zones.booked` and composes `reconcileSlotTotals` into the **same** D1 batch; an unzoned line
keeps the old slot decrement. Both keep the `MAX(0, …)` clamp this path has always had, so a
hand-edited counter can never go negative. Both call sites now select `folio_lines.zone_id`.

Deliberately not changed: the race-safe two-step order (guarded folio flip first, seats only for
the winner — BUG-013) is untouched.

### Test Coverage

`test/folios/folio-cancellation.test.ts` → `describe('Zoned cancellation releases zone seats
(regression)')` — 5 cases: the zone counter is released; the release **survives a later
reconcile** (the part that made the loss permanent); an unzoned line still works; a mixed
zoned + unzoned folio releases both; the zone counter clamps at zero. All 4 zoned cases were
verified to **fail** against the pre-fix handler and pass after.

---

## BUG-015 — Blank Page After Login Until Manual Refresh (Failed Lazy Chunk + No ErrorBoundary) — ✅ FIXED

**Discovered:** 2026-06-12
**Fixed:** 2026-06-12
**Reporter:** Leo Licona (symptom) / Claude Code (root-cause analysis)
**Affected component:** `app-turistear/src/App.tsx`, `app-turistear/src/main.tsx`, `app-turistear/wrangler.jsonc`
**Severity:** High — login intermittently appears broken; only a manual refresh recovers.

### Symptom

Sometimes, after submitting the login form, the page goes **completely blank** (white). Refreshing
loads the app correctly and the session is already active.

### Root Cause (primary hypothesis)

Every page is `lazy()`-loaded (`App.tsx:10-32`) and the app has **no ErrorBoundary anywhere**
(verified by grep). The post-login landing page (`PosCatalogPage` / `DashboardPage`) is a separate
hashed chunk fetched **at the moment of navigation after login**:

1. The user opens `/login`; the browser holds an `index.html` referencing that deploy's chunk hashes.
2. The app is **redeployed** (or the dev server restarts) while the login page sits open.
3. Login POST succeeds → session cookies are set. `navigate('/pos')` triggers
   `import('./pages/PosCatalogPage')` → the old chunk hash no longer exists. With
   `not_found_handling: "single-page-application"` the asset request resolves to `index.html`
   (or 404), so the dynamic import rejects.
4. `<Suspense>` only handles *pending*, not *rejected*; with no ErrorBoundary, React unmounts the
   **entire root** → permanent white page.
5. F5 loads the fresh `index.html`; the cookies from step 3 are already set → "session appears active".

This matches all three observations: *sometimes* (only across a redeploy/restart), *blank* (root
unmounted), *refresh fixes it and the user is logged in*. Confirm by checking the browser console
for `Failed to fetch dynamically imported module` when it reproduces.

### Fix

`src/layout/AppErrorBoundary.tsx` (new), wired around `<App />` in `main.tsx`:
- Any uncaught render error now shows a "Algo salió mal / Recargar" screen instead of a
  blank page.
- A chunk-load error (matched by message: `Failed to fetch dynamically imported module`,
  `Importing a module script failed`, …) triggers an automatic `window.location.reload()`,
  rate-limited via a sessionStorage timestamp (≥ 10 s between auto-reloads) so a genuinely
  broken deploy can't reload-loop. The reload self-heals the stale-chunk case: the fresh
  `index.html` carries the new hashes and the session cookie survives.

Root-cause confirmation pending a real-world repro (check the console for the chunk-load
message next time) — but the boundary fixes the blank-page failure mode for ANY render error.

---

## BUG-014 — Concurrent Token Refresh Stampede Can Destroy a Valid Session — ✅ FIXED

**Discovered:** 2026-06-12
**Fixed:** 2026-06-12
**Reporter:** Claude Code (static analysis)
**Affected component:** `api-turistear/src/middleware/auth.ts:78-111`
**Severity:** High — intermittent forced logouts after ~15 min of idle.

### Symptom

After the 15-minute access token expires while the app is open, returning to the tab sometimes
bounces the user to `/login` even though the refresh token was valid.

### Root Cause

On window focus, React Query refires several queries **in parallel** (AppLayout badge counts at
`AppLayout.tsx:75-83` plus the page query). Each request hits `authMiddleware`, sees the expired
`gm_access`, and independently calls `refreshTokens()` with the **same** `gm_refresh` cookie. If the
auth service rotates refresh tokens (single-use), one request wins and sets the new cookie pair while
the losers throw and call `clearSessionCookies()` (`auth.ts:88-89`). Whichever response reaches the
browser **last** wins the cookie jar — a loser arriving after the winner wipes the brand-new valid
cookies. Client-side, the losers' 401s also trigger `handleUnauthorized` → hard redirect to `/login`.

### Fix

`authMiddleware` no longer emits delete-cookie headers when `refreshTokens()` fails — a loser
of the rotation race can no longer wipe the winner's freshly set session. A genuinely dead
refresh token grants nothing and keeps 401ing, so leaving it in place is safe; the conclusive
paths (user no longer exists, suspended) still clear. Test
`admin-login-session.test.ts` Scenario 8 updated to assert NO Set-Cookie headers on a failed
refresh. (Serializing refresh per user — lock/DO — remains a possible hardening if the auth
service's rotation proves strict single-use under heavy parallelism.)

---

## BUG-013 — Concurrent Folio Cancellation Releases Seats Twice — ✅ FIXED

**Discovered:** 2026-06-12
**Fixed:** 2026-06-12
**Reporter:** Claude Code (static analysis)
**Affected component:** `api-turistear/src/routes/folios/handler.ts` (`buildCancellationBatch`, `cancelFolio`, `approveCancellationRequest`)
**Severity:** Medium — inventory integrity: `booked` undercount → oversell.

### Symptom

Two near-simultaneous cancellations of the same folio (double-click, or direct admin cancel racing a
tourist-request approval) decrement `slots.booked` twice per line.

### Root Cause

The batch built by `buildCancellationBatch` (`handler.ts:239-269`) runs the per-line slot releases
**unconditionally**; the `ne(folios.status, 'cancelled')` guard sits only on the folio UPDATE. A
0-row guarded UPDATE does **not** abort a D1 batch, so the loser's batch still applies its slot
decrements (`MAX(0, booked − qty)` only prevents going negative, not double release). The pre-check
(`cancelFolio:334`) reads `status` before either batch commits, so both pass it.

### Fix

`buildCancellationBatch` replaced by `applyCancellation`: the guarded folio UPDATE
(`status != 'cancelled'`, with `.returning()`) runs FIRST; only the winner then releases the
seats in one batch. A racing loser releases nothing and both entrances (`cancelFolio`,
`approveCancellationRequest`) surface it as the existing 409 "already cancelled". The refund
fields ride the guarded flip, so they can never apply to a folio someone else cancelled.
Residual (accepted, conservative): a crash between flip and release leaves seats booked on a
cancelled folio — no oversell, same compensate-style trade-off as POS confirm.

---

## BUG-012 — `createSchedule` Bulk Insert Exceeds D1's 100-Bound-Parameter Limit — ✅ FIXED

**Discovered:** 2026-06-12
**Fixed:** 2026-06-12
**Reporter:** Claude Code (static analysis)
**Affected component:** `api-turistear/src/routes/services/slots.handler.ts:87,407-409`
**Severity:** Medium — recurring schedules that materialize ≥ 12 slots fail.

### Symptom

Creating a weekly schedule over a window producing 12+ slot dates throws a D1 error
(`too many SQL variables` / bound-parameter limit), after the `schedules` row was already inserted —
leaving a schedule with partial (or zero) materialized slots.

### Root Cause

```ts
// slots.handler.ts:85-87 — the comment's column count is stale
// "Each materialized slot row binds 7 columns, so keep bulk inserts well under the limit."
const INSERT_CHUNK = 12
```

Each row now binds **9** values (`id, organizationId, serviceId, scheduleId, date, startTime,
capacity, booked, status` — `createdAt`/`updatedAt` use SQL defaults). 12 × 9 = **108 > 100**
(D1's documented per-query bound-parameter cap). The chunk size was computed for a 7-column row
that has since grown.

### Fix

`INSERT_CHUNK` is now DERIVED — `Math.floor(100 / 9) = 11` rows → 99 parameters — so a future
column addition shrinks the chunk instead of overflowing the cap. The chunked inserts also run
in a single `db.batch`, so a mid-way failure can no longer strand a half-materialized schedule.
Regression test added: a Mon–Fri schedule over 4 weeks (20 slots) materializes successfully
(`test/catalog/schedules-slots.test.ts`).

---

## BUG-011 — `inviteAgent` Expires Pending Invitations Across ALL Organizations — ✅ FIXED

**Discovered:** 2026-06-12
**Fixed:** 2026-06-12
**Reporter:** Claude Code (static analysis)
**Affected component:** `api-turistear/src/routes/agents/handler.ts:36-44`
**Severity:** Medium — multitenancy isolation violation (Rule: every tenant-scoped write must be org-filtered).

### Symptom

Org A's admin invites `bob@x.com`; Org B's still-pending invitation for the same email is silently
flipped to `expired` — Org B's invite link stops working with no notice to anyone.

### Root Cause

The "supersede previous invites" UPDATE filters only by `identity` and `status`:

```ts
.where(and(eq(invitations.identity, input.identity), eq(invitations.status, 'pending')))
// ← missing eq(invitations.organizationId, admin.organizationId)
```

### Fix

Added `eq(invitations.organizationId, admin.organizationId)` to the supersede UPDATE, plus a
cross-org regression test (`test/auth/agent-invitation.test.ts`): org B inviting the same
identity leaves org A's pending invitation untouched while creating its own.

---

## BUG-010 — Email Verification Is a State-Changing GET Behind `useQuery` (Single-Use Token Burns) — ✅ FIXED

**Discovered:** 2026-06-12
**Fixed:** 2026-06-12
**Reporter:** Claude Code (static analysis)
**Affected component:** `api-turistear/src/routes/auth/index.ts:33` (+ `handler.ts:95-129`), `app-turistear/src/features/auth/hooks/useVerify.ts`
**Severity:** Medium — users see "Verificación fallida" for accounts that verified fine.

### Symptom

A user opens the verification link, sees success — then switches tabs and back (or the page
refetches for any reason) and the screen flips to "El enlace es inválido o ha expirado". Worse:
corporate/AV email link-scanners that prefetch GETs can consume the token **before the user ever
clicks**.

### Root Cause

`GET /api/auth/verify` consumes a single-use magic-link token (state-changing GET). The client wraps
it in `useQuery` with `retry: false` but default `refetchOnWindowFocus`/`refetchOnMount`, so any
refetch re-submits the already-consumed token and the query flips from success to error, which the
page renders as failure.

### Fix

- Server: added `POST /api/auth/verify` (zod-validated body, same handler); the GET route
  stays for legacy deep-links only.
- Client: `verifyEmail` now POSTs, and `useVerify` runs exactly once — `staleTime/gcTime:
  Infinity`, `refetchOnMount/WindowFocus/Reconnect: false`, `retry: false` — so a delivered
  success can never be overwritten by a refetch of a consumed token.
  (Note: the email's magic link points at the APP page, not the API, so non-JS scanner
  prefetches never consumed the token; the practical trigger was tab-focus refetch.)

---

## BUG-009 — Signed QR Access Tokens Sent to a Third-Party QR Image Service — ✅ FIXED

**Discovered:** 2026-06-12
**Fixed:** 2026-06-12 (portal; see residual note for the email)
**Reporter:** Claude Code (static analysis)
**Affected component:** `api-turistear/src/routes/portal/handler.tsx:26-27` (and the confirmation email per its comment)
**Severity:** Medium (security/privacy) — the entry credential leaves the trust boundary.

### Symptom / Risk

The portal page (and ticket email) render QR images via
`https://api.qrserver.com/v1/create-qr-code/?...&data=<signed ticket token>`. The signed token **is**
the access credential the scanner redeems. A third party (plus any intermediary caches/logs) receives
every customer's valid entry tokens.

### Fix

The portal now renders QRs locally as inline SVG via `uqr` (tiny, zero-dep encoder) — the
signed token never leaves our origin; tests assert `<svg` present and `qrserver.com` absent.

**Residual:** the confirmation EMAIL still embeds `qrserver.com` images (`services/resend.ts`)
because mail clients only render hosted `<img>` URLs and refuse `data:` URIs. Closing it needs
a self-hosted QR-image endpoint (e.g. a PNG render served from the API origin) — tracked as
follow-up, not done here.

---

## BUG-008 — Dev Port Roulette: App Can Proxy `/api` to Its Own Stub Worker (Fake Login Success) — ✅ FIXED

**Discovered:** 2026-06-12
**Fixed:** 2026-06-12
**Reporter:** Claude Code (static analysis)
**Affected component:** `app-turistear/vite.config.ts` (proxy target `http://localhost:5173`), `app-turistear/worker/index.ts`
**Severity:** Medium (dev only) — intermittent, very confusing auth behavior in local dev.

### Symptom

In local dev, login sometimes "succeeds" with any credentials and then immediately bounces back to
`/login`; API data never loads.

### Root Cause

Both workspaces run plain Vite; whichever starts first claims port 5173. The app's proxy targets
`http://localhost:5173` assuming that's the API. When the **app** wins the port (e.g. `dev:app` alone,
or `pnpm dev` startup-order race), `/api/*` loops back into the app's own stub worker, which returns
`Response.json({ name: "Cloudflare" })` with **200 for every `/api/` path** — so `POST /api/auth/login`
"succeeds", then `getMe` resolves `res.user === undefined` and TanStack v5 errors with
"query data cannot be undefined" → bounce to `/login`.

### Fix

Ports pinned with `strictPort: true` — API on 5173, app on 5174 (a collision now fails loudly
instead of silently shifting). The app's stub worker answers `/api/*` with a 404 + explanatory
error body instead of the fake `{ name: "Cloudflare" }` 200.

---

## BUG-007 — "Org-Local Today" Is Actually UTC: POS Day Windows Shift After ~18:00 (UTC-6) — ✅ FIXED

**Discovered:** 2026-06-12
**Fixed:** 2026-06-12
**Reporter:** Claude Code (static analysis)
**Affected component:** `app-turistear/src/features/pos/dates.ts:6`, `src/pages/PosCatalogPage.tsx:40`, `api-turistear/src/routes/pos/handler.ts:38`
**Severity:** Medium — every evening, "Hoy" silently becomes tomorrow.

### Symptom

For a Mexico-based org (UTC-6), from ~6 pm local time onward: the default "Hoy" 3-day window anchors
on **tomorrow**, today's remaining slots vanish from the default catalog view, the date picker's
`min` forbids selecting the actual current day, and `SlotPicker`'s "Hoy" label lands on the wrong row
(`dayLabel` parses with *local* midnight while `todayStr()` is UTC — mixed bases).

### Root Cause

`new Date().toISOString().slice(0, 10)` yields the **UTC** calendar date. The comments document a
"single-timezone MVP model (org-local)", but the implemented timezone is UTC, not the org's.

### Fix

`features/pos/dates.ts#todayStr` now builds the date from the DEVICE's local calendar
(`getFullYear/getMonth/getDate`), not `toISOString()` — staff devices run in the org's
timezone (single-timezone MVP). `PosCatalogPage`'s duplicate local copy was removed in favor
of the shared helper, so catalog, sheet, and detail all agree, and `SlotPicker.dayLabel`'s
local-midnight parsing is now consistent with the anchor. The client pins the value to the
API via the existing `?today=` / `?from=` params.

**Residual (accepted):** the server's `utcToday()` fallback still applies when a client omits
the pin, and an `org.timezone` column would be needed for true org-local server-side dates —
deferred with the single-timezone MVP model.

---

## BUG-006 — Logout Is Fire-and-Forget: A Failed Logout POST Leaves the Session Alive — ✅ FIXED

**Discovered:** 2026-06-12
**Fixed:** 2026-06-12
**Reporter:** Claude Code (static analysis)
**Affected component:** `app-turistear/src/features/auth/hooks/useLogout.ts:17-18`
**Severity:** Low/Medium (security) — same shared-machine class as BUG-003's residual note.

### Symptom

User clicks "Cerrar sesión", lands on `/login`, closes the laptop. If the logout POST failed
(offline, server hiccup), the httpOnly cookies were never cleared and the refresh token was never
revoked — the next visit is silently authenticated again.

### Root Cause

`handleLogout` navigates first and fires `mutation.mutate()` with the result ignored; the client
cannot clear httpOnly cookies itself, so the POST is the only thing that ends the session, and its
failure is invisible.

### Fix

`useLogout` now AWAITS the logout POST before evicting `['me']` and navigating (the confirm
dialog already shows `isPending`, so the UX cost is one spinner). On failure it stays put and
exposes `isError`, which `AccountMenu`'s dialog renders as "No se pudo cerrar la sesión…" with
the button available for retry. This also closes BUG-003's residual sub-second race (back-press
before the cookies cleared server-side), which had been deferred.

---

## BUG-005 — Post-Login `fetchQuery(['me'])` Silently Retries a Failing `/api/me` 3 Times — ✅ FIXED

**Discovered:** 2026-06-12
**Fixed:** 2026-06-12
**Reporter:** Claude Code (static analysis)
**Affected component:** `app-turistear/src/features/auth/components/LoginForm.tsx:48-52`
**Severity:** Low — ~7 s frozen login button when `/api/me` genuinely fails after login.

### Root Cause

`useMe` sets `retry: false`, but that is an **observer** option; `queryClient.fetchQuery` here doesn't
inherit it and uses the client default (`retry: 3` with backoff). Each retried 401 also re-runs the
global `handleUnauthorized` interceptor (harmless on `/login`, but noisy).

### Fix

`retry: false` passed to the post-login `fetchQuery`, and `AuthGuard`'s comment updated — it
still described the old invalidate-based flow this `fetchQuery` replaced.

---

## BUG-004 — Authenticated Users Get the Login Form on `/` and Unknown Paths — ✅ FIXED

**Discovered:** 2026-06-12
**Fixed:** 2026-06-12
**Reporter:** Claude Code (static analysis)
**Affected component:** `app-turistear/src/App.tsx:183`, `app-turistear/src/pages/LoginPage.tsx`
**Severity:** Low (UX) — reads as "my session was lost".

### Symptom

Opening the bare domain (`app.turistearya.com/`) or any unknown path with a live session shows the
login form instead of the app.

### Root Cause

The `*` catch-all navigates to `/login`, and `LoginPage` never checks for an existing session.

### Fix

The `*` catch-all now renders a session-aware `RootRedirect` (in `App.tsx`): it consults
`useMe()` (spinner while resolving) and forwards an authenticated user to their role landing
(admin → `/dashboard`, agent → `/pos`, mirroring US-UX01); logged out still → `/login`.
Visiting `/login` directly with a live session still shows the form — deliberate, to keep the
login/logout flows simple.

---

## BUG-003 — Back Button After Logout Restores the App from Stale React Query Cache — ✅ FIXED

**Discovered:** 2026-06-09
**Fixed:** 2026-06-09
**Reporter:** Leo Licona (manual QA)
**Affected component:** `app-turistear/src/features/auth/hooks/useLogout.ts`
**Severity:** Security — a borrowed/shared machine remains fully accessible after a "logout".

### Symptom

Clicking **Log out** correctly redirects to `/login`. But pressing the browser **back button**
returns the user to `/dashboard` (or any prior protected route) with the session apparently
active — the entire app is navigable without re-authenticating.

### Root Cause

`useLogout` cleared the Zustand store and navigated to `/login`, but **never evicted the
`['me']` React Query cache**:

```ts
// WRONG — cache survives; back-nav re-renders AuthGuard from it
const handleLogout = () => {
  clear()                                  // Zustand only
  navigate(ROUTES.LOGIN, { replace: true })
  mutation.mutate()                        // logout API fires async
}
```

The chain that produced the bug:

1. `useMe` (`useMe.ts:13`) caches the user with `staleTime: 5 * 60 * 1000` — fresh for 5 min.
2. `BrowserRouter` (History API) handles the back button as a client-side `popstate`, **not** a
   full page reload, so the in-memory React Query cache survives logout.
3. On back-nav, `AuthGuard` (`AuthGuard.tsx:11`) calls `useMe()`, gets a **cache hit** (still
   fresh), and returns the cached user with **no network request** → `isError: false`,
   `user != null` → it renders the protected page.
4. The `401` interceptor in `authService.ts` (`handleUnauthorized`) that would have redirected
   only runs when a request is actually made — the stale cache means `/api/me` is never called,
   so the safety net is bypassed.

The API side was innocent: `logout()` correctly clears both cookies (`gm_access`,
`gm_refresh`) via `clearSessionCookies()`. `navigate(..., { replace: true })` was **not** a
factor either — the back button reaches earlier protected history entries regardless of
push-vs-replace. The sole cause was the un-evicted `['me']` cache.

### Fix

Evict the `['me']` query in `handleLogout`, before navigating, so the next `useMe()` mount has
no cache → shows the spinner → hits `/api/me` → gets `401` (cookie already cleared) → `AuthGuard`
redirects to `/login`:

```ts
// CORRECT
const queryClient = useQueryClient()

const handleLogout = () => {
  clear()
  queryClient.removeQueries({ queryKey: ['me'] }) // kill cache before nav
  navigate(ROUTES.LOGIN, { replace: true })
  mutation.mutate()
}
```

`removeQueries` (not `invalidateQueries`) is deliberate: removing the entry forces
`isLoading: true` and a real refetch on the next mount, rather than serving stale data while a
background refetch resolves.

### Residual note

A sub-second race remains: if the user presses back **before** the async logout request clears
the cookies server-side, `/api/me` could still return `200`. The reported scenario (human
reaction time between clicking logout and pressing back) is fully resolved by the cache
eviction; closing the race entirely would require awaiting `mutation` before navigating, at the
cost of logout snappiness — deferred as not worth the UX trade for the MVP.

### Related changes

- `app-turistear/src/features/auth/hooks/useLogout.ts` — `removeQueries(['me'])` before navigate

---

## BUG-002 — `commission_bonus` Applied as Flat Centavos per Pass Instead of % of Line Total — ✅ FIXED

**Discovered:** 2026-06-08
**Fixed:** 2026-06-08 (deployed `2619f2d2`)
**Reporter:** Leo Licona (manual verification)
**Affected component:** `api-turistear/src/routes/pos/handler.ts`

### Symptom

An agent with `base_commission = 1000` (10%) selling a service with `commission_bonus = 500` (5%) on a $1,000 sale received **$125** instead of **$150**. The system was consistently underpaying agents by the full service-bonus portion.

### Root Cause

The `bonusTotal` reduction in `confirmSale` used:

```ts
// WRONG — treats 500 as a flat centavo amount per pass
(sum, l) => sum + l.commissionBonus * l.quantity
```

`commission_bonus = 500` (basis points = 5%) was multiplied by `quantity` (e.g., 5 passes → `500 × 5 = 2,500` centavos = $25 bonus), rather than applied as a percentage of the line total (`5% × $1,000 = $50`). The bug caused the bonus to scale with pass count rather than sale value, and the discrepancy worsened as price per pass increased.

### Fix

Changed to percentage-of-line-total (consistent with `base_commission` treatment):

```ts
// CORRECT — 500 bp = 5% of line_total
(sum, l) => sum + Math.round((l.lineTotal * l.commissionBonus) / 10000)
```

### Data corrections (production)

Three production folios were under-credited and corrected:

| Folio | Was | Should Be | Delta |
|---|---|---|---|
| `2c3cab17` ($1,000 sale) | $125 | **$150** | +$25 |
| `2590a959` ($3,000 sale) | $400 | **$450** | +$50 |
| `999362eb` ($900 sale) | $115 | **$135** | +$20 |

Agent's balance adjusted: $875 → **$780** (the $95 difference credited).

### Related changes

- `api-turistear/src/routes/pos/handler.ts` — formula fix
- `api-turistear/src/routes/services/schema.ts` — `commission_bonus` validation: int 0–10000 (bp), replaces money validator
- `api-turistear/src/db/schema.ts` — column comment updated to clarify basis points
- `app-turistear/src/features/catalog/types.ts` — `percentToBasisPoints` / `basisPointsToPercent` helpers; field changed from `$` to `%`
- `app-turistear/src/features/catalog/schemas.ts` — validation 0–100 (percent in UI)
- `app-turistear/src/features/catalog/components/ServiceFormDialog.tsx` — conversion on prefill + submit
- `app-turistear/src/pages/CatalogDetailPage.tsx` — display as `X%` not money
- `docs/commissions/commissions.spec.md` — formula, data model, scenarios updated
- Tests: `pos-controlled-discount.test.ts` + `service-catalog.test.ts` corrected

---

## BUG-001 — Commission Formula Divisor `/100` Instead of `/10000` (1000× Overcharge) — ✅ FIXED

**Discovered:** 2026-06-07
**Fixed:** 2026-06-07
**Reporter:** Leo Licona (CURL validation)
**Affected component:** `api-turistear/src/routes/pos/handler.ts`

### Symptom

Two production folios had astronomical `commission_amount` values:

| Folio | Total | `commission_amount` | Effective rate |
|---|---|---|---|
| `062fe361` | $900 | $9,000 | **1000%** |
| `eabda6ba` | $1,390 | $35,550 | **2557%** |

### Root Cause

`agents/schema.ts` defined `base_commission` in **basis points** (`1000 = 10%`), but `pos/handler.ts` divided by `100`:

```ts
// WRONG — treats basis points as if they were simple integer percents
const baseCommission = Math.round((total * basePct) / 100)
// basePct = 1000 (10% in bp) → divides by 100 → 10× overcharge
```

A 10% agent (`base_commission = 1000`) produced a 1000% commission.

### Fix

```ts
// CORRECT — 10000 is the basis-point denominator (1000 bp = 10%)
const baseCommission = Math.round((total * basePct) / 10000)
```

### Data corrections (production)

| Folio | Was | Should Be |
|---|---|---|
| `062fe361` | $9,000 | **$900** |
| `eabda6ba` | $35,550 | **$427.50** |

A `820,000` centavo cash drop that had been confirmed against the inflated balance was reviewed and left as-is (arithmetically correct given all recorded transactions at that moment — user chose Option A).

### Related changes

- `api-turistear/src/routes/pos/handler.ts` — divisor `/100` → `/10000`
- Production D1 rows patched via `wrangler d1 execute`

---

*See also `docs/TECH_DEBT.md` for known limitations and accepted trade-offs that are not bugs.*
