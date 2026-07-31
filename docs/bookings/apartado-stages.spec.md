# Feature: Apartados as stages — notify before releasing

> **Status: BUILT.** Changes `docs/bookings/bookings-down-payments.spec.md`
> (US-AG07/AG07.1) and supersedes `docs/cancellation/cancellation-policy-engine.spec.md` D21.

## Context

*(What follows describes the behaviour this feature replaced.)*

The settle deadline was an **event**: `booking_expires_at` arrived, the cron cancelled the folio,
the seats went back. The customer found out by finding out.

That model had three defects, and they were not independent.

**1. Nobody is told.** A customer who forgot to pay loses their deposit without a single message.
The WhatsApp reminder (US-AG07.3) exists but is manual — it depends on an agent noticing the folio
on the Reservas dashboard and tapping.

**2. There is a cliff at the deadline boundary.** `bookingExpiryDate` picks one of two formulas at
the moment of sale, and the branch is `salida − ahora < plazo`:

| Sale made | Branch | Expires | Life of the apartado |
|---|---|---|---|
| 24h **01m** before departure | far | `salida − 24h` | **1 minute** |
| 23h **59m** before departure | near | `salida − 15min` | **23h 44m** |

Two minutes of difference in when the sale was rung up, and the hold changes by a factor of 1400.
The customer who bought slightly *earlier* is the one punished. This is the same shape as the
born-expired bug `#29`/`#30` fixed — that fix moved the calculation from calendar days to
time-distance, which was right, but nobody looked at the boundary itself.

**3. Nothing limits when an apartado can be CREATED.** `sales_cutoff_offset_minutes` gates every
new folio with one number (default 0 — sellable until departure), and it must stay that way for
walk-in cash sales. So an agent can open an apartado 20 minutes before departure; it expires 15
minutes before; the apartado lives for five minutes.

---

## The model

The settle deadline stops cancelling anything. It becomes a **transition**.

```
venta con anticipo
    │
    ├── antes del límite ──→ ① RETENIDO
    │                            │  (hasta salida − plazo)
    │                            ↓  se cumple el plazo
    │                        AVISO al cliente  +  pasa a ② AUTOMÁTICAMENTE
    │                            │
    │                            │  el agente puede, en cualquier momento:
    │                            │     · liquidar  → paid
    │                            │     · cancelar  → escalera de cancelación
    │                            ↓
    └── venta de último momento ──→ ② GRACIA
                                        │  (hasta salida − gracia, def. 15 min)
                                        ↓  se agota
                                   AUTOCANCELA → escalera → tramo terminal → 0%
```

**Stage ② is not new.** It is the existing `nearDeparture` branch, which today only ever applies to
a sale born close to departure. This generalises it: every apartado reaches it eventually.

### The property that makes this work

Auto-cancellation moves from `salida − plazo` (24h by default) to `salida − gracia` (15 min).

At fifteen minutes before departure the cancellation ladder is **always** in its terminal tier. So
routing the sweep through the engine — which the ladder's "one computation, every path" principle
wants — becomes safe **by construction**: the cron can no longer fire in a generous tier, whatever
the admin configures the settle deadline to be.

