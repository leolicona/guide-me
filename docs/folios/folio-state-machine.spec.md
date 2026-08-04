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
2. **No new writer of state.** Phase 2 adds no column and no cron.
3. **Money is untouched.** No phase changes `commission_amount`, the ladder, the ledger, or when a
   commission is booked.
4. **Phase 1 is byte-identical in behaviour** — it changes strings and one branch that was wrong.

---

## Design decisions

| # | Decision | Why |
|---|---|---|
| **D1** | **`status` does not grow. The folio has six orthogonal axes**: money (`status`) · clearance (`payment_verification`) · delivery (`tickets_sent_at`/`tickets_viewed_at`) · debt (`refund_status`) · hold stage (derived) · **fulfilment (new, derived)**. | An enum is one answer; a folio needs six at once. Collapsing them means either naming the cartesian product (3×3×3×3 = 81 values) or losing information — and losing information is what produced the `(reembolsado)` defect. Axes also compose: adding the sixth costs the other five nothing. |
| **D2** | **Fulfilment lives on the LINE**, with a roll-up on the folio. | The cancellation engine already prices per line (`LineOutcome`, `cancellationPolicy.ts:172`) and `redeemed_count` is per line. A folio with Isla Mujeres on Tuesday (scanned) and Chichén on Thursday (nobody came) has no single truth; a folio-level rule would have to lie about one of them. |
| **D3** | Values: **`pending` · `partial` · `fulfilled` · `no_show`**. | Without `partial`, two friends who did not board vanish from the report and the wasted seat — the whole point of the axis — stays invisible. |
| **D4** | **Fulfilment is DERIVED, never stored.** No column, no migration, no cron. | *(Reverses the recommendation given during the interview.)* Enumerating who would write it turned up nobody: all four values fall out of `redeemed_count`, `quantity` and the line's snapshotted departure. This is `apartado-stages.spec.md` **S7** again — *a stored stage needs a writer, and a cron that writes state drifts from the clock that defines it*. Deriving also makes D5 free. |
| **D5** | **A scan always wins.** A passenger who boards after the grace instant is redeemed normally and the folio stops being a no-show. | Nothing to revert, because nothing was written. The scanner is the only party that knows whether someone showed up; a cron that had already stamped `no_show` would be asserting the opposite of an observation. |
| **D6** | **The no-show margin reuses `booking_grace_offset_minutes`, negative.** No new setting. | It is already signed (±240) and already means *"minutes relative to departure, negative = after"* (`apartado-stages.spec.md` S3). A second field would configure a distinction that does not change the number. |
| **D7** | **Roll-up: the worst case wins**, ordered `no_show > partial > pending > fulfilled`. | Same rule as the action ladder (blocking first). `fulfilled` ranks **last** deliberately: a folio is consumed only when there is nothing left to consume — ordering it above `pending` would label a folio "Consumido" while one of its tours has not departed. A folio reading "Consumido" is a folio nobody opens, which is exactly how a wasted seat stays hidden. |
| **D8** | **The word "Reserva" is retired from the product.** Three terms: **Apartado** (partial payment, balance owed) · **Pagado** (paid in full) · **Por verificar** (money received, not confirmed). | "Reserva" describes what apartado *and* pagado both do — both block inventory — so it distinguishes nothing, and it is already used for both meanings in shipped UI. Retiring it is cheaper than defining it. |
| **D9** | **"Por verificar" is not a stage before apartado/pagado.** A transfer sale is created as apartado or pagado and **decrements seats immediately** (`pos/handler.ts:1642`); what is withheld is the **QR**, not the inventory. | Stating it the other way would be a spec that contradicts the code. The honest description is a clearance axis over a folio that already exists. |
| **D10** | **An unverified transfer keeps blocking seats.** | The alternative punishes the customer who genuinely paid while the admin sleeps, to defend against a customer who lied to a seller looking at a receipt. The verification queue is the control for the second; there is no control for the first. |
| **D11** | **Commissions are not withheld until consumption.** | *(Interview decision.)* Clawback already covers the real risk — a sale that gets undone. The residual risk, a customer who pays and does not come, ends **in the company's favour** (terminal tier retains 100%); paying commission there is correct. Withholding would be a ledger redesign — caja, cash-drop, affiliate balance — not a state change. |
| **D12** | **Notifications split by origin, and only one of them is a queue.** *Action-tail*: a human acted, so the message leaves as the last step of that same tap. *Clock-produced*: a cron made it, so it needs a surface. | An action-tail message can never accumulate — it is born and consumed in one gesture. Treating both as one inbox would invent a backlog for the half that cannot have one. |
| **D13** | **The seller gets no inbox.** Action-tails chain onto the button they belong to; clock-produced work arrives as a **rung on the existing action ladder** (`folioCardState.ts`). The admin gets the full outbox as an oversight view. | `US-AG50` decided the seller sees *"the card, not the admin's work queue — no pending-work bar and no verb I am not allowed to press"*. The pattern is already proven: `VerifyAndSendButton.tsx:68` verifies and sends in one tap, and the stage-② reminder is already the `Recordar saldo` rung. |
| **D14** | **The outbox is channel-agnostic at the producer, not at the drain.** One `notifications` table; the email drain is automatic, the WhatsApp drain is a human tap. | Forced, not chosen (S4). Recording it as two drains keeps the rest of the system blind to the channel, so swapping the WhatsApp drain for an automatic one later touches nobody else. |
| **D15** | **The WhatsApp Cloud API is out of scope.** | It is a commercial decision (Meta approval, per-conversation cost, template review), not a technical one. D14 makes adopting it a drain swap. |
| **D16** | **Seven notification events, not ten.** *(§ Notification whitelist.)* | Cut: the ticket delivery on a paid sale (that is the **product**, not a notification, and it already exists); the review request (it *adds* agent work — it belongs to Phase 4 as marketing, not to the core); the refund receipt (the customer is standing in front of the agent holding the cash — though D12's chaining gives it away for free). |
| **D17** | **Phase 1 carries no story ID.** It is registered as two bug fixes plus a glossary migration in `SPEC.md`. | `PROCESS.md` reserves an ID for an **observable capability**. "The same state is called the same thing everywhere" is a defect being repaired, not a capability being added; minting a story for it would make the index claim a feature shipped. |

---

## Data Model

### Phase 1 — no migration.
### Phase 2 — no migration (D4).

Fulfilment is computed, per line, from columns that already exist:

```ts
// api-turistear/src/utils/folioFulfillment.ts  (new — pure, no db, no clock of its own)
export type Fulfillment = 'pending' | 'partial' | 'fulfilled' | 'no_show'

// departureEpoch() is the one already in cancellationPolicy.ts — a tour line's snapshotted
// date+time, a stay line's check-in at 00:00 org-local. Both through the org's zone, never UTC.
export const lineFulfillment = (line, tz, graceMinutes, nowEpoch): Fulfillment => {
  if (line.redeemedCount >= line.quantity) return 'fulfilled'
  if (line.redeemedCount > 0)              return 'partial'
  const departed = departureEpoch(line, tz)
  //  grace is SIGNED like booking_grace_offset_minutes: + = before departure, − = after.
  //  A no-show margin is naturally negative (D6); a positive value simply means the org
  //  declares the seat lost before the boat leaves, which is their call.
  if (departed !== null && nowEpoch > departed - graceMinutes * 60) return 'no_show'
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

### Phase 3 — migration `0058_notifications.sql`

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

## Notification whitelist (D16)

Seven events. The column that decides inclusion is **which inbound message the absence of this
notification generates** — because that inbound is the agent's real workload.

| # | Event | Inbound it prevents | Channel | Exists today |
|---|---|---|---|---|
| 1 | `payment_verified` | *"¿ya les llegó mi transferencia?"* — asked repeatedly until answered | email | yes, inline |
| 2 | `departure_reminder` (T−24h, paid) | *"¿a qué hora? ¿dónde? ¿qué llevo?"* | email · WhatsApp | **new** |
| 3 | `booking_created` | *"¿cuánto debo y hasta cuándo?"* | email | yes, inline |
| 4 | `booking_grace_entered` (stage ②) | prevents losing the sale, not a message | email · WhatsApp | yes (sweep) |
| 5 | `cancellation_approved` | *"¿ya me la cancelaron?"* | email | yes, inline |
| 6 | `payment_rejected` | — **obligatory**: their sale was cancelled | email | yes, inline |
| 7 | `booking_expired` | — **obligatory**: they lost their spot and their deposit | email | yes (sweep) |

6 and 7 earn their place by obligation, not by saving work: without them the complaint arrives
anyway, later and more expensive.

**Channel policy per event:** email when `customer_email` is present; otherwise a WhatsApp row for a
human to drain. Both may be emitted for events 2 and 4.

**Not in the whitelist, and why:** ticket delivery on a paid sale is the product, not a notification;
the review request adds agent work rather than removing it (Phase 4); the refund receipt is handed
over in person — though D12 gives it away free, since the WhatsApp window opens after the PIN.

---

## Business rules (enforced server-side)

1. `folios.status` accepts exactly `paid` · `booking` · `cancelled`. **Unchanged by this feature.**
2. Fulfilment is **never persisted and never accepted from a request body**. It is computed on read.
3. A line's fulfilment reads `redeemed_count` against `quantity` and the line's own snapshotted
   departure, resolved in the **organization's** time zone.
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
12. Every outbox read and write is filtered by `organization_id`.

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

### `GET /api/notifications?status=pending&channel=whatsapp`  *(admin)*

The outbox. Ordered oldest first.

### `POST /api/notifications/:id/sent`  *(agent | admin)*

Marks a WhatsApp row drained. Body: `{}`. Stamps `sent_at`, `sent_by`.

### Error responses

| Code | HTTP | When |
|---|---|---|
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
Then all four read **"Apartado"**, and the string "Reserva" appears nowhere in `app-turistear/src`.

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
And the org's `booking_grace_offset_minutes` resolves a margin of −15
When the folio is read
Then `fulfillment = 'no_show'` — and `folios.status` is still `'paid'`.

**S-5 — Two of four boarded**
Given the same line with `redeemed_count = 2`
Then `fulfillment = 'partial'`, both before and after departure.

**S-6 — The late arrival is scanned and stops being a no-show**
Given the folio of S-4, already reading `no_show`
When the scanner redeems 4 passes
Then the next read returns `fulfilled`, with **no reversal endpoint called and no row updated other
than `redeemed_count`**.

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

- [ ] `FolioStatusChip.tsx`, `folioFacets.ts`, `FolioHistoryPage.tsx` say "Apartado"
- [ ] `folioMoneyAxis` third branch + `MoneyLine` "(sin reembolso)"
- [ ] S-1 · S-2 · S-3, with S-2 verified red against the pre-fix component
- [ ] `BUGS.md`: BUG-026 (two words, one state) · BUG-027 (`(reembolsado)` on a folio owed nothing)
- [ ] `SPEC.md`: tick nothing yet — the registration ships in this spec's own PR (glossary already carries **Apartado** and **Por verificar**)

### Phase 2 — the fulfilment axis *(no migration · `feat/folio-fulfillment`)*

- [ ] `utils/folioFulfillment.ts` — pure, injected clock, no db
- [ ] `fulfillment` on list rows, detail, and per line
- [ ] `GET /api/reports/wasted-seats`
- [ ] S-4 … S-10 in `test/folios/folio-fulfillment.test.ts`; unit coverage in `folioFulfillment.unit.test.ts`
- [ ] S-18 cross-org, **mutation-verified**
- [ ] Card chip + `Sin usar` facet + per-line detail
- [ ] `SPEC.md`: US-A85 already registered — verify its text still matches what shipped

### Phase 3 — the outbox *(migration `0058` · `feat/notification-outbox`)*

- [ ] `notifications` table + the unique guard
- [ ] The seven events emit rows; the six existing inline sends are re-homed onto it
- [ ] Email drain (scheduled) with retry; WhatsApp drain endpoint
- [ ] Refund confirm chains into the WhatsApp hand-off (S-11)
- [ ] S-12 … S-17
- [ ] Admin outbox view; **seller gets nothing new** (S-12)
- [ ] `SPEC.md`: US-AG51 / US-A86 already registered — verify their text still matches what shipped

### Phase 4 — the two new notices *(no migration · `feat/folio-reminders`)*

- [ ] `departure_reminder` at T−24h for `paid` folios
- [ ] The review request at T+2h for `fulfilled` folios — **explicitly marketing, and it adds a tap**
- [ ] `SPEC.md`: US-T08 already registered — tick the Features-by-Phase box, the feature is now complete

---

## Deferred — and why each is safe to defer

| What | Why it can wait |
|---|---|
| **Making `customer_email` required at checkout** | The highest-leverage change for reducing the agent's taps, and the one this spec does not make. It is a POS decision with its own friction cost on a walk-up sale, and it belongs to whoever owns the checkout — not to a state-machine spec. **This is the real lever; recorded here so it is not mistaken for something this feature delivered.** |
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
   changed; they were always like that and nothing displayed it.

**No money moves in any phase.** The terminal tier already made a no-show's payment final
(`cancellationPolicy.ts:211`); Phase 2 makes it *countable*, not *final*.

---

## Open

| Question | The smallest change that answers it |
|---|---|
| Should a `no_show` folio still be cancellable by an admin? | Today it can be, and the ladder gives it 0% — so the outcome is already right. Blocking it would need one guard in `cancelFolio`; leave it until someone reports being confused. |
| Does the wasted-seat report belong on the dashboard rather than under Reports? | A dashboard card is one component; the endpoint is the same either way. Decide when Phase 2's numbers exist and are worth looking at. |
| Should the T−24h reminder respect a per-service opt-out? | One boolean on `services`. Only worth it if an org runs a service where the reminder is noise (an open-ended pass, say). |
