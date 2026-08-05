# Feature: Reagendar mientras el lugar es tuyo — y cerrar diciendo qué pasó con el dinero

> **Supersedes `docs/bookings/bookings-down-payments.spec.md` US-AG07.5** (*reactivación*), whose
> scope table shipped the undo and deferred the reschedule. This document inverts that: the undo is
> retired and the reschedule becomes the mechanism. Extends `docs/bookings/apartado-stages.spec.md`
> (the ①/② model is unchanged) and `docs/folios/folio-state-machine.spec.md` (the outbox gains one
> event it should always have had).

## Context

An apartado today ends by disappearing, and the product has spent two features building around that
instead of fixing it.

### 1. Seats are released fifteen minutes before they can be sold

Four clocks sit around a departure and nothing makes them agree:

| Clock | Setting | Default | Decides |
|---|---|---|---|
| settle deadline | `booking_pre_departure_buffer_hours` | −24 h | ① → ② |
| **hold release** | `booking_grace_offset_minutes` | **+15 min (before)** | ② → cancelled |
| **sales cutoff** | `sales_cutoff_offset_minutes` | **0 (departure)** | when the slot stops selling |
| no-show margin | `no_show_margin_minutes` | 0 (departure) | when a paid seat reads wasted |

With the shipped defaults the apartado's seats go back to the pool **fifteen minutes before the
pool stops selling them**. An organization that sells *30 min after departure* (`−30`) opens that
gap to **forty-five minutes**. Nothing validates the pair — verified: no coherence rule exists
between them in `routes/organizations/handler.ts` or `SettingsPage.tsx`, while two others do
(`apartado-stages.spec.md` S1 and `folio-state-machine.spec.md` D23).

Releasing a seat you cannot sell is **pure loss**: the customer loses it and nobody gets it.

### 2. Reactivation is a repair for that gap, and it rewrites history to do it

`reactivateBooking` (`pos/handler.ts:3075`) clears `cancelled_at`, `cancelled_by` and
`cancellation_reason` — so a folio the system cancelled, and told the customer it cancelled, ends up
claiming the expiry never happened. Three things go with it, all verified:

- **`reminder_status` is not reset**, so the sweep's `if (folio.reminderStatus !== 'none') continue`
  skips the folio forever. A reactivated apartado is released a second time **with no warning at
  all** — the exact defect `apartado-stages.spec.md` exists to prevent, reopened by the repair.
- **`cancellation_source` stays `system_expiry`** on a live `booking` folio.
- For an organization whose terminal tier claws back commission, the cancellation's ledger reversal
  **stays reversed on a sale that is live again**.

### 3. The customer is told "about to", and never what happened

The sweep emits `booking_grace_entered` on entering ②. At the release instant it calls
`cancelFolioPriced` and **emits nothing**. The customer's last message says their spots are *about
to* be released; they never learn that they were, or that their deposit became the company's
revenue. `folio-state-machine.spec.md` D20 says every operation is written to the customer — losing
a deposit is an operation. *(This is an omission made in that feature's own build: `booking_expired`
was in the pre-D20 whitelist as obligatory and was dropped when the table was reorganised.)*

---

## Scope boundary

**Money does not move.** No phase changes the cancellation ladder, `amount_paid`, `commission_amount`,
the `folio_payments` ledger, or when a commission is booked. A reschedule moves a **date**.

**Mechanical criterion — these must pass unedited:**

- `test/cancellation/cancellation-policy-engine.test.ts` · `test/folios/folio-cancellation.test.ts`
- `test/pos/pos-bookings-settle.test.ts` · `test/pos/pos-bookings-create.test.ts`
- `test/paid-ledger/*.test.ts`

**One file is deliberately DELETED, not edited:** `test/pos/pos-bookings-reactivate.test.ts`, in
Phase 2, together with the endpoint it covers. A deletion is the honest form of retiring a feature;
editing those tests into something else would hide that a capability was removed.

`test/pos/pos-bookings-sweep.test.ts` **gains** assertions in Phase 1; its existing ones must not
change meaning.

---

## Design decisions