This is why the redesign resolves the expiry/ladder tension that neither
`cancellation-policy-engine.spec.md` D21 ("expiry never refunds") nor its alternative ("expiry
follows the ladder") resolved cleanly. **D21 is superseded by this document.**

---

## Design decisions

| # | Decision | Why |
|---|---|---|
| **S1** | **A dedicated setting for the apartado creation cutoff**, in hours before departure, validated as `límite ≥ plazo` in the form. NOT reused from `sales_cutoff_offset_minutes`. | Cash walk-ins must stay sellable until departure; apartados must not. One number cannot serve both. The validation is what removes defect 2: if an apartado cannot be created inside the settle deadline, it cannot be born with less life than the deadline promises it. |
| **S2** | **Silence advances to ② automatically.** No agent action is required to keep the hold alive. | *(User decision, against the recommendation, which was a bounded silence window.)* The company is compensated by the terminal tier retaining 100% — the trade is explicit: capacity is held to the last minute, and a customer who ghosts forfeits the deposit that paid for the seat. **Cost, accepted:** the booth never gets the seats back with time to resell. |
| **S3** | **Stage ② reuses `booking_grace_offset_minutes`** (signed, ±240, default +15). | "Pay at the booth before boarding" is exactly its semantics, and it already supports negative values for courtesy past departure. A second field would add configuration for a distinction that does not change the number. |
| **S4** | **The notification is email when the customer left one; WhatsApp, tapped by the agent, otherwise.** | Forced, not preferred: a Worker on a cron can call Resend but **cannot send WhatsApp** — `wa.me` is a deep link a human opens. A phone is mandatory on every apartado (US-AG07 D4), so there is no dead end. |
| **S5** | **`reminder_status` records the notification, with `reminder_sent_by = null` for a system send.** | The column already exists (`none` \| `sent`) with a nullable sender. No migration for this part. |
| **S6** *(withdrawn)* | ~~**Per-folio extension of the final deadline, with an audit trail.**~~ **Not built — `reactivate` already covers it.** | It began as an orphan: the decision "the agent may move a folio to ② whenever, with a record" was answered alongside S2, which made advancement automatic and so removed the action being decided about. Reinterpreted as the late arrival — a customer minutes away when the hold ends — it turned out to be covered already: **US-AG07.5's *Reactivar y Liquidar*** re-blocks the freed spots and settles, disabling itself only if the tour filled in the meantime. The extension would have added two columns, an endpoint, a button and an audit trail to win the narrow window where someone else bought those seats in the final minutes. |
| **S7** | **Stage is DERIVED from timestamps, not stored.** `now < booking_expires_at` ⇒ ①; past it, ② until `salida − gracia`. | A stored stage needs a writer, and a cron that writes state drifts from the clock that defines it. The existing `booking_expires_at` already carries the ① boundary; ② ends at the grace instant, computed from the **line's own snapshotted departure** — a folio prices by the departure it was sold for, even if the slot is later moved. Nothing is rewritten on advance, so there is no state to disagree with the clock. |
| **S8** *(added in build)* | **A failed reminder email is not a failed folio.** The send has its own guard, separate from the per-folio one, and does not mark `reminder_status`. | Counting a Resend outage under `failed` would make an email provider's bad afternoon read as apartados breaking. The apartado is fine — it advanced by the clock alone and nothing about it is stuck. Writing the flag only after a successful send means the one notification a customer gets is never silently consumed; it simply retries next run. |

---

## Business rules

1. **Creation.** An apartado may not be created when the earliest departure in the cart is closer
   than the creation cutoff (S1) → `422 BOOKING_TOO_LATE`. A full-payment sale is unaffected and
   remains governed by `sales_cutoff_offset_minutes` alone.
2. **The settle deadline no longer cancels.** At `booking_expires_at` the sweep sends the
   notification, and the folio is in stage ② from that instant on. *(Design change made in the
   build: the folio's release instant is **not** recomputed and nothing is written. The original
   plan was to rewrite `booking_expires_at` the way `reactivate` does, which would have made the
   two stages indistinguishable afterwards — a rewritten deadline looks exactly like a folio that
   was always in ②, so a re-run could not tell them apart. Deriving both boundaries instead keeps
   `booking_expires_at` meaning one thing, and honours S7 properly.)*
3. **One notification per folio.** Guarded by `reminder_status`, so a re-run of the cron cannot
   re-send. An agent's manual WhatsApp claim and a system email are the same flag: whichever
   happened first, the customer was told.
4. **Stage ② ends by cancelling**, priced by the ladder like every other cancellation
   (`cancelFolioPriced`, `cancellation_source = 'system_expiry'`). At the grace instant that is the
   terminal tier, so the customer recovers nothing unless the org configured otherwise.
5. **The sweep is fail-soft per folio.** One folio that throws must not abort the run. *(It was
   not, before this: a single `.catch` on the `scheduled` handler and no per-folio guard, although
   `cancellation-policy-engine.spec.md` Rule 24 had claimed otherwise since the engine landed. One
   throw aborted the run and every apartado behind it silently kept its seats.)*
6. **A customer who arrives after the hold ends is handled by reactivation**, not by extending the
   hold (US-AG07.5). If the spots are still free they are re-blocked and settled; if the tour filled,
   the action is disabled — which is the honest answer, because the seats are genuinely gone.

---

## Scenarios

**S-1 — The deadline notifies instead of cancelling**
Given an apartado whose `booking_expires_at` has passed, and a customer with an email
When the sweep runs
Then the folio is **still `booking`**, its release instant is recomputed to `salida − gracia`,
`reminder_status = 'sent'` with `reminder_sent_by = null`, and one Resend call was made.

**S-2 — No email, so the agent is prompted**
Given the same folio with `customer_email = NULL`
When the sweep runs
Then no Resend call is made, the folio still advances, and it surfaces on the Reservas dashboard
for the agent's WhatsApp tap. `reminder_status` stays `none` — nobody has told the customer yet,
and the flag must not claim otherwise.

**S-3 — The grace instant cancels, priced by the ladder**
Given an apartado in stage ② at `salida − 15min`
When the sweep runs
Then the folio is `cancelled`, `cancellation_source = 'system_expiry'`, the seats and zones are
released, and the refund is the ladder's terminal tier — 0% under the inherited ladder.

**S-4 — A late apartado is refused, but the service still sells**
Given the creation cutoff is 96h
When an agent tries to open an apartado on a slot 72h out
Then `422 BOOKING_TOO_LATE` — **and the same slot sells immediately at full payment**, because the
sales cutoff governs that and is still 0. The rule refuses the *deposit*, not the service.

*(This replaces the originally-specified S-4, which only asserted the rejection. Asserting the
rejection alone would pass just as well if the cutoff had accidentally blocked every sale on that
slot, which is the failure mode worth catching.)*

**S-5 — The boundary cliff is gone**
Given the creation cutoff is 48h and the settle deadline 24h
When an apartado is sold at exactly 48h out
Then it holds for a full 24 hours before the notification, never for one minute.

**S-6 — One bad folio does not abort the sweep**
Given two folios due, one whose policy snapshot fails to parse
When the sweep runs
Then the healthy one is processed and the run reports one failure.

---

## Definition of Done

- [x] New org setting `booking_creation_cutoff_hours` (migration `0056`, default `0` = off), with
      `límite ≥ plazo` validated **at the endpoint against the STORED values** — so a PATCH that
      raises the settle deadline past an existing cutoff fails too, not only one that lowers the
      cutoff. The form mirrors it for fast feedback; a rule enforced only in the UI is not a rule
- [x] `confirmSale` rejects a too-late apartado with `422 BOOKING_TOO_LATE`; the same slot still
      sells at full payment, governed by the sales cutoff alone
- [x] The sweep splits into two passes — **notify + advance** past `booking_expires_at`, **cancel**
      at the grace instant, the latter through `cancelFolioPriced` with `source: 'system_expiry'`
- [x] Per-folio `try/catch` in the sweep (Rule 5) — closes the gap between
      `cancellation-policy-engine.spec.md` Rule 24 and the code, which had a single `.catch` on the
      scheduled handler, so one bad folio aborted the run and every apartado behind it kept its seats
- [x] `sendBookingReminderEmail` in `services/resend.ts`
- [x] Settings: the creation cutoff sits directly under the settle deadline, since the two are a pair
- [x] `cancellation-policy-engine.spec.md` D21 marked superseded; US-A74 restored in `SPEC.md`
- [x] Scenarios S-1…S-3, S-5, S-6 covered (`pos-bookings-sweep`, `pos-zoned-release`,
      `organization-policy`). **S-4 was rewritten in the build** — see below
- [x] S6 (per-folio extension) **withdrawn** — `reactivate` covers the case it was for

---

## Open

**The capacity cost of S2 has no mitigation in this design.** Seats are held until minutes before
departure and the booth cannot resell them. The compensation is the retained deposit. If that turns
out to be the wrong trade in practice, the smallest change is a bounded silence window — notify at
`salida − 24h`, cancel at `salida − 12h` if nothing happened — which was the original
recommendation. Recording it here so the alternative is one decision away rather than a redesign.
