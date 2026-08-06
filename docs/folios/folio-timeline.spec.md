# Feature: the folio timeline — every sale can tell its own story

> Process: `docs/PROCESS.md`. Stories **US-A24** (admin) · **US-AG53** (agent). Two phases, two PRs.
> Builds on `docs/folios/folio-state-machine.spec.md` (the six axes) and
> `docs/oversight/folio-lifecycle-unification.spec.md` (the folio is one object).

## Context

US-A24 has been open since the MVP: *"track the lifecycle of a sale and resolve internal
disputes."* Today the folio detail shows every axis's **current** value and none of its **history**.
The questions a dispute actually asks have no screen:

- *Who verified this transfer, and when?* — `payment_verified_by` exists but is rendered nowhere.
- *Were the tickets ever sent before the client complained?* — `tickets_sent_at` shows as a badge,
  with no relation in time to the payment or the departure.
- *Why is this folio cancelled?* — the audit `Alert` shows date and reason, but not what happened
  around it: the deposit taken three days earlier, the reminder sent, the deadline passing, the
  system sweep firing.

Worse, some transitions leave **no trace at all** today: a transfer rejection reads identically
to an ordinary cancellation, and a **counter reschedule** (US-AG52) moves the departure leaving
the folio asserting it was always on the new date — only the tourist-origin path leaves a
`folio_requests` row. This repo has already paid once for history that rewrites itself: US-AG52
retired reactivation precisely because it *"left the history asserting an expiry never
happened."* When the seller and the admin disagree about what happened, the database genuinely
does not know.

The unification spec already paid for part of this: its *Known behaviour change* records that
org-wide cancellation-request history stopped being browsable — *"the question 'show me every
request rejected this month' has no direct answer."* An event log is the substrate that answer
needs.

## Scope boundary

This feature is **additive**. Machine-checkable statement:

- `api-turistear/test/folios/folio-cancellation.test.ts`,
  `folio-lifecycle-unification.test.ts` and `folio-list-scanability.test.ts` pass **unedited** —
  event writes ride along in existing batches and change no existing behaviour.
- `app-turistear/src/features/folios/folioCardState.test.ts`, `components/FolioCard.test.tsx` and
  `pages/FoliosListPage.test.tsx` pass **unedited** — the **list and card are untouched**. D11 of
  the unification spec stands: no new badge, no new channel on the card.
- Migration `0061` creates one table and reads existing columns. **No column of `folios` is
  added, altered or dropped.**

*Companion fix, separate PR, not governed by this spec:* the detail header still uses raw MUI
`Chip`s for refund state (`FolioDetailPage.tsx:191-194`) and `venceLabel`, which calls
`Date.now()` in render — the exact D19 violation the list already fixed. That cleanup
(`fix(folios)`) replaces them with `StatusChip` per active axis + `folioTimeChip` and precedes
Phase 2 so the timeline lands on a consistent header.

## Design decisions

