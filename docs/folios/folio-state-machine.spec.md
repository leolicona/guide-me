# Feature: The folio's state machine — six axes, one vocabulary, and messages that leave with the action

> Extends `docs/oversight/folio-lifecycle-unification.spec.md` (which unified where the states are
> *shown*; this one fixes what they *are*). Adds the sixth axis. Does **not** supersede anything.

## Context

The folio already is a state machine. It is just not a single-variable one, and three things have
gone wrong because nobody wrote that down.

### 1. Two labels lie, in shipped code

The same `status = 'booking'` is rendered with two different words on screens a seller sees in the
same session:

| File | Label for `booking` |
|---|---|
| `app-turistear/src/features/folios/components/FolioStatusChip.tsx:9` | **"Reserva"** |
| `app-turistear/src/features/folios/folioCardState.ts:217` | **"Apartado"** |

And a cancelled folio that was never owed a refund is labelled as refunded:

```ts
// folioCardState.ts — folioMoneyAxis
folio.refund_status === 'pending'
  ? { reading: { kind: 'refundOwed',    cents: folio.refund_amount ?? 0 } }
  : { reading: { kind: 'refundSettled', cents: folio.total } }   // ← also catches 'none'
```

`refund_status = 'none'` on a cancelled folio means the ladder retained everything and the customer
received nothing (`routes/folios/handler.ts:809-815`). That is the case US-A76 documents by name —
*a 30% deposit against a 50% retention refunds nothing*. The card renders it as
**"$1,500.00 (reembolsado)"**, on the reconciliation screen, about money the company kept.

Three distinct states — *owed* · *paid back* · **never owed** — compressed into two labels.

### 2. The wasted seat is invisible

`folio_lines.redeemed_count` is written by the scanner on every redemption. **Nothing reads it for
reporting.** A folio paid in full whose passengers never boarded looks identical, on every screen
and in every report, to one whose passengers boarded. The operator cannot answer *"how many seats
did I sell and nobody used, and on which departures"* — the single question that tells them where
their overbooking tolerance should go.

### 3. Notifications are sent inline, and most customers cannot be reached automatically

Every customer-facing message is dispatched from inside the handler that caused it. There is no
outbox, so a Resend outage silently consumes the one notification a customer gets — a defect already
paid for once (`apartado-stages.spec.md` S8, added during that build).

Worse for the stated goal of *taking work off the agent*:

| Field | Nullability |
|---|---|
| `folios.customer_phone` | required on every apartado (US-AG07 D4) |
| `folios.customer_email` | **nullable, never required** |

Email is the only channel that sends itself. A Worker cannot send WhatsApp — `wa.me` is a deep link
a human opens (`apartado-stages.spec.md` S4). So for a walk-up sale with no email, every
notification is a tap the agent must make. **A notification engine, on its own, does not reduce the
agent's work — it converts it into taps.** This spec is built around that constraint rather than
against it.

---

## Scope boundary

This feature must not change what a folio *is*.

**Mechanical criterion — these must pass unedited:**

- `test/folios/folio-cancellation.test.ts`
- `test/cancellation/cancellation-policy-engine.test.ts`
- `test/tickets/online-qr-scanner.test.ts` · `test/tickets/group-redemption.test.ts`
- `test/qr/folio-qr-signing.test.ts`
- `test/folios/folio-lifecycle-unification.test.ts`

Concretely:

1. **`folios.status` keeps exactly three values** — `paid` · `booking` · `cancelled`. No phase adds
   a fourth. The five gates that read `'paid'` (`tickets/handler.ts:108`, `ticket/handler.tsx:161`,
   `pos/handler.ts:2523`, `2873`, `2918`) are not touched.
2. **No new writer of state.** Phase 2 adds no cron and no column *on a folio or a line* — its one column is an organization **setting** (D23); fulfilment itself stays derived (D4).
3. **Money is untouched.** No phase changes `commission_amount`, the ladder, the ledger, or when a
   commission is booked.
4. **Phase 1 is byte-identical in behaviour** — it changes strings and one branch that was wrong.

---

## Design decisions

