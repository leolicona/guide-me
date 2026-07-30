# Feature: Apartados as stages — notify before releasing

> **Status: DESIGNED, NOT BUILT.** The decisions below are settled; no code implements them yet.
> Everything described here is a change to `docs/bookings/bookings-down-payments.spec.md`
> (US-AG07/AG07.1) and interacts with `docs/cancellation/cancellation-policy-engine.spec.md`.

## Context

Today the settle deadline is an **event**: `booking_expires_at` arrives, the cron cancels the folio,
the seats go back. The customer finds out by finding out.

That model has three defects, and they are not independent.

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
| **S6** | **Per-folio extension of the FINAL deadline, with an audit trail** (`booking_extended_by` / `booking_extended_at`). | *(Reinterpretation of a user decision — see § Open.)* Under S2 "move to stage ②" is not an action, because advancement is automatic. What remains uncovered is the late arrival: a customer stuck in traffic five minutes out. Today that is only expressible org-wide via a negative grace offset. Requiring proof of a phone call was rejected — nobody verifies it, and it turns an honest record into a checkbox. |
| **S7** | **Stage is DERIVED from timestamps, not stored.** `now < booking_expires_at` ⇒ ①, otherwise ②. | A stored stage needs a writer, and a cron that writes state drifts from the clock that defines it. The existing `booking_expires_at` already carries the ① boundary; ② ends at the grace instant, computable from the departure. |

---

## Business rules

1. **Creation.** An apartado may not be created when the earliest departure in the cart is closer
   than the creation cutoff (S1) → `422 BOOKING_TOO_LATE`. A full-payment sale is unaffected and
   remains governed by `sales_cutoff_offset_minutes` alone.
2. **The settle deadline no longer cancels.** At `booking_expires_at` the sweep sends the
   notification and advances the folio to stage ② by recomputing its release instant — the same
   call `reactivate` already makes (`pos/handler.ts`, `bookingExpiryDate` with the current clock).
3. **One notification per folio.** Guarded by `reminder_status`, so a re-run of the cron cannot
   re-send. An agent's manual WhatsApp claim and a system email are the same flag: whichever
   happened first, the customer was told.
4. **Stage ② ends by cancelling**, priced by the ladder like every other cancellation
   (`cancelFolioPriced`, `cancellation_source = 'system_expiry'`). At the grace instant that is the
   terminal tier, so the customer recovers nothing unless the org configured otherwise.
5. **The sweep is fail-soft per folio.** One folio that throws must not abort the run. *(Today it
   is not: there is a single `.catch` in the `scheduled` handler and no per-folio guard, although
   `cancellation-policy-engine.spec.md` Rule 24 already claims otherwise. Fix here.)*
6. **Extension (S6) is bounded** by nothing but the org's grace offset semantics — an agent may push
   a folio's release past departure, which is what the negative-offset direction already means.
   Every extension records who and when.

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

**S-4 — A late sale enters at ② directly**
Given the creation cutoff is 48h and the settle deadline 24h
When an agent tries to open an apartado 30h before departure
Then `422 BOOKING_TOO_LATE`. *(With S1 in force, a sale can no longer be born inside stage ②; the
`nearDeparture` branch survives only for `reactivate`.)*

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

- [ ] New org setting: apartado creation cutoff (hours), with `límite ≥ plazo` validated **in the
      form and at the endpoint** — a rule enforced only in the UI is not a rule
- [ ] `confirmSale` rejects a too-late apartado with `422 BOOKING_TOO_LATE`; a full-payment sale is
      untouched
- [ ] The sweep splits into two passes: **notify + advance** at `booking_expires_at`, **cancel** at
      the grace instant. Cancelling goes through `cancelFolioPriced`
- [ ] Per-folio `try/catch` in the sweep (Rule 5) — closes the gap between
      `cancellation-policy-engine.spec.md` Rule 24 and the code
- [ ] A balance-reminder email template in `services/resend.ts`
- [ ] `booking_extended_by` / `booking_extended_at` + the agent action (S6) — **confirm scope with
      the user first**, see § Open
- [ ] Settings copy: the creation cutoff explained next to the settle deadline, since the two are
      now a pair
- [ ] `cancellation-policy-engine.spec.md` D21 marked superseded; US-A74 restored in `SPEC.md`
- [ ] Scenarios S-1…S-6 covered

---

## Open

**S6 needs confirming.** The user answered "(a) — the agent can move it whenever, with an audit
trail" to a question about *moving a folio to stage ②*. Their answer to S2 then made that action
impossible: advancement is automatic, so there is nothing to move. S6 reinterprets the answer as
applying to the late-arrival extension instead, which is the nearest real need. **Confirm before
building it** — the alternative is dropping it entirely, since the org-wide negative grace offset
already covers the common case.

**The capacity cost of S2 has no mitigation in this design.** Seats are held until minutes before
departure and the booth cannot resell them. The compensation is the retained deposit. If that turns
out to be the wrong trade in practice, the smallest change is a bounded silence window — notify at
`salida − 24h`, cancel at `salida − 12h` if nothing happened — which was the original
recommendation. Recording it here so the alternative is one decision away rather than a redesign.