| # | Decision | Why |
|---|---|---|
| **D1** | The timeline is a **written event log** (`folio_events`), not a read-time derivation. | Transfer rejections and counter reschedules leave no trace in `folios`; a derivation can only ever show what columns happen to survive. Chosen over derive-on-read knowing it costs ~10 write points. |
| **D2** | The vocabulary is the **full lifecycle** — ten event types (§ Data Model), covering money, clearance, delivery, debt, reminders and reschedules. | Disputes are mostly about verification and delivery, not about `status`. A status-only log would answer the questions nobody asks. |
| **D3** | Every event is written **in the same D1 batch as its mutation**. | The BUG-013 lesson: a flip and its side effects either all happen or none do. An event log that can disagree with the folio is worse than none. |
| **D4** | The migration **backfills synthetically** from existing columns, stamping `backfilled = 1` and the **source timestamp** as `created_at`. What left no trace (past reactivations, rejections, reschedules) is honestly absent. | One read path forever — the `displayMethodSql` precedent. The alternative (merge derived history at read for old folios) is the two-path fork this repo keeps killing. Disputes are about past sales; an empty timeline on every existing folio would be born useless. |
| **D5** | Events are **embedded in the folio detail GET** (admin and POS), not a separate endpoint. | "The folio is one object, not five screens" applies to the API too. 5–20 rows per folio; pagination would be ceremony. |
| **D6** | The seller sees the **identical timeline** — including admin actors and cancellation reasons. | It is their sale; they answer the customer in the field. One component, one shape, zero filtering logic to test. Consistent with the seller already seeing the payment breakdown. |
| **D7** | The **departure marker is derived at read**, never stored: one neutral row at the folio's departure datetime, reading `Salida` — or `Salida — sin uso` once fulfilment says `no_show`/`partial`. | The state-machine spec's D4: fulfilment is derived, never stored. The marker is what makes a `system_expiry` cancellation legible — you see *when* the departure was that explains it. |
| **D8** | Rendering is a **chronological oldest-first list** inside a `SectionCard` titled *Historial* — icon + line + actor + timestamp per row. No vertical connector, no collapse, no stepper. | A sale reads as a story: created → deposited → reminded → expired → reactivated. A milestone stepper is exactly the axis-collapse the state-machine spec's D1 calls losing information. 5–20 rows need no virtualization. |
| **D9** | One event per **user action**, not per column changed. A transfer rejection writes `transfer_rejected` (whose copy states the folio was cancelled), not `transfer_rejected` + `cancelled`. | The timeline narrates actions; double rows for one tap read as two things having happened. |
| **D10** | Actors are stored as **FKs and resolved at read** (join to `users` / `affiliate_operators`); `actor_id NULL` renders **Sistema** (sweep) or **Cliente** (`tickets_viewed`). | The `collected_by` pattern from `folio_payments`. No name denormalization to go stale. |
| **D11** | The event row's money figures render through **`MoneyText`** (small, semantic color); state words use the D8 state-machine vocabulary — *Apartado · Pagado · Por verificar*, never "Reserva". | Design-system laws; the vocabulary defect (BUG-026) does not get a second life in the timeline. |

## Data Model

### Migration `0061_folio_events.sql`

```sql
CREATE TABLE folio_events (
  id              text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id),
  folio_id        text NOT NULL REFERENCES folios(id),
  event_type      text NOT NULL,          -- see enum below
  actor_id        text REFERENCES users(id),               -- NULL = system or the tourist
  operator_id     text REFERENCES affiliate_operators(id), -- PIN-shift attribution, like folio_payments
  payload         text,                                    -- JSON, shape per event_type
  backfilled      integer NOT NULL DEFAULT 0,
  created_at      integer NOT NULL                         -- the event's OWN moment (unixepoch)
);

CREATE INDEX idx_folio_events_folio ON folio_events (folio_id, created_at);

-- Synthetic backfill (D4), one INSERT … SELECT per mapping in the table below.
```

`event_type` enum (Drizzle): `created` · `payment` · `payment_verified` · `transfer_rejected` ·
`tickets_sent` · `tickets_viewed` · `reminder_sent` · `rescheduled` · `cancelled` ·
`refund_confirmed`.

The table is **append-only**: no handler updates or deletes a row, and no endpoint exposes a way
to. `folio_events` is a **narrative**, not an authority — every fact in it remains authoritative
where it already lives (`folios`, `folio_payments`); the timeline is never read to compute money
or state.

### Live write points (all in the same batch as the mutation — D3)

| Event | Written by | Payload |
|---|---|---|
| `created` | `confirmSale` (standard & express) | `{ sale_mode, initial_status }` |
| `payment` | `confirmSale` (deposit/full) · `settleBooking` | `{ amount, method, kind: 'deposit'\|'full'\|'settlement' }` |
| `payment_verified` | `verifyPayment` | `{ amount, reference }` |
| `transfer_rejected` | `rejectPayment` | `{ reference, reason? }` |
| `tickets_sent` | the WhatsApp send handler — **each** send appends | `{}` |
| `tickets_viewed` | the tourist portal beacon (first view only, actor NULL) | `{}` |
| `reminder_sent` | the reminder claim (US-AG07.3) | `{}` |
| `rescheduled` | `rescheduleBooking` (counter) · the portal reschedule-request approval | `{ from_departure, to_departure, origin: 'counter'\|'tourist_request' }` |
| `cancelled` | `cancelBooking` · `cancelFolio` · the `folio_requests` cancellation approval · the expiry sweep (actor NULL) · `voidExpressSale` | `{ source, reason?, clawback, refund_amount?, credit_amount?, kind?: 'express_void' }` |
| `refund_confirmed` | refund confirm | `{ amount, via: 'pin'\|'override' }` |