| # | Decision | Why |
|---|---|---|
| **D1** | **`status` does not grow. The folio has six orthogonal axes**: money (`status`) · clearance (`payment_verification`) · delivery (`tickets_sent_at`/`tickets_viewed_at`) · debt (`refund_status`) · hold stage (derived) · **fulfilment (new, derived)**. | An enum is one answer; a folio needs six at once. Collapsing them means either naming the cartesian product (3×3×3×3 = 81 values) or losing information — and losing information is what produced the `(reembolsado)` defect. Axes also compose: adding the sixth costs the other five nothing. |
| **D2** | **Fulfilment lives on the LINE**, with a roll-up on the folio. | The cancellation engine already prices per line (`LineOutcome`, `cancellationPolicy.ts:172`) and `redeemed_count` is per line. A folio with Isla Mujeres on Tuesday (scanned) and Chichén on Thursday (nobody came) has no single truth; a folio-level rule would have to lie about one of them. |
| **D3** | Values: **`pending` · `partial` · `fulfilled` · `no_show`**. | Without `partial`, two friends who did not board vanish from the report and the wasted seat — the whole point of the axis — stays invisible. *(Reachable only under `qr_redemption_mode = 'per_pass'`, the default — see **D24**.)* |
| **D4** | **Fulfilment is DERIVED, never stored.** No column, no migration, no cron. | *(Reverses the recommendation given during the interview.)* Enumerating who would write it turned up nobody: all four values fall out of `redeemed_count`, `quantity` and the line's snapshotted departure. This is `apartado-stages.spec.md` **S7** again — *a stored stage needs a writer, and a cron that writes state drifts from the clock that defines it*. Deriving also makes D5 free. |
| **D5** | **A scan always wins.** A passenger who boards after the grace instant is redeemed normally and the folio stops being a no-show. | Nothing to revert, because nothing was written. The scanner is the only party that knows whether someone showed up; a cron that had already stamped `no_show` would be asserting the opposite of an observation. |
| **D6** *(withdrawn)* | ~~**The no-show margin reuses `booking_grace_offset_minutes`, negative.** No new setting.~~ | **Withdrawn by D22.** That field already drives **two** clocks: it is the `tourBuffer` that fixes `booking_expires_at` for a near-departure sale, and it is where stage ② ends and the auto-cancellation fires (`pos/handler.ts:724-733`). An org setting it to −30 to mean *"half an hour past departure counts as a no-show"* would simultaneously move **every apartado's auto-cancellation to half an hour after departure**. One field, three clocks — the exact coupling `apartado-stages.spec.md` S1 refused when it gave apartados their own creation cutoff instead of reusing `sales_cutoff_offset_minutes`: *"one number cannot serve both."* |
| **D22** *(withdrawn)* | ~~**The no-show margin is a constant — `NO_SHOW_MARGIN_MINUTES = 120` — not a setting.**~~ | **Withdrawn by D23.** Its argument was *"nothing has asked to tune it"*. False: `/settings` already exposes **"Cierre de ventas"** with an *Antes / **Después*** selector, whose helper reads *"«Después» permite ventas de último minuto tras la salida"*. An organization using it is **selling seats for a departure that already left** — so a fixed margin either contradicts that org or is an arbitrary number for everyone else. |
| **D23** | **The no-show margin is its own organization setting** — `no_show_margin_minutes`, signed like its neighbours (+ before / − after departure), **default 0** = the departure instant. It gets its own input in `/settings` beside *Cierre de ventas* and *Liberación de apartado*, with the same *Antes / Después* control. | *(User decision.)* It must be **its own column** — that part of D6's withdrawal stands and is the whole reason this is not `booking_grace_offset_minutes` or `sales_cutoff_offset_minutes`: those two already drive the apartado's release and the sales gate, and one number cannot serve two intents (`apartado-stages.spec.md` S1). **Default 0** because the departure is the honest default and matches the operator's own words. The **validation** is what makes it coherent: the margin may not fall **earlier than the last moment a seat is still sellable** (`sales_cutoff_offset_minutes` when negative) — otherwise the system marks a customer absent before it sold them their ticket. Same shape as S1's `límite ≥ plazo` guard. |
| **D8** | **The word "Reserva" is retired from the product.** Three terms: **Apartado** (partial payment, balance owed) · **Pagado** (paid in full) · **Por verificar** (money received, not confirmed). | "Reserva" describes what apartado *and* pagado both do — both block inventory — so it distinguishes nothing, and it is already used for both meanings in shipped UI. Retiring it is cheaper than defining it. |
| **D9** | **"Por verificar" is not a stage before apartado/pagado.** A transfer sale is created as apartado or pagado and **decrements seats immediately** (`pos/handler.ts:1642`); what is withheld is the **QR**, not the inventory. | Stating it the other way would be a spec that contradicts the code. The honest description is a clearance axis over a folio that already exists. |
| **D10** | **An unverified transfer keeps blocking seats.** | The alternative punishes the customer who genuinely paid while the admin sleeps, to defend against a customer who lied to a seller looking at a receipt. The verification queue is the control for the second; there is no control for the first. |
| **D11** | **Commissions are not withheld until consumption.** | *(Interview decision.)* Clawback already covers the real risk — a sale that gets undone. The residual risk, a customer who pays and does not come, ends **in the company's favour** (terminal tier retains 100%); paying commission there is correct. Withholding would be a ledger redesign — caja, cash-drop, affiliate balance — not a state change. |
| **D12** | **Notifications split by origin, and only one of them is a queue.** *Action-tail*: a human acted, so the message leaves as the last step of that same tap. *Clock-produced*: a cron made it, so it needs a surface. | An action-tail message can never accumulate — it is born and consumed in one gesture. Treating both as one inbox would invent a backlog for the half that cannot have one. |
| **D13** | **The seller gets no inbox.** Action-tails chain onto the button they belong to; clock-produced work arrives as a **rung on the existing action ladder** (`folioCardState.ts`). The admin gets the full outbox as an oversight view. | `US-AG50` decided the seller sees *"the card, not the admin's work queue — no pending-work bar and no verb I am not allowed to press"*. The pattern is already proven: `VerifyAndSendButton.tsx:68` verifies and sends in one tap, and the stage-② reminder is already the `Recordar saldo` rung. |
| **D14** | **The outbox is channel-agnostic at the producer, not at the drain.** One `notifications` table; the email drain is automatic, the WhatsApp drain is a human tap. **WhatsApp is the PRIMARY channel and email the reinforcement** — not the other way round. | Forced, not chosen (S4). And the phone is mandatory on every apartado while the email is optional, so "email, falling back to WhatsApp" describes a system where the fallback is the common case. Recording it as two drains keeps the rest of the system blind to the channel, so swapping the WhatsApp drain for an automatic one later touches nobody else. |
| **D15** | **The WhatsApp Cloud API is out of scope.** | It is a commercial decision (Meta approval, per-conversation cost, template review), not a technical one. D14 makes adopting it a drain swap. |
| **D16** | **Eight notification events.** *(§ Notification whitelist.)* | Cut: the ticket delivery on a paid sale (that is the **product**, not a notification, and it already exists) and the review request (it *adds* agent work — Phase 4, as marketing, not core). The refund receipt is **kept** — see D20. |
| **D18** *(withdrawn)* | ~~**Act, or remember — the criterion that picks the channel.** A record-only message goes by email or not at all and may never cost a WhatsApp tap.~~ | **Withdrawn by D20.** Two errors. First, it priced the wrong thing: the refund receipt is itself an **action-tail** (D12) — the agent has just confirmed the PIN, so the message chains onto that same gesture instead of queueing. One app-switch on an operation that happens rarely is not the per-sale tap the decision was defending against. Second, it excluded the one message most worth having in writing: cash, handed over in person, with a retention the customer does not understand. |
| **D19** | **Most events are action-tails, so the outbox is smaller than it looks.** Only `booking_grace_entered` and `departure_reminder` are clock-produced; of those only the reminder scales with volume (one per departure per day). | Worth stating so the engine is not oversold. **Six of the eight** messages leave as the tail of a tap someone was already making (D12); they did not need a notification engine, they needed the action to have a tail. The engine earns its place on the seventh. |
| **D20** | **Every operation is notified to the customer in writing, by WhatsApp.** No exception among the eight events. Email is emitted **additionally** whenever there is one — reinforcement, never a substitute. | *(User decision, superseding D18.)* Written notice is what prevents a dispute and what makes the arithmetic transparent; a channel chosen by how much it costs us is a channel chosen against the customer. The cost objection also turns out to be small: six of the eight are action-tails, so the message rides a gesture already being made. **The boundary is the operation and the money** — it does not extend to the Phase 4 review request, which is marketing, is clock-produced, scales with volume, and protects nobody. |
| **D21** | **What the outbox proves is that we sent, not that they received.** A drained WhatsApp row records `sent_by` + `sent_at` — a human's claim. | Stated so D20's protection is not overestimated. It is evidence of diligence, not of delivery. The repo already knows the difference: `tickets_viewed_at` is a real first-view beacon from the portal, which is why the delivery axis shows `✓✓ Visto` only where a column backs it (`folio-list-scanability.spec.md`). Giving the receipt the same beacon is listed under *Open*. |
| **D24** | **`qr_redemption_mode = 'all_passes'` makes `partial` unreachable, and the report says so.** The wasted-seat report states, per organization, which question it is answering. | Found while auditing the settings, not while designing: one scan in that mode sets `redeemed_count = quantity` outright (`tickets/handler.ts:133`). So a party of four where **two** boarded is scanned once and reads **`fulfilled`** — four passes counted as used, two people aboard, and the wasted seat is invisible **by configuration**. `all_passes` is a gate-throughput choice and it costs exactly the data US-A85 exists to produce; an org cannot have both. Stating it is the whole decision, because the alternative is a report that quietly means *"nobody came vs everybody came"* for one org and *"how many of the four"* for another, under one title. D3 keeps `partial` — it is correct and reachable for every `per_pass` org, which is the default. |
| **D25** | **Eight events need eight message templates; two exist.** Phase 3 ships a **shipped default for all eight** and keeps **only `wa_ticket_template` and `wa_reminder_template` editable** — the two that already are. | The templates are the org's outbound voice, so every new message needs one. But eight editable templates is a settings screen nobody finishes, and six of the eight are transactional statements of fact (*your transfer cleared*, *your sale was cancelled*, *here is your refund receipt*) where wording is not where an operator differentiates. Same reasoning that gave `wa_*_template` a null default meaning "use the shipped one" (`whatsapp-qr-delivery.spec.md` D10): make the good default free, make editing opt-in. Widening later is one nullable column per template. |
| **D26** | **Draining the `tickets_delivered` row is what stamps `tickets_sent_at`.** One code path writes both; the outbox never carries a second copy of a fact the folio already owns. **The outbox has no `viewed_at` column.** | Re-homing the existing sends onto the outbox (Phase 3) creates two records of one tap — the folio's delivery axis and the row's `sent_at` — and two records of one fact drift. Making the drain the single writer means they cannot disagree, because there is one write. Symmetrically, **reading** stays on `tickets_viewed_at` where it already lives: a `viewed_at` on the outbox would be a second home for the same beacon, and it would sit **null for seven of eight events by unmeasurability, not by non-reading** — the exact distinction `folio-list-scanability.spec.md` protected when it refused a grey `✓✓` for a delivery nobody measures. |
| **D17** | **Phase 1 carries no story ID.** It is registered as two bug fixes plus a glossary migration in `SPEC.md`. | `PROCESS.md` reserves an ID for an **observable capability**. "The same state is called the same thing everywhere" is a defect being repaired, not a capability being added; minting a story for it would make the index claim a feature shipped. |