| # | Decision | Why |
|---|---|---|
| **D1** | **Rescheduling belongs to ① and ②, and moves the SAME folio.** | There, the seats are already yours: moving a hold you own takes nothing from anybody. Nothing ended — no ladder ran, no retention was taken, no message of loss was sent — so there is nothing to undo and no new folio to justify. It is the cheap operation, and it is the one the product never built. |
| **D2** | **A reschedule is a HUMAN action, agreed between the tourist and the agent.** Never a cron, never an automatic outcome of a clock. | *(User decision, and the industry agrees.)* A machine choosing a date for an absent customer **takes a seat from the pool and gives it to someone who has just demonstrated they do not arrive** — the opposite of protecting the operator. Airlines, hotels, OTAs and restaurants all reschedule only while the inventory is still held, always with a person present; none automate it. |
| **D3** | **Reactivation is RETIRED** — endpoint, UI and tests deleted. The honest operation when someone arrives after the hold ended is *a new sale with their credit applied*. | It erases `cancelled_at` and leaves the history asserting the expiry never happened, **after the customer was told it did**. And under D4 there is no longer a window in which a released seat is still sellable, so the case it was built for stops existing. **Counter-argument, recorded because it is real:** it is a proven counter shortcut, sellers know the screen, and retiring it is a product decision, not an architectural one. If this is ever reversed, the reason to re-read is D4 — the retirement rests on it. |
| **D4** | **The third coherence rule: the hold release may not precede the sales cutoff.** Validated server-side and mirrored in the form → `422 RELEASE_BEFORE_SALES_CUTOFF`. | Same shape as the two guards that already exist (`apartado-stages.spec.md` S1's `cutoff ≥ buffer`; `folio-state-machine.spec.md` D23's `margin ≤ cutoff`), and the same reasoning: two settings that describe the same moment from different sides have to agree about it. Releasing inventory nobody can buy is loss with no beneficiary. |
| **D5** | **No third stage.** The ①/② model is unchanged. | An earlier draft of this design added **③ LIBERADO** — seats returned, folio still recoverable — so that reactivation could become a transition instead of an undo. D3 retires reactivation, which removes the only thing ③ existed for. Recorded rather than dropped silently, because ③ is the obvious idea and the next reader will have it too. |
| **D6** | **At the close the ladder runs, and what it does NOT retain becomes a CREDIT on the folio — not cash.** | There is nobody standing there to hand cash to: the close is produced by a clock, and the customer is absent by definition. A refund obligation would create a debt with a PIN nobody asked for. The credit is the same money, in the only form that can be delivered to an absent person. |
| **D7** | **The ladder stays the single source of *how much*.** This feature adds no percentage, no floor, no second knob. | `booking_deposit_retained_pct` was exactly that second knob and US-A76 **deleted** it — *"a hidden second rule that silently overrides the tiers I configured"*. An "autocancel vs reschedule" toggle at the release instant would reintroduce it wearing a different name. What the credit changes is not the amount but its **form**, which is why it is safe. |
| **D8** | **The inherited default still retains 100% at the terminal tier, so by default the credit is zero.** The feature does not make anyone more generous. | US-A76 chose that default deliberately: *"a default that refunds every deposit to every no-show is not conservative."* What this feature does is make the knob **usable** — today raising the terminal tier produces a cash refund somebody must physically hand over to a person who is not there; with a credit it produces something deliverable. |
| **D9** | **`booking_expired` returns to the outbox whitelist, and states the three figures**: paid · retained · credit (with its expiry date). | The customer's last message says *about to*. Restoring the event is not new scope — it is repairing an omission made in `folio-state-machine.spec.md`'s own build. The figures are there for the same reason the refund receipt carries them (that spec's rule 13): *"pagué 900, ¿dónde quedaron?"* is answered nowhere else. |
| **D10** | **The credit expires**, on an org setting (`booking_credit_valid_days`, default 90), and the closing message **must** state the date. | A perpetual credit is an unbounded liability on the books, and orgs differ on how long they will carry one. The message requirement is the load-bearing half: **a credit the customer discovers already expired is worse than never granting one** — it converts goodwill into a grievance. |
| **D11** | **A reschedule moves to another SLOT of the SAME service.** A different service is a different sale. | This is what got the feature deferred in the first place: a different service means re-quoting, and a deposit that silently over- or under-covers a new price. Bounding it to the same service keeps the line's snapshotted `unit_price` valid, so **no money is re-decided** — which is exactly what the Scope boundary promises. The wider case is listed under *Deferred* with this reason. |
| **D12** | **A reschedule is bounded by the same guards as a sale**: destination capacity (the atomic check `confirmSale` uses), the sales cutoff, and the apartado creation cutoff. | A rescheduled apartado must not be born inside its own settle window — the one-minute apartado `apartado-stages.spec.md` S1 was written to kill. Reusing the guards rather than re-implementing them is what keeps that true. |
| **D13** | **The reschedule is RECORDED** — from, to, who agreed it, when — in `folio_reschedules`. | D2 says a human agreed it; a record naming that human and that moment is the only thing that makes the claim checkable. It also answers the question an operator will ask second: *is rescheduling a courtesy or a pattern?* A column pair would only ever remember the last one. |
| **D14** | **Rescheduling resets `reminder_status` and clears the folio's stage-② outbox rows.** | The deadline moved, so the customer is owed a fresh warning for the new one — and today neither would fire: the flag skips the sweep, and `uq_notifications_folio_event_channel` blocks a second `booking_grace_entered`. **Cost, accepted:** the audit trail of the first warning is lost. Mitigated by D13, which records the reschedule itself, so the history is not blank — it says *the date moved*, which is the more useful fact. |
| **D15** | **Authorization mirrors settle/cancel/reminder**: the folio's own seller, or an admin. Cross-org → `404`. | Rescheduling is a sale-shaped action on a sale the seller owns. Inventing a different rule for it would be the kind of drift that makes a permission model unlearnable. |

---

## Data Model

### Phase 1 — no migration.

D4 is a validation over two columns that already exist; D9 is a whitelist entry.

### Phase 2 — migration `0060_booking_reschedule.sql`

```sql
-- D6/D10 — what a closed apartado leaves the customer, in the only form deliverable to somebody
-- who is not there. `credit_amount` is the ladder's non-retained remainder, SNAPSHOTTED at the
-- close: re-deriving it later would give a different answer, because the ladder is time-based and
-- the clock has moved. Zero for every org on the inherited default (D8).
ALTER TABLE folios ADD COLUMN credit_amount INTEGER NOT NULL DEFAULT 0;
ALTER TABLE folios ADD COLUMN credit_expires_at INTEGER;

-- D10 — how long the operator carries that liability. Its own column: it is an accounting horizon,
-- not one of the four departure clocks, and nothing about a departure should move it.
ALTER TABLE organizations ADD COLUMN booking_credit_valid_days INTEGER NOT NULL DEFAULT 90;

-- D13 — the record that makes "agreed between the tourist and the agent" checkable. A table rather
-- than a column pair, because an apartado can be rescheduled more than once and the second time is
-- the one an operator wants to see.
CREATE TABLE folio_reschedules (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL REFERENCES organizations(id),
  folio_id         TEXT NOT NULL REFERENCES folios(id),
  folio_line_id    TEXT NOT NULL REFERENCES folio_lines(id),
  from_slot_id     TEXT NOT NULL REFERENCES slots(id),
  to_slot_id       TEXT NOT NULL REFERENCES slots(id),
  from_departure   TEXT NOT NULL,   -- 'YYYY-MM-DD HH:MM', snapshotted like the line's own
  to_departure     TEXT NOT NULL,
  -- The human D2 requires. Never null: a reschedule with no author is the thing this table exists
  -- to make impossible.
  agreed_by        TEXT NOT NULL REFERENCES users(id),
  created_at       INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX idx_folio_reschedules_folio ON folio_reschedules(organization_id, folio_id, created_at);
```

**Nothing is dropped.** `reactivateBooking` goes, but no column does: `booking_expires_at` and
`cancelled_*` keep their meaning, and folios reactivated before this feature stay readable.

---

## Business rules (enforced server-side)

1. A folio may be rescheduled only while `status = 'booking'` — i.e. in ① or ② — and only before its
   release instant. Anything else → `409 NOT_RESCHEDULABLE`.
2. The destination slot must belong to the **same service** as the line being moved (D11); otherwise
   `422 DIFFERENT_SERVICE`.
3. The destination must pass the **same atomic capacity guard** `confirmSale` applies, including the
   flex margin → `409 NO_CAPACITY_AVAILABLE`, with the source seats **not** released until the
   destination is secured.
4. The destination must be sellable under `sales_cutoff_offset_minutes` → `409 SLOT_CLOSED`.
5. The destination must satisfy `booking_creation_cutoff_hours` → `422 BOOKING_TOO_LATE`.
6. A successful reschedule releases the source seats, blocks the destination, rewrites the line's
   snapshotted departure, and recomputes `booking_expires_at` from the **new** departure.
7. **No money moves**: `amount_paid`, `commission_amount`, `cancellation_policy_snapshot` and every
   `folio_payments` row are untouched.
8. A reschedule writes exactly one `folio_reschedules` row per line moved, with `agreed_by` = the
   caller (D13).
9. A reschedule sets `reminder_status = 'none'` and deletes the folio's `booking_grace_entered`
   outbox rows, so the new deadline gets its own warning (D14).
10. **The hold release may not precede the sales cutoff** (D4). Both are signed the same way
    (+ before / − after), so the rule is `booking_grace_offset_minutes ≤ sales_cutoff_offset_minutes`
    → `422 RELEASE_BEFORE_SALES_CUTOFF`. The form mirrors it.
11. At the release instant the sweep runs the ladder as it does today, and additionally stores
    `credit_amount = outcome.refund` and `credit_expires_at = now + booking_credit_valid_days`
    **only when `outcome.refund > 0`**. A zero credit stores no expiry — a date on nothing is noise.
12. The `booking_expired` notification states **paid · retained · credit**, and when a credit exists,
    the date it dies (D9/D10).
13. Every read and write is filtered by `organization_id`.

---

## Authorization — who may do this

| Action | Who |
|---|---|
| Reschedule a folio | the folio's **own seller**, or an **admin** |
| Read the reschedule history | anyone who can read the folio |
| Set `booking_credit_valid_days` | **admin** |

Cross-org → **`404`**, never `403`.

---

## API surface

### `POST /api/pos/folios/:id/reschedule`

```jsonc
// Request — one entry per line being moved. Explicit rather than "move everything": a folio with
// two tours may only need one of them moved, and guessing is how a customer loses the other.
{ "moves": [{ "folio_line_id": "…", "to_slot_id": "…" }] }
```

Returns the folio, re-read, with its new departures and `booking_expires_at`.

### `GET /api/folios/:id` · `GET /api/pos/folios/:id` *(extended)*

Gain `reschedules[]` (from, to, who, when) and, on a closed apartado, `credit_amount` /
`credit_expires_at`. Server-derived; refused from any request body.

### `PUT /api/organizations/me` *(extended)*

Accepts `booking_credit_valid_days` (1–730).

### Removed

**`POST /api/pos/folios/:id/reactivate` — deleted (D3).** A call to it returns `404`.

### Error responses

| Code | HTTP | When |
|---|---|---|
| `NOT_RESCHEDULABLE` | 409 | the folio is not a live apartado |
| `DIFFERENT_SERVICE` | 422 | the destination slot belongs to another service (D11) |
| `NO_CAPACITY_AVAILABLE` | 409 | the destination cannot seat the party |
| `SLOT_CLOSED` | 409 | the destination is past the sales cutoff |
| `BOOKING_TOO_LATE` | 422 | the destination is inside the apartado creation cutoff |
| `RELEASE_BEFORE_SALES_CUTOFF` | 422 | the settings would release seats nobody can buy (D4) |

---

## Frontend

Design system: `.design/design-system/DESIGN_TOKENS.md`. No new primitive.

**`BookingActions`** loses the *Reactivar y Liquidar* branch and the two `Próximamente` buttons, and
gains **Reagendar** on a live apartado, beside *Liquidar saldo* and *Cancelar*.

**The reschedule sheet** is a `FormSheet` (never a Dialog): it shows the current departure, a slot
picker reusing the POS date/time matrix — **restricted to the same service** (D11) and to slots that
pass the guards — and a confirm whose copy names both parties, because D2 is the point:
*"Acordado con el cliente · reagenda registrada a tu nombre."*

**The folio detail** shows the reschedule history when there is one, and on a closed apartado the
credit with its expiry — in `MoneyText`, semantic colour, never teal.

**A closed apartado with a credit** carries it on the card's money axis, so the seller sees it
without opening the folio: the customer standing in front of them is the one it belongs to.

---

## Scenarios

### US-AG52 — reschedule while the seats are still mine

**S-1 — a live apartado moves to another departure of the same service**
Given a `booking` folio in stage ① with 4 spots on Friday 09:00
When its seller reschedules the line to Sunday 09:00, which has capacity
Then the folio is still `booking`, the line reads Sunday 09:00, Friday's `booked` drops by 4,
Sunday's rises by 4, and `booking_expires_at` is recomputed from **Sunday**.

**S-2 — no money moves**
Given the folio of S-1 with `amount_paid = 90000` and `commission_amount = 4500`
Then both are unchanged after the reschedule, no `folio_payments` row is written, and
`cancellation_policy_snapshot` is byte-identical.

**S-3 — the destination is checked before the source is released**
Given the destination slot is full
When the reschedule is attempted
Then `409 NO_CAPACITY_AVAILABLE` — and the SOURCE slot still holds the 4 spots.
*(The assertion that matters: a failed reschedule must not leave the customer with no seat at all.)*

**S-4 — a different service is refused**
Then `422 DIFFERENT_SERVICE`, and nothing moves (D11).

**S-5 — the destination cannot be inside its own settle window**
Given `booking_creation_cutoff_hours = 24` and a destination departing in 12 hours
Then `422 BOOKING_TOO_LATE` — the one-minute apartado cannot be created by the back door.

**S-6 — a departed destination is refused**
Then `409 SLOT_CLOSED`.

**S-7 — only a live apartado**
Given a `paid` folio, and separately a `cancelled` one
Then both return `409 NOT_RESCHEDULABLE`.

**S-8 — the agreement is recorded**
Then one `folio_reschedules` row exists per line moved, carrying both departures and
`agreed_by` = the caller (D13).

**S-9 — the new deadline gets its own warning**
Given the folio had already been warned (`reminder_status = 'sent'`, a `booking_grace_entered` row)
When it is rescheduled
Then `reminder_status = 'none'` and no `booking_grace_entered` row remains — so the sweep warns
again for the new deadline (D14).
*(The mutation this must catch: keeping the flag, which is what makes the second cycle silent
today.)*

### US-T09 — tell me what happened to my deposit

**S-10 — the close states the three figures**
Given an apartado that reaches its release instant with `amount_paid = 90000`
And a ladder whose terminal tier refunds 30%
When the sweep closes it
Then a `booking_expired` notification exists, and its text names **90000 paid · 63000 retained ·
27000 credit** and the date the credit dies.

**S-11 — a zero credit says nothing about a date**
Given the inherited default ladder (terminal tier retains 100%)
Then `credit_amount = 0`, `credit_expires_at IS NULL`, and the message states the retention without
promising a credit that does not exist.

**S-12 — the credit is snapshotted, not re-derived**
Given a folio closed with a credit
When the organization later edits its ladder
Then `credit_amount` is unchanged.

### US-A87 — do not release a seat I cannot sell

**S-13 — the coherence rule**
Given `sales_cutoff_offset_minutes = 0`
When an admin sets `booking_grace_offset_minutes = 15` (release 15 min BEFORE departure)
Then `422 RELEASE_BEFORE_SALES_CUTOFF`.
And `0` or any *after-departure* value is accepted.

**S-14 — the credit horizon is its own number**
Given an org changes `booking_credit_valid_days`
Then no departure clock moves, and no already-closed folio's `credit_expires_at` changes.

### Retirement (D3)

**S-15 — reactivation is gone**
When `POST /api/pos/folios/:id/reactivate` is called on a cancelled apartado
Then `404`, and the folio stays `cancelled`.
*(Asserted rather than assumed: a retired endpoint that silently still works is worse than one that
was never retired.)*

### Multitenancy isolation (required)

**S-16 — another org's folio cannot be rescheduled**
Given two organizations seeded with `seedTwoOrgs`
When org A reschedules org B's folio
Then **`404`** — never `403` — and org B's slots are untouched.

**S-17 — a destination slot in another org is not a destination**
Given org A's folio and org B's slot
Then `404`, and neither org's `booked` moves.
*(Mutation-verify BOTH org predicates, and record the result: on `folio_reschedules` the folio's
scope may make the line's redundant, exactly as it did in `folio-state-machine.spec.md` S-18.)*

---

## Definition of Done

### Phase 1 — say what happened, and stop releasing early *(no migration · `fix/apartado-close-honesty`)*

- [ ] D4's coherence rule in `PUT /api/organizations/me` + mirrored in `SettingsPage`
- [ ] `booking_expired` in the outbox whitelist, emitted by the sweep at the release instant
- [ ] S-10 (without the credit half) · S-11 · S-13
- [ ] `pos-bookings-sweep.test.ts` gains the emission assertions; its existing ones unchanged
- [ ] `SPEC.md`: US-A87, US-T09 partial, glossary

### Phase 2 — reschedule, credit, and the retirement *(migration `0060` · `feat/booking-reschedule`)*

- [ ] Migration `0060`
- [ ] `POST /api/pos/folios/:id/reschedule` with all six guards
- [ ] The credit written at the close; `booking_expired` carries its figures
- [ ] **`reactivateBooking` deleted** — endpoint, UI branch, and
      `test/pos/pos-bookings-reactivate.test.ts` **removed, not rewritten**
- [ ] S-1 … S-9, S-12, S-14 … S-17; S-3 and S-9 mutation-verified
- [ ] Reschedule sheet + history + credit on the card and the detail
- [ ] `SPEC.md`: US-AG52, Features by Phase, glossary; **US-AG07.5 struck through and annotated**

---

## Deferred — and why each is safe to defer

| What | Why it can wait |
|---|---|
| **Rescheduling to a different SERVICE** | It requires re-quoting, and a deposit that silently over- or under-covers a new price is exactly the kind of quiet money bug this spec's Scope boundary exists to prevent. Same-service covers the case the counter actually has: *"can I come Sunday instead?"* |
| **Spending the credit** | Phase 2 grants and expires it; applying it to a new sale is the checkout's problem, not the apartado's. Recorded openly: **until that ships, the credit is a promise the product cannot yet honour**, which is why D8's default of zero matters — no organization is handed an obligation it cannot discharge. |
| **Rescheduling a lodging stay** | Nights are a per-night guard rather than a slot; the shape differs enough to deserve its own scenarios instead of an `if`. |
| **Transferring the folio to another person** | *"No puedo ir, que vaya mi hermano"* is a different operation — it changes who, not when — and it touches identity and the QR. |

---

## Known behaviour change

1. **`Reactivar y Liquidar` disappears.** Sellers who use it will find *Reagendar* on live apartados
   instead, and for a customer arriving after the hold ended, an ordinary sale. **This is a removal,
   and it is the one thing in this spec a user will notice immediately.**
2. **Organizations whose release precedes their sales cutoff cannot save Settings** until they fix
   it. Every org on the shipped defaults is in exactly that state (release −15 min, cutoff 0), so
   **this will greet most operators on the first visit** — the form must say what to change, not
   merely refuse.
3. **A customer whose apartado expires now receives a message.** Nothing about the money changes;
   what changes is that they are told, with the figures.

---

## Open

| Question | The smallest change that would answer it |
|---|---|
| Should a rescheduled folio's *deposit* age with the original sale or the new departure for ladder purposes? | The ladder prices on the line's departure, so it already follows the new date. Worth confirming with an operator: a customer who reschedules twice into the future keeps buying time under a tier that never gets stricter. |
| Should there be a limit on reschedules per folio? | D13's table makes the count readable; a cap is one comparison. Do not add it before an operator sees the number — a limit invented ahead of the evidence is a rule nobody can justify to a customer. |
| Does a closed apartado with a live credit belong in the Ventas list, or on its own surface? | It is a folio, so today it stays in the list. If credits become common the answer probably changes, and the fulfilment facets are the precedent for how. |