### Backfill mapping (D4)

| Synthetic event | Source | Actor |
|---|---|---|
| `created` | `folios.created_at` | `agent_id` (+ `operator_id`) |
| `payment` (one per row) | `folio_payments` where `entry_type = 'payment'`, its `created_at` | `collected_by` (+ `operator_id`); `kind` omitted — unknowable |
| `payment_verified` | `payment_verified_at` | `payment_verified_by` |
| `tickets_sent` | `tickets_sent_at` — **only the last send survives** (the column is last-write-wins) | `tickets_sent_by` |
| `tickets_viewed` | `tickets_viewed_at` | NULL |
| `reminder_sent` | `reminder_sent_at` | `reminder_sent_by` |
| `cancelled` | `cancelled_at` + `cancellation_source` / `cancellation_reason` / `cancellation_clawback` | `cancelled_by` (NULL for `system_expiry`) |
| `refund_confirmed` | `refunded_at`; `via` = `refund_note` NULL → `'pin'`, else `'override'` | `refunded_by` |
| **Not backfillable** | `transfer_rejected`, `rescheduled` — no surviving trace (only tourist-origin reschedules leave a `folio_requests` row, and its slot columns describe the petition, not the executed move); honestly absent | — |

## Business rules (enforced server-side)

1. Every handler that mutates a folio axis writes its `folio_events` row **inside the same D1
   batch** as the mutation. A mutation without its event, or an event without its mutation, is a
   bug of the BUG-013 class.
2. `folio_events` is append-only; no route updates or deletes a row.
3. A backfilled event carries `backfilled = 1` and the **source column's timestamp** as
   `created_at` — never the migration's clock.
4. One event per user action (D9); a single tap never yields two rows.
5. The departure marker is derived at read and **never inserted** into `folio_events` (D7).
6. Events are readable **only** through the folio detail; the folio's own org check governs —
   a cross-org folio id returns `404` (never `403`).
7. The timeline is display-only: no money or state computation may read `folio_events`.

## Authorization — who may do this

No new write surface: events ride existing mutations under those endpoints' existing guards
(`requireRole('admin')` on `/api/folios/*`, agent scoping on `/api/pos/*`). Read: the admin detail
returns any folio in the org; the POS detail returns only the seller's own folios, unchanged.
Cross-org: `404`.

## API surface

### `GET /api/folios/:id` and `GET /api/pos/folios/:id` — extended

The detail response gains one array (D5), oldest-first:

```jsonc
"events": [
  {
    "id": "…",
    "type": "payment",
    "at": 1722594720,
    "actor": { "id": "…", "name": "Ana R." },   // null ⇒ Sistema / Cliente per D10
    "operator_name": null,
    "backfilled": true,
    "payload": { "amount": 50000, "method": "cash" }
  }
]
```

Server-derived, therefore never accepted from any body: the entire array. No new endpoints, no
new error codes.

## Frontend

- **`FolioTimeline`** — new component in `app-turistear/src/features/folios/components/`,
  rendered by **both** `FolioDetailPage` and `FolioHistoryDetailPage` (D6) as a `SectionCard`
  titled **Historial**, last section of the page.