---

## Data Model

### Phase 1 — no migration.
### Phase 2 — migration `0058_no_show_margin.sql`

**Fulfilment itself stays derived — D4 is intact.** The one column is the *setting* that reads it:

```sql
-- D23. Signed like sales_cutoff_offset_minutes and booking_grace_offset_minutes:
--   + = minutes BEFORE departure, − = minutes AFTER. 0 = the departure instant.
-- Its OWN column, never one of those two: they drive the sales gate and the apartado's release,
-- and one number cannot serve two intents (apartado-stages.spec.md S1).
ALTER TABLE organizations ADD COLUMN no_show_margin_minutes INTEGER NOT NULL DEFAULT 0;
```

Fulfilment is computed, per line, from columns that already exist:

```ts
// api-turistear/src/utils/folioFulfillment.ts  (new — pure, no db, no clock of its own)
export type Fulfillment = 'pending' | 'partial' | 'fulfilled' | 'no_show'

// departureEpoch() is the one already in cancellationPolicy.ts — a tour line's snapshotted
// date+time, a stay line's check-in at 00:00 org-local. Both through the org's zone, never UTC.
export const lineFulfillment = (line, tz, marginMinutes, nowEpoch): Fulfillment => {
  if (line.redeemedCount >= line.quantity) return 'fulfilled'
  if (line.redeemedCount > 0)              return 'partial'
  const departed = departureEpoch(line, tz)
  //  D23 — the org's OWN margin, signed like its neighbours (+ before / − after departure).
  //  Deliberately not booking_grace_offset_minutes (it fixes `booking_expires_at` and fires the
  //  auto-cancellation) and not sales_cutoff_offset_minutes (it gates the sale): one number
  //  cannot serve two intents. Default 0 = the departure instant.
  if (departed !== null && nowEpoch > departed - marginMinutes * 60) return 'no_show'
  return 'pending'
}

// D7 — worst case wins. `fulfilled` ranks LAST: a folio is consumed only when nothing is left.
const RANK = { no_show: 0, partial: 1, pending: 2, fulfilled: 3 } as const
export const folioFulfillment = (lines: Fulfillment[]): Fulfillment =>
  lines.reduce((worst, f) => (RANK[f] < RANK[worst] ? f : worst), 'fulfilled')
```

**Nothing is authoritative but `redeemed_count`.** Everything above is a reading of it.

A line with **no readable departure** (a legacy row with a null `slot_date`) resolves to `pending`,
not `no_show` — the opposite of the cancellation engine's conservative direction, and deliberately
so: the engine's caution protects money, and here the cautious direction is to **not accuse a
customer of not showing up** on the strength of a missing column.

### Phase 3 — migration `0059_notifications.sql`

```sql
-- The outbox. One row per (folio, event, channel) the system decided to emit.
-- `status` is the drain's state, not the folio's:
--   pending → the email drain has not run yet, or the WhatsApp tap has not happened
--   sent    → it left (automatically, or a human tapped)
--   failed  → the provider refused; retried by the drain, never silently dropped
--   skipped → the event fired but this channel was not applicable (no email on file)
CREATE TABLE notifications (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL REFERENCES organizations(id),
  folio_id         TEXT NOT NULL REFERENCES folios(id),
  event            TEXT NOT NULL,      -- the whitelist below; never free text
  channel          TEXT NOT NULL,      -- 'email' | 'whatsapp'
  status           TEXT NOT NULL DEFAULT 'pending',
  attempts         INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  sent_at          INTEGER,
  sent_by          TEXT REFERENCES users(id),   -- null for an automatic send
  -- Deliberately NO `viewed_at` (D26). Reading is measured only where a beacon exists — today
  -- `folios.tickets_viewed_at`, for the tickets alone. A column here would be a second home for
  -- that fact, and null for seven of eight events by unmeasurability rather than by non-reading.
  created_at       INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX idx_notifications_org_status ON notifications(organization_id, status, created_at);
-- One row per (folio, event, channel). This is the re-send guard: a cron re-run cannot
-- duplicate a message, the same property `reminder_status` gives the stage-② notice today.
CREATE UNIQUE INDEX uq_notifications_folio_event_channel
  ON notifications(folio_id, event, channel);
```

`reminder_status` on `folios` **stays**, unchanged, and keeps guarding the stage-② notice. Phase 3
adds the outbox alongside it; folding the flag into the table is Deferred, below.

---

## Notification whitelist (D16, D19, D20)

Eight events. **All eight are written to the customer by WhatsApp (D20)**; email is emitted
additionally whenever `customer_email` is set. What varies is only the **origin** — which decides
whether the message rides a gesture already being made, or costs a tap of its own.

| # | Event | Origin | Why it is sent | Extra tap | Exists today |
|---|---|---|---|---|---|
| 1 | `booking_created` | action-tail | *"¿cuánto debo y hasta cuándo?"* | **no** | partly (email) |
| 2 | `tickets_delivered` | action-tail | it is the product | **no** | yes |
| 3 | `payment_verified` | action-tail | *"¿ya les llegó mi transferencia?"* | **no** | yes (inline) |
| 4 | `cancellation_approved` | action-tail | *"¿ya me la cancelaron?"* | **no** | yes (inline) |
| 5 | `payment_rejected` | action-tail | **obligatory** — their sale was cancelled | **no** | yes (inline) |
| 6 | `booking_grace_entered` | **clock** | their spots are about to be released | 1 | yes (sweep) |
| 7 | `departure_reminder` (T−24h, paid) | **clock** | *"¿a qué hora? ¿dónde? ¿qué llevo?"* | **1 per departure** | **new** |
| 8 | `refund_completed` | action-tail | the receipt — paid / returned / **retained** | **no** | **new** |

Row 2 is listed for completeness: ticket delivery already exists and is the **product**, not a
notification. It is re-homed onto the outbox in Phase 3 without changing behaviour.

**Only rows 6 and 7 are produced by a clock**, and only row 7 scales with volume — an operator with
40 departures a day pays 40 taps for it. That single row is where `customer_email` changes the
economics, and it is the honest justification for the engine (D19).

**Row 8 is the case D20 settles.** The refund is confirmed by cash in hand and a PIN, so nothing is
needed *in the moment* — which is why an earlier draft (D18, withdrawn) left it off WhatsApp. That
was wrong twice over: it is an **action-tail**, so it rides the tap the agent is already making, and
it is the single most litigable moment in the product — cash, in person, no receipt, and a retention
the customer does not understand. *Paid 3,000, received 1,800, where did 1,200 go?* is answered
nowhere else. The receipt answers it, in writing, on the channel the customer actually reads.

**Channel policy.** WhatsApp for all eight (the phone is always present — it is mandatory on every
apartado). Email **additionally** whenever `customer_email` is set; its absence is `skipped`, never
`failed`. Email is reinforcement and a durable copy, never a substitute for the written notice.

**Not in the whitelist, and the boundary of D20:** the review request at T+2h. D20 covers **the
operation and the money**; a review request is marketing, is produced by a clock, scales with
volume, and protects nobody from a dispute. It lands in Phase 4 labelled as marketing, and it is
the one message an org should be able to switch off.

## Business rules (enforced server-side)

1. `folios.status` accepts exactly `paid` · `booking` · `cancelled`. **Unchanged by this feature.**
2. Fulfilment is **never persisted and never accepted from a request body**. It is computed on read.
3. A line's fulfilment reads `redeemed_count` against `quantity`, the line's own snapshotted
   departure resolved in the **organization's** time zone, and `no_show_margin_minutes` (D23).
   **Neither `booking_grace_offset_minutes` nor `sales_cutoff_offset_minutes` is an input** — they
   govern the apartado's release and the sales gate respectively.
3b. `no_show_margin_minutes` may not place the no-show instant **earlier than the last moment a seat
   is still sellable**. Rejected with `422 NO_SHOW_MARGIN_TOO_EARLY`; the form mirrors it.