- Each row: Material Rounded icon in the event's functional color (icon-paired, never
  color-alone), one-line copy, `actor · date` caption. Amounts via **`MoneyText`** (D11). Dates
  via `useOrgDateFormatter` (inherits TECH_DEBT #24 — noted, not fixed here).
- The derived **Salida** marker (D7) interleaves client-side from the folio's departure datetime
  and `folioFulfillment`; neutral tone, calendar icon, no actor.
- Reuses: `SectionCard`, `MoneyText`, `StatusChip` vocabulary. No new tokens, no new primitives
  in `src/components/` — the timeline is feature-local until a second feature needs it.

## Scenarios

### US-A24 — the admin reads the sale's story

**S-1 — An apartado's full journey reads in order**
Given a folio created as apartado with a cash deposit, then a reminder, then a settlement by a
different user, then tickets sent
When the admin opens the folio detail
Then `events` holds `created → payment(deposit) → reminder_sent → payment(settlement) →
tickets_sent` in that order, each with the acting user resolved by name.

**S-2 — The sweep's cancellation names the system and the deadline explains it**
Given an apartado whose grace instant passed and the sweep cancelled it
When the admin opens the detail
Then the `cancelled` event has `actor: null` (renders **Sistema**) and `payload.source =
'system_expiry'` — and the derived Salida marker places the departure in the narrative.

**S-3 — A counter reschedule finally leaves a trace**
Given a paid folio rescheduled at the counter to another departure (US-AG52), which re-signs and
re-sends the QR
When the admin opens the detail
Then a `rescheduled` event appears with `from_departure`, `to_departure`, `origin: 'counter'` and
the seller's name — followed by the `tickets_sent` event of the re-send — and the derived Salida
marker sits at the **new** departure.

**S-4 — One tap, one row**
Given an admin rejects a pending transfer
When the detail is read
Then exactly one `transfer_rejected` event exists for that action — no separate `cancelled` row.

**S-5 — A pre-migration folio arrives with its history**
Given a folio created, part-paid, cancelled and refunded **before** migration 0061
When the migration runs and the detail is read
Then synthetic `created / payment / cancelled / refund_confirmed` rows exist with `backfilled:
true` and `created_at` equal to the source columns — and nothing is invented for traceless
transitions.

**S-6 — The event's clock is the mutation's clock**
Given a settlement performed at T
When the detail is read
Then the `payment` event's `at` equals the ledger row's `created_at`, not the request's arrival
time on any retry.

### US-AG53 — the seller sees the same story

**S-7 — Identical timeline on the seller's own sale**
Given a folio sold by agent A, verified and later cancelled by an admin with a reason
When agent A opens it in their history detail
Then the events, actors and the cancellation reason are byte-identical to the admin's view (D6).

**S-8 — Another seller's folio stays invisible**
Given a folio sold by agent B
When agent A requests its POS detail
Then `404` — unchanged scoping; the events ride inside it.

### Multitenancy isolation (required)

**S-9 — Another org's record is invisible**
Given two organizations seeded with `seedTwoOrgs`, each with folios carrying events
When org A requests org B's folio detail
Then `404` — never `403` — and no event row of org B is reachable through any org A read.

## Definition of Done

**Phase 1 — the log exists (`feat(folios)` PR, backend)**
- [ ] Migration `0061_folio_events.sql` + Drizzle schema + backfill
- [ ] All ten event types written live, each inside its mutation's existing batch
- [ ] `events` embedded in both detail GETs, actors resolved
- [ ] Scenarios S-1…S-6, S-8, S-9 in `api-turistear/test/folios/folio-timeline.test.ts`
- [ ] Cross-org isolation via `seedTwoOrgs`
- [ ] `SPEC.md`: US-AG53 story, Features-by-Phase line updated to this spec, glossary — in this PR

**Phase 2 — the story renders (`feat(folios)` PR, frontend)**
- [ ] `FolioTimeline` in both detail pages, oldest-first, Salida marker derived (S-7 UI assertions)
- [ ] Component tests: ordering, Sistema/Cliente actors, backfilled rows, `no_show` marker copy
- [ ] Scope-boundary suites still pass unedited

## Deferred — and why each is safe to defer

| What | Why it can wait |
|---|---|
| Org-wide event feed / filters ("every rejection this month") | The table is the hard part; a feed is an additive read over it. Recovers the browsability the unification spec knowingly lost. |
| Backfill of `kind` on historical payments | Unknowable from data; rows render fine without it. |
| Fixing the date locale (TECH_DEBT #24) | Pre-existing, org-wide; the timeline inherits whatever the formatter does. |
| A written event when fulfilment flips to `no_show` | Fulfilment is derived, never stored (state-machine D4); the read-time marker covers the narrative. Revisit only if the state-machine spec's open question (recording actual boardings) is answered with storage. |

## Known behaviour change

Both folio detail responses grow an `events` array, and **existing** folios show a backfilled
history the day the migration lands. Nothing else moves: list, card, money and state computations
are untouched by the scope boundary.

## Open

- Should `tickets_sent` re-sends beyond the first render collapsed ("Enviados ×3") past some
  count? Smallest change: a render-side fold in `FolioTimeline`; the log stays one row per send.
- Does the seller's express **void** deserve distinct copy from a cancellation? The payload
  (`kind: 'express_void'`) already carries it; copy can change without touching data.