4. A line with no readable departure is `pending`, never `no_show`.
5. The folio's fulfilment is the worst of its lines, ordered `no_show > partial > pending >
   fulfilled` (D7).
6. A redemption recorded after the no-show margin moves the line out of `no_show` on the next read.
   No endpoint, no reversal, no audit row — there is nothing stored to reverse (D5).
7. Fulfilment **never affects money**. It is not an input to the cancellation engine, the ledger, or
   any commission. *(The engine's own `LineOutcome.redeemed` is a separate, pre-existing reading of
   the same column and is not replaced.)*
8. An outbox row is written **in the same transaction as the event that caused it**. A failing send
   never fails the folio operation (`apartado-stages.spec.md` S8).
9. `(folio_id, event, channel)` is unique. A re-run of a drain or a sweep cannot duplicate a message.
10. The email drain retries a `failed` row; it does not mark it `sent` until the provider accepts.
11. A WhatsApp row is marked `sent` only when a **human confirms the tap**, and records `sent_by`.
    The frontend mirrors nothing here — the row is the record.
12. **Every one of the eight events emits a `whatsapp` row** (D20). An event that emits only email
    is a bug, not a configuration. The `email` row is emitted additionally and is `skipped` — never
    `failed` — when there is no address on file.
13. The refund receipt states what was **paid**, what was **returned** and what was **retained** —
    the only place the ladder's arithmetic is ever shown to the customer.
14. A drained `whatsapp` row records `sent_by` and `sent_at`. It asserts that a human sent it, **not
    that the customer received it** (D21); no code may read it as delivery.
14b. Draining the `tickets_delivered` row is the **only** writer of `folios.tickets_sent_at` (D26).
    There is one write; the two records cannot diverge.
14c. **Reading is recorded in exactly one place per event, and only where a beacon exists.** Today
    that is `tickets_viewed_at`, for the tickets alone. The outbox has **no** `viewed_at`: a null
    would mean *not measurable* for seven of eight events, and no surface may render it as
    *not read*.
15. Every outbox read and write is filtered by `organization_id`.

---

## Authorization — who may do this

| Action | Who |
|---|---|
| Read fulfilment on a folio | Anyone who can read the folio. An agent sees their own scope, an admin the org's (unchanged from US-AG49/AG50). |
| Read the wasted-seat report | **admin** |
| Read the outbox as a list | **admin** |
| Drain a WhatsApp row (tap → mark sent) | the folio's **agent** or an **admin** |

A cross-org request for any of these returns **`404`**, never `403`.

---

## API surface

### `GET /api/folios` · `GET /api/pos/folios` · `GET /api/folios/:id` *(extended)*

Each row and the detail gain one derived field. No new endpoint, no new query parameter beyond the
facet already carried by the unified list.

```jsonc
{
  "fulfillment": "no_show",           // the folio roll-up (D7)
  "lines": [
    { "id": "…", "fulfillment": "fulfilled", "redeemed_count": 4, "quantity": 4 },
    { "id": "…", "fulfillment": "no_show",   "redeemed_count": 0, "quantity": 4 }
  ]
}
```

Server-derived, therefore **refused from any request body**.

### `GET /api/reports/wasted-seats?from=&to=`  *(admin)*

Paid folios whose lines reached `no_show`, grouped by service and departure: seats sold, seats
redeemed, seats wasted, and the money they represent. Dates are **org-local days**, matching the
vocabulary the folio list already uses.

The response carries **`redemption_mode`**, and the screen states what the numbers mean (D24):

| `qr_redemption_mode` | What the report can distinguish |
|---|---|
| `per_pass` *(default)* | seat by seat — *"two of four boarded"* |
| `all_passes` | **only** *"the party came"* vs *"nobody came"* — a partial boarding reads as fully used |

### `GET /api/notifications?status=pending&channel=whatsapp`  *(admin)*

The outbox. Ordered oldest first.

### `POST /api/notifications/:id/sent`  *(agent | admin)*

Marks a WhatsApp row drained. Body: `{}`. Stamps `sent_at`, `sent_by`.

### Error responses

| Code | HTTP | When |
|---|---|---|
| `NO_SHOW_MARGIN_TOO_EARLY` | 422 | the margin would mark a customer absent while their seat is still sellable (D23) |
| `NOTIFICATION_NOT_FOUND` | 404 | unknown id, **or another org's row** |
| `NOTIFICATION_ALREADY_SENT` | 409 | the row is not `pending` |
| `NOTIFICATION_NOT_DRAINABLE` | 422 | an `email` row — the drain is automatic, a human cannot mark it |

---

## Frontend

Design system: `.design/design-system/DESIGN_TOKENS.md`. No new primitive.

**Phase 1 — the vocabulary and the two lies.**
`FolioStatusChip.tsx` (`booking` → **"Apartado"**), `folioFacets.ts:46` (facet label), and
`FolioHistoryPage.tsx:58` (toggle). `folioMoneyAxis` in `folioCardState.ts` gains the third branch:
`refund_status === 'none'` on a cancelled folio reads **"(sin reembolso)"**, not "(reembolsado)".

**Phase 2 — fulfilment on the card and in the facets.**
The folio card's existing **chip** channel carries it (`chip = time` already; a departed folio's
time reading *is* its fulfilment). `no_show` uses functional red, icon-paired; `partial` amber;
`fulfilled` neutral — never teal, per the one-accent law. The unified list's `pendiente` facet
section gains **`Sin usar`**; the detail lists fulfilment per line. Money is untouched, so
`MoneyText` is not involved.

**Phase 3 — the outbox.**
For the **seller**: nothing new. Action-tails chain onto the button that produced them — the refund
`ConfirmSheet` closes into the WhatsApp hand-off exactly as `VerifyAndSendButton` already does, and
a clock-produced WhatsApp row surfaces as a rung on the existing action ladder. For the **admin**: a
`SectionCard` list of pending rows under Oversight.

---

## Scenarios

### Phase 1 — the vocabulary and the two lies

**S-1 — One word for one state**
Given a folio with `status = 'booking'`
When it is rendered in the list card, in the status chip, in the facet strip and in the history toggle
Then all four read **"Apartado"**.
*(Amended in the build: the original wording asked for the string to be absent from
`app-turistear/src`, which a source grep cannot honour — the fix leaves a comment explaining why the
word was retired, and that comment is worth more than the grep. The assertion is on what renders,
plus `FACETS.some(f => f.label === 'Reserva') === false` on the label map. The card and the chip are
asserted **together**, because disagreeing was the defect.)*

**S-2 — A cancellation that refunded nothing does not claim it refunded**
Given a cancelled folio with `refund_status = 'none'` and `total = 150000`
When the card renders its money axis
Then it reads **"(sin reembolso)"** — and the assertion fails against the pre-fix component.

**S-3 — A confirmed refund still says so**
Given a cancelled folio with `refund_status = 'refunded'`
Then the card reads "(reembolsado)" with the refunded amount, unchanged.

### US-A85 — the wasted seat

**S-4 — Nobody boarded, the departure has passed**
Given a `paid` folio with one line, `quantity = 4`, `redeemed_count = 0`, departing 3 hours ago
And the org's `no_show_margin_minutes = 0`
When the folio is read
Then `fulfillment = 'no_show'` — and `folios.status` is still `'paid'`.

**S-4b — Tuning the apartado release does not move the no-show line**
Given two orgs identical but for `booking_grace_offset_minutes` (+15 and −30)
And each has a `paid` folio departing 3 hours ago with nothing redeemed
Then **both** read `no_show`, and neither org's `booking_expires_at` arithmetic is consulted.
*(This is the assertion D6's withdrawal exists for: it fails the moment anyone re-couples the two
clocks.)*

**S-4c — The margin is the org's own, and 0 means the departure**
Given an org with `no_show_margin_minutes = 0` and a line departing 1 minute ago, nothing redeemed
Then `fulfillment = 'no_show'`.
And given an org with `−60` (an hour of courtesy) and the same line
Then `fulfillment = 'pending'` until 60 minutes past departure.

**S-4d — A customer cannot be marked absent before they could be sold a seat**
Given an org with `sales_cutoff_offset_minutes = −30` (still selling 30 min after departure)
When it sets `no_show_margin_minutes` to `0` or any *before-departure* value
Then `422 NO_SHOW_MARGIN_TOO_EARLY` (D23).

**S-5 — Two of four boarded**
Given the same line with `redeemed_count = 2`
Then `fulfillment = 'partial'`, both before and after departure.

**S-6 — The late arrival is scanned and stops being a no-show**
Given the folio of S-4, already reading `no_show`
When the scanner redeems 4 passes
Then the next read returns `fulfilled`, with **no reversal endpoint called and no row updated other
than `redeemed_count`**.

**S-6b — `all_passes` cannot see a partial, and the report admits it**
Given an org with `qr_redemption_mode = 'all_passes'` and a line of `quantity = 4`
When one scan redeems it
Then `redeemed_count = 4` and `fulfillment = 'fulfilled'` — **`partial` is unreachable** (D24).
And the wasted-seat response carries `redemption_mode = 'all_passes'`, so the screen states that a
partial boarding is counted as fully used.

**S-7 — Worst case wins, and `fulfilled` does not mask a pending tour**
Given a folio with line A `fulfilled` and line B `pending` (departs Thursday)
Then the folio reads **`pending`**, not `fulfilled`.
And given line A `fulfilled` and line B `no_show`
Then the folio reads **`no_show`**.

**S-8 — A line with no readable departure is never accused**
Given a legacy line with `slot_date = NULL` and `redeemed_count = 0`
Then `fulfillment = 'pending'`.

**S-9 — The org's zone decides, not UTC**
Given an org in `America/Cancun` and a line departing today at 20:00 local
When "now" is 22:00 UTC (17:00 local — before departure)
Then `fulfillment = 'pending'`.
*(This scenario must seed a NON-UTC org: `seedUser` seeds `timezone = 'UTC'`, and a test on a UTC
org cannot demonstrate anything about time zones — recorded in
`folio-lifecycle-unification.spec.md` after exactly that mistake.)*

**S-10 — Fulfilment is refused from the body**
When a request sends `fulfillment` in the body of any folio write
Then it is ignored — the response reflects the derived value.

### US-AG51 — the action's tail

**S-11 — Confirming a refund hands off to the message**
Given a cancelled folio with `refund_status = 'pending'`
When the agent confirms with the tourist's PIN
Then the sheet closes **into the WhatsApp hand-off**, in the same gesture — not to the folio detail.

**S-12 — The seller has no inbox**
Given a seller with pending WhatsApp rows in the outbox
When they open their folio list
Then there is **no pending-work bar and no outbox list** — the work appears only as the card's
single suggested action (US-AG50).

### US-A86 — the outbox

**S-13 — An event writes exactly one row per applicable channel**
Given a folio whose customer has no email
When `payment_verified` fires
Then one `whatsapp` row is written `pending`, and the `email` row is `skipped` — not `failed`.

**S-14 — A cron re-run cannot duplicate a message**
Given a `booking_grace_entered` row already written for a folio
When the sweep runs again
Then the insert is rejected by `uq_notifications_folio_event_channel` and nothing is re-sent.

**S-15 — A provider outage does not consume the notification**
Given Resend returns 500
Then the row is `failed` with `attempts = 1` and `last_error` set, the folio operation **succeeded**,
and the next drain retries it.

**S-16 — An email row cannot be drained by a human**
When an admin posts `/api/notifications/:id/sent` for an `email` row
Then `422 NOTIFICATION_NOT_DRAINABLE`.

**S-16b — Every operation is written to the customer**
Given a refund confirmed on a folio whose customer has **no** email
Then a `whatsapp` row is written `pending` for `refund_completed`, and the `email` row is `skipped`
— never `failed`.
And its content states what was **paid**, what was **returned** and what was **retained**.
*(The assertion that must fail if someone re-applies the withdrawn D18: there is a `whatsapp` row
for a customer with no email.)*

**S-16c — Sent is not received**
Given a drained `whatsapp` row for any event **other than** `tickets_delivered`
Then the folio's delivery axis is **unchanged** — `tickets_viewed_at` is the only thing that may
render `✓✓ Visto`, and no outbox row may set it (D21).

**S-16d — One tap, one write, two records that cannot disagree**
Given the `tickets_delivered` row is drained
Then `folios.tickets_sent_at` is stamped by **that same write** (D26), the card shows `✓ Enviado`,
and re-reading both gives the same instant.
*(The mutation this must catch: a second code path that stamps `tickets_sent_at` on its own, which
is how the two records start drifting.)*

### Multitenancy isolation (required)

**S-17 — Another org's outbox row is invisible**
Given two organizations seeded with `seedTwoOrgs`
When org A requests `GET /api/notifications` and `POST /api/notifications/:id/sent` for org B's row
Then the list omits it and the post returns **`404`** — never `403`.

**S-18 — The wasted-seat report never counts another org's seats**
Given `seedTwoOrgs`, each with a no-show folio on a same-named service
When org A requests the report
Then only org A's seats are counted.
*(This assertion must be verified by mutation: removing the org filter has to turn it red. The
identical test on the cancellation-requests join passed with the scope removed **and** with the
join removed — see `folio-lifecycle-unification.spec.md` S-18.)*

---

## Definition of Done

### Phase 1 — vocabulary and the two lies *(no migration · `fix/folio-labels`)*

- [x] `FolioStatusChip.tsx`, `folioFacets.ts`, `FolioHistoryPage.tsx` say "Apartado"
- [x] `folioMoneyAxis` third branch + `MoneyLine` "(sin reembolso)" — and the *settled* figure
      becomes `refund_amount`, not `total`, which was wrong for an apartado in the same way
- [x] S-1 · S-2 · S-2b · S-2c · S-3 — all six new assertions mutation-verified red against the
      pre-fix components
- [x] `BUGS.md`: BUG-026 (two words, one state) · BUG-027 (`(reembolsado)` on a folio owed nothing)
- [x] `SPEC.md`: glossary already carries **Apartado** (shipped with the spec in #61)

### Phase 2 — the fulfilment axis *(migration `0058` · `feat/folio-fulfillment`)*

- [x] Migration `0058` — `organizations.no_show_margin_minutes` (D23)
- [x] `utils/folioFulfillment.ts` — pure, injected clock and margin, no db
- [x] `/settings` input beside *Cierre de ventas* (**"Marcar como no usado"**), same
      *Antes / Después* control, with the `NO_SHOW_MARGIN_TOO_EARLY` validation mirrored in the form
- [x] `fulfillment` on `/api/folios`, `/api/pos/folios` (US-AG50 — the seller reads the same
      axis), the detail, and per line
- [x] `GET /api/reports/wasted-seats`, carrying `redemption_mode` + `resolution` (D24)
- [x] S-4 … S-10 (incl. S-4b, S-4c, S-4d, S-6b) in `test/folios/folio-fulfillment.test.ts` (21);
      17 unit assertions in `folioFulfillment.unit.test.ts`
- [x] S-18 cross-org, **mutation-verified — and the result is recorded honestly in the test**:
      it goes red only when BOTH org predicates are removed. Either one alone suffices, because a
      `folio_line`'s `organization_id` always equals its folio's, so the test proves the query is
      org-scoped but **cannot prove which predicate does the work**. The second is defence in depth
      that no test here justifies (same shape as US-A84's S-18, which passed with the scope removed
      *and* with the join removed)
- [x] Card chip (`Sin usar` / `Parcialmente usado`, on the EXISTING time channel — no fourth
      channel) + `Sin usar` facet in *Pendiente* + per-line note on the detail
- [x] **Frontend scenarios, which this spec originally lacked** — the DoD asked for the rendering
      and named no test for it. Twelve assertions added across `folioCardState.test.ts`,
      `folioFacets.test.ts` and `FolioCard.test.tsx`, all six behavioural ones mutation-verified
      (deleting the chip branch and neutering the facet predicate turns exactly those red)
- [x] `SPEC.md`: US-A85 registered in #61; text still matches what shipped

### Phase 3 — the outbox *(migration `0059` · `feat/notification-outbox`)*

- [x] `notifications` table + the unique guard (migration `0059`)
- [x] Seven of the eight events emit rows; the `tickets_delivered` drain is the **only** writer of
      `tickets_sent_at` (D26). `departure_reminder` is emitted by **Phase 4**, where its clock lives
- [x] The inline sends are re-homed **for recording**: each now stamps `sent` or `failed` with its
      error instead of vanishing into a `console.error`
- [x] A shipped default template per event; **only the two existing templates stay editable** (D25)
- [ ] `refund_completed` chains onto the PIN confirm and states paid / returned / retained (D20)
- [x] WhatsApp drain endpoint (`POST /api/notifications/:id/sent`) + the admin list
- [ ] **Email RETRY — deliberately not built, and the reason is recorded.** Each of the six emails
      assembles a different payload (ticket lines + QR + portal link, the apartado's expiry, the
      cancellation outcome). Every one IS reconstructible from the folio, so the retry is bounded
      work — but doing it badly would put six working, tested email paths at risk to buy a retry for
      an outage that has happened once. What ships is the part that matters: an outage is
      **recorded** as `failed` with its error, the WhatsApp half is a real drainable queue, and the
      unique guard makes a re-run unable to duplicate. Moved to *Deferred*
- [x] Refund confirm chains into the WhatsApp hand-off (S-11), with the message as a pure, tested
      function (`refundReceipt.ts`) so its three figures are assertable without a page
- [x] S-12 … S-17 + S-16b/c/d, in `test/folios/notification-outbox.test.ts` (11). D26's single
      writer and the cross-org 404 are **mutation-verified**
- [x] Admin outbox view at `/mensajes` (6 rendered assertions, mutation-verified); **seller gets
      nothing new** — `GET /api/notifications` is admin-only and S-12 pins the 403
- [x] `SPEC.md`: US-AG51 / US-A86 registered in #61; text still matches what shipped

### Phase 4 — the two new notices *(no migration · `feat/folio-reminders`)*

- [ ] `departure_reminder` at T−24h for `paid` folios
- [ ] The review request at T+2h for `fulfilled` folios — **explicitly marketing, and it adds a tap**
- [ ] `SPEC.md`: US-T08 already registered — tick the Features-by-Phase box, the feature is now complete

---

## Deferred — and why each is safe to defer

| What | Why it can wait |
|---|---|
| **Making `customer_email` required at checkout** | Smaller than it first looked. Under D20 the written notice always goes by WhatsApp, so the email is a **durable second copy**, not the thing that makes a customer reachable; and D19 shows six of eight messages cost no extra tap anyway. It still improves **`departure_reminder`** — the one event that scales with volume — by letting it send itself. A POS decision with its own friction cost on a walk-up sale, belonging to whoever owns the checkout. |
| **Automatic retry of a failed email** | The outbox RECORDS the failure with its error today; what it does not do is rebuild the payload and resend. Six emails, six different payloads — all reconstructible from the folio, so this is bounded work rather than an open question. Deferring it keeps six working, tested email paths untouched while the outbox's other three guarantees ship. |
| **Folding `reminder_status` into the outbox** | It works, it guards correctly, and the outbox's unique index gives the same property for new events. Merging them is a migration that buys tidiness, not behaviour. |
| **A stored fulfilment snapshot** | Only needed if March's no-show count must be immutable against a later change to the grace setting. The precedent is already in the repo (`cancellation_policy_snapshot`): snapshot the margin on the line, not a column a cron writes. One decision away. |
| **WhatsApp Cloud API** | D14 makes it a drain swap. Nothing else changes. |
| **Fulfilment as a cancellation input** | The engine's `LineOutcome.redeemed` already reads the same column for the only money decision that needs it (D7 of the engine spec). Unifying the two readings is a refactor with no behaviour attached. |

---

## Known behaviour change

**Every organization sees three label changes and no data change.**

1. Wherever a screen said **"Reserva"** it now says **"Apartado"**. Same folios, same filter, same
   count.
2. A cancelled folio that was **never owed a refund** stops reading *"$X (reembolsado)"* and reads
   *"$X (sin reembolso)"*. No number moves; the caption was wrong. Orgs whose ladder retains 100%
   inside the window — including every org on the inherited default, at the terminal tier — will see
   this on real folios immediately.
3. Folios that are paid, departed and never scanned begin showing **"Sin usar"**. Nothing about them
   changed; they were always like that and nothing displayed it. The line falls at the departure
   instant by default (`no_show_margin_minutes = 0`), and an org that already sells past departure
   (*Cierre de ventas: Después*) **must** widen it — the form will not accept a margin that marks a
   customer absent while their seat is still on sale (D23).

**No money moves in any phase.** The terminal tier already made a no-show's payment final
(`cancellationPolicy.ts:211`); Phase 2 makes it *countable*, not *final*.

---

## Settings audit — what this spec leans on, and what it found

Every column on `organizations`, checked for a real consumer. Three rows are not about this feature
and are recorded because the audit found them, not to widen the scope.

| Setting | In `/settings` | Read by code | Under this spec |
|---|---|---|---|
| `timezone` | ✅ | 11 sites | **load-bearing** — D23 and S-9 resolve through it |
| `booking_min_down_payment_pct` | ✅ | yes | untouched |
| `booking_pre_departure_buffer_hours` | ✅ | yes | untouched — the ①→② boundary |
| `booking_creation_cutoff_hours` | ✅ | yes | untouched |
| `sales_cutoff_offset_minutes` | ✅ | yes | **gains a role**: it bounds D23's validation |
| `booking_grace_offset_minutes` | ✅ | yes | untouched — **and D6's withdrawal keeps it that way** |
| `lodging_weekend_days` | ✅ | yes | untouched |
| `wa_ticket_template` · `wa_reminder_template` | ✅ | frontend | **central in Phase 3** — and short by six (D25) |
| `qr_redemption_mode` | ✅ | yes | **collides with the fulfilment axis** (D24) |
| `cancellation_policy` | ✅ | yes | untouched |
| `ack_window_hours` | ❌ **no UI** | yes (`cash/handler.ts:48`) | works, but no admin can change it. Out of scope. |
| `agent_cancellation_enabled` | ❌ | **nothing** | correct: US-A73 is registered *"Not yet built — the switch is not surfaced until the endpoint exists"*. Reserved, not rotten. |
| `booking_hold_days` | ❌ | **nothing — inert** | **dead configuration.** Still in the `PATCH /api/organizations` contract, still loaded into `BookingPolicy.holdDays`, never read: *"the former createdAt + holdDays cap was removed… `holdDays` is retained inert"* (`pos/handler.ts:722`). Out of scope — see below. |
| `lodging_free_cancel_days` · `lodging_cancel_penalty_pct` | tombstone | nothing | **retired correctly**, and the model to copy: no longer editable, and an org that had them configured is told, on the screen where it would go looking, that the ladder governs stays now (`SettingsPage.tsx:488`). |

**The pattern worth naming:** this repo already knows how to retire a setting honestly — stop
accepting it, and tell the orgs that set it where the behaviour went. `booking_hold_days` never got
that treatment, which is the difference between a retired setting and a lying one.

---

## Open

| Question | The smallest change that answers it |
|---|---|
| Should a `no_show` folio still be cancellable by an admin? | Today it can be, and the ladder gives it 0% — so the outcome is already right. Blocking it would need one guard in `cancelFolio`; leave it until someone reports being confused. |
| Does the wasted-seat report belong on the dashboard rather than under Reports? | A dashboard card is one component; the endpoint is the same either way. Decide when Phase 2's numbers exist and are worth looking at. |
| Should `all_passes` orgs get a way to record how many actually boarded? | It is the only way they see a partial (D24), and it means a count on the scan screen instead of one tap — which is the throughput they chose `all_passes` to get. Worth asking an operator before building. |
| Should the refund receipt be a portal page with a view beacon, like the ticket? | It would turn D21's *we sent it* into *they opened it* — real evidence, on the one message where a dispute is most likely. The machinery exists (`/t/:token` and `tickets_viewed_at`). Deliberately not scoped here: it is a second surface, not a notification. |
| Should the customer see **why** the retention was that amount? | The receipt states *retained 1,200*; the ladder that decided it is snapshotted on the folio (`cancellation_policy_snapshot`) and shown nowhere. How much policy a tourist should be shown is a product decision, not a consequence of anything in this spec. |
| Should the T−24h reminder respect a per-service opt-out? | One boolean on `services`. Only worth it if an org runs a service where the reminder is noise (an open-ended pass, say). |
