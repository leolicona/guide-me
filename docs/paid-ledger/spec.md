# Feature: Paid Ledger — per-payment money movements as the cash engine's source of truth

**User stories:** US-LG01–LG08 (a `folio_payments` ledger records every money movement — deposit,
balance settlement, refund, commission, clawback — each with its own method, reference,
verification, collector, and date; the agent cash engine and admin reports read the ledger, not a
single folio-level method). Revises the behaviour of **US-AG07** (booking settle), **US-AG25/AG29**
(agent cash buckets), **US-A23/US-T05** (cash refund), **US-A67** (electronic-payment
verification), and **US-A68** (operator attribution on the caja). To register in `docs/SPEC.md`.
**Phase:** 2 (Core Enhancements) · **agent + operator + admin surface.**

**Depends on:**
- *Agent Balance UX Overhaul* (`docs/cash-drops/…`, US-AG25/AG29 — the cash-collected / by-method
  buckets and the confirmed-drop **watermark** fast path this rewrite re-homes onto the ledger).
- *Payment Verification* (`docs/payment-verification/spec.md`, US-AG41/US-A67 — the
  `payment_reference` + `payment_verification` gate this makes **per-payment**).
- *Bookings / Settle* (US-AG07 — the one-shot balance settle whose method this finally captures).
- *Cancellation & Refund* (`docs/cancellation/…`, US-A21/A23/T05 — `confirmRefund`, the physical
  cash hand-back that becomes a negative ledger row).
- *Affiliate Operators* (`docs/affiliate-operators/spec.md`, US-A68 — the `operator_id` each
  payment row stamps so a shift's collections are traceable).

> **What & why.** Today a folio carries **one** `payment_method` and **one** `amount_paid` scalar.
> When an agent settles a booking's balance, the code **re-uses the deposit's method**
> (`pos/handler.ts` `settleBooking`) — there is no field to say *"the deposit was cash, the balance
> arrived by transfer."* Worse, the agent cash engine sums a folio's **entire** `amount_paid` under
> that single method (`cash/handler.ts` `sumCashCollected` / `sumSalesByMethod`), so the moment a
> deposit and a balance are collected two different ways the drawer **silently mis-reconciles**.
> This feature replaces the folio-level money scalars with a **`folio_payments` ledger** — one row
> per money movement, each stamped with its own method, reference, verification, collector, operator
> and date. The ledger becomes the **single source of truth for the whole cash engine**: cash
> collected, by-method sales, commissions, and refunds are all sums over ledger rows. This makes the
> `sumCancellationReversal` watermark hack (TECH_DEBT §12a) **obsolete and removable**, because a
> post-watermark refund or clawback is simply a correctly-dated negative row that the existing
> "Σ events since the watermark" fast path already picks up.

---

## Context

### How money works today (and where it breaks)

**Folio money is three scalars** (`db/schema.ts` `folios`):
- `payment_method` (`cash | card | transfer | link`) — how the sale was collected. Only `cash`
  adds to the agent's cash debt; everything else is "electronic" (earns commission, money goes to
  the company).
- `amount_paid` — money collected so far (deposit for a `booking`, full `total` once `paid`).
- `payment_reference` + `payment_verification` (`not_required | pending | verified`) — the US-A67
  gate: a slot line's QR is signed only when the folio is `paid` **and** verification ≠ `pending`.
- `commission_amount` — the agent's accrued commission, snapshotted at confirm/settle.

**Settle re-uses the deposit method.** `settleBooking` computes `cleared = folio.paymentMethod !==
'transfer'` and never accepts a settle method — so a cash-deposit booking can only ever settle *as
cash*, a transfer-deposit only *as transfer*. **This is the reported defect.**

**The cash engine is folio-level.** `deriveBalance` (`cash/handler.ts`) computes
`balance = cash_collected − commissions − expenses − confirmed_drops + payouts`, where:
- `cash_collected` = `Σ folios.amount_paid WHERE payment_method='cash'` (non-cancelled).
- `sales_by_method` = the same sum **grouped by** `folios.payment_method`.
- `commissions` = `Σ folios.commission_amount` (kept on live folios, or absorbed clawbacks).
- A **confirmed cash drop** writes a `balance_after` **watermark**; the FAST PATH sums only events
  with `created_at >` the watermark (bounded by shift size). TECH_DEBT §12a
  (`sumCancellationReversal`) special-cases a *pre*-watermark folio cancelled *post*-watermark:
  it reverses that folio's cash + clawed-back commission into the **current** shift, dated at
  `cancelled_at`, so the frozen `balance_after` is never rewritten.

**Refunds.** `confirmRefund` (`folios/handler.ts`) flips `refund_status` `pending → refunded` on the
physical cash hand-back (tourist PIN or override), dated `refunded_at` — **often a different shift
than the cancellation**. It "never alters amounts (frozen history)." A cancelled **booking** retains
its deposit (non-refundable, D7 — no money returned); a **rejected** pending transfer collected
nothing (no money returned).

### The core problem

A single `(payment_method, amount_paid)` pair **cannot represent one folio whose money arrived via
two methods** (cash deposit + transfer balance), which the operator confirmed happens often. Any fix
that keeps money folio-level either loses the split or mis-reconciles the drawer. The money must
move to a **per-movement ledger**.

---

## The model — `folio_payments`

A new **org-scoped** table; one row per money or commission movement on a folio.

| column | type | notes |
|---|---|---|
| `id` | text PK | |
| `organization_id` | text NOT NULL → organizations | tenant key; every query scopes by it |
| `folio_id` | text NOT NULL → folios | |
| `entry_type` | text NOT NULL | `payment` \| `refund` \| `commission` \| `commission_reversal` |
| `amount` | integer NOT NULL | **signed** minor units. `payment`,`commission` > 0 · `refund`,`commission_reversal` < 0 |
| `method` | text NULL | `cash \| card \| transfer \| link` — **required** for `payment`/`refund`, **null** for commission rows |
| `reference` | text NULL | bank ref; non-null only for a `transfer` payment |
| `verification` | text NOT NULL | `not_required \| pending \| verified` (per row; commission/cash rows = `not_required`) |
| `collected_by` | text NOT NULL → users | the user who took **this** money (settle can differ from the seller) |
| `operator_id` | text NULL → affiliate_operators | the PIN shift that took it (US-A68), null for in-house |
| `verified_at` | integer(ts) NULL | audit — when an electronic row was verified |
| `verified_by` | text NULL → users | audit — the admin who verified/refunded |
| `created_at` | integer(ts) NOT NULL | **the money's own date**: deposit=confirm, balance=settle, refund=hand-back, clawback=cancel |

**Indexes:** `(organization_id, folio_id)`; `(organization_id, collected_by, created_at)` for the
shift sums; a partial index on `(organization_id, verification)` where `verification='pending'` for
the admin queue.

### Derived / cached on `folios`

- **`amount_paid`** stays as a **maintained cache** = `Σ amount WHERE entry_type IN
  (payment, refund)` for the folio. Updated in the **same batch** as every ledger insert. The
  ledger is the source of truth; the scalar avoids rewriting the many reads that show a folio total.
- **`payment_verification`** stays as a **cached rollup** = `pending` if any `transfer` payment row
  is unverified, else `verified` (if any electronic row exists) / `not_required`. Preserves the
  US-A67 admin "Por verificar" queue and the QR-signing gate with no read rewrites at the gate.
- **`commission_amount`** stays as a **cached rollup** = `Σ amount WHERE entry_type IN
  (commission, commission_reversal)`. (The commission *rules* — keep / absorb / clawback — are
  unchanged; they now emit ledger rows instead of mutating the scalar directly.)
- **`payment_method` is DROPPED.** A `deriveDisplayMethod(rows)` helper returns the shared method
  when all `payment`/`refund` rows agree, else the literal **`Mixto`**. Consumed by folio-list
  chips, the ticket email, and folio detail.

---

## Design decisions

- **D1 — Signed single-column amount.** One `amount` (signed) + `entry_type`, not separate
  debit/credit columns. Sums stay trivial (`Σ amount …`) and a refund/clawback is self-evidently a
  negative of its origin.
- **D2 — `entry_type` axis carries commission.** Because commission has no payment method, a plain
  `(amount, method)` row can't describe it. `entry_type` separates money movements
  (`payment`/`refund`, method-bearing) from accruals (`commission`/`commission_reversal`,
  method-null). `cash_collected` filters to money rows with `method='cash'`; `commissions` filters
  to the two commission types.
- **D3 — Ledger dates are real-world dates.** `created_at` is *when that money moved*, not when the
  row was written en-masse. This is what lets the watermark fast path stay correct: a post-watermark
  refund/clawback lands in the current shift automatically.
- **D4 — §12a is deleted, not ported.** With D3, `sumCancellationReversal` and its "reverse
  pre-watermark cancellations into the current shift" logic are **removed**. A cancellation that
  claws back commission writes a `commission_reversal` row dated `cancelled_at`; a confirmed refund
  writes a `refund` row dated `refunded_at`. Both are ordinary current-shift events.
- **D5 — Retained money writes no negative row.** A cancelled **booking** (non-refundable deposit,
  D7) and a **rejected** pending transfer (nothing collected) return no money → **no `refund`
  row**. Only `confirmRefund` (an actual hand-back) writes one. The clawback of *commission* is
  independent and still fires where it fires today.
- **D6 — Reversal at cancellation (revised during Step 4).** The engine reverses money at the
  moment a folio is **cancelled**, not at the later physical hand-back — preserving the established
  "cancellation = removal" reconciliation the whole cash engine (and the drop watermark) is built
  on. A cancellation writes negative **`refund`** rows (one per collected method) plus, on clawback,
  **`commission_reversal`** rows — each mirroring the folio's own per-method net (so a MIXED folio
  reverses cash and transfer in the right proportions), all dated at `cancelled_at`. Because those
  rows carry a real date, the watermark fast-path absorbs a post-watermark cancellation as an
  ordinary current-shift event — which is exactly what lets the §12a hack be deleted. `confirmRefund`
  stays the audit/PIN hand-back gate and moves **no** money again (the sale was already reversed).
  *(The earlier "reverse at confirmRefund hand-back" option was dropped: it rewrites ~12 proven
  reconciliation scenarios + the watermark premise for a transient-state nicety.)*
- **D7 — Settle stays one-shot.** The ledger *supports* N payments, but the settle UX keeps today's
  rule: settle collects the **full remaining balance** in one row and flips `booking → paid`.
  Installments are a documented follow-up.
- **D8 — Per-payment collector + operator.** Every row stamps `collected_by` (the acting user) and
  `operator_id` (the PIN shift, borrowing the manager identity exactly as `confirmSale` does). A
  deposit and its balance can show **different** collectors.
- **D9 — Per-payment verification, folio rollup preserved.** A cash/card/link row is
  `not_required`/auto; a `transfer` row is `pending` until an admin verifies it. The folio's cached
  `payment_verification` = `pending` iff any transfer row is unverified. The QR gate
  (`paid ∧ verification ≠ pending`) is unchanged at the read site.
- **D10 — `payment_method` dropped; `Mixto` derived.** No folio-level money method survives. Display
  reads derive a method from the rows, showing `Mixto` when they differ.
- **D11 — Backfill = one synthetic row per folio.** Historical settled bookings already overwrote
  `amount_paid` to `total` and lost the deposit/balance split; the migration seeds **one** `payment`
  row (`amount=amount_paid`, `method=payment_method`, ref, verification, `created_at=created_at`,
  `collected_by=agent_id`) plus **one** `commission` row where `commission_amount > 0`. Exact totals
  are preserved; pre-migration folios simply can't show a split. No fabricated history.
- **D12 — Cross-org isolation is mandatory.** `folio_payments` is tenant-scoped; every new
  route/read filters `organization_id` from context (never body), with `seedTwoOrgs` isolation
  tests (per `CLAUDE.md`).

---

## User story breakdown

> IDs to register in `docs/SPEC.md`. Each story's **DoD** lists its acceptance + the tests that
> gate it. Money is minor units throughout.

### US-LG01 — The ledger exists and back-references every folio
**As** the system, **I want** a tenant-scoped `folio_payments` table and a backfilled row per
existing folio, **so that** every folio's money has a per-movement home without changing any current
total.
**DoD:** migration creates the table + indexes; backfill seeds one `payment` row per folio and one
`commission` row per folio with `commission_amount>0`; for every folio `Σ(payment+refund amounts) =
amount_paid` and `Σ(commission rows) = commission_amount`. Cross-org: an org's rows are invisible to
another (`seedTwoOrgs`).

### US-LG02 — Sales write payment + commission rows (dual-write)
**As** an agent/operator confirming a sale, **I want** each sale to record its money and commission
as ledger rows, **so that** the ledger mirrors reality from day one.
**DoD:** `confirmSale` inserts a `payment` row (deposit amount for a booking, `total` for a paid
sale) with the chosen method/reference/verification, `collected_by`, `operator_id`, and a
`commission` row; the folio scalars still reconcile to the rows. Verification rollup matches the old
folio value. Cross-org isolation preserved.

### US-LG03 — Settling a balance captures its own method  *(the reported defect)*
**As** an agent/operator collecting a booking's remaining balance, **I want** to choose how the
balance was paid (cash / card / transfer / link) independent of the deposit, **so that** the caja
shows what really happened.
**DoD:** `POST /pos/folios/:id/settle` accepts `{ method, reference? }`; `method='transfer'`
requires a `reference` and sets that row `pending` (QR deferred to admin verify, exactly like a
transfer sale); other methods clear immediately. A **balance `payment` row** is written with its own
method + `collected_by`/`operator_id`; the folio flips `booking → paid`; `amount_paid` becomes
`total`; the deposit row is untouched. A folio with a **cash deposit + transfer balance** exists and
reads back both rows. Cross-org + the existing settle guards (404 / already-paid / cancelled /
expired) still hold.

### US-LG04 — The agent cash engine reads the ledger
**As** the operator's admin/agent, **I want** cash-collected, by-method sales, and commissions
derived from the ledger, **so that** a mixed-method folio reconciles correctly.
**DoD:** `sumCashCollected` = `Σ amount WHERE entry_type∈(payment,refund) ∧ method='cash'`;
`sumSalesByMethod` groups money rows by method; `sumCommissions[ByMethod]` sums the commission
types. The watermark FAST PATH sums ledger rows with `created_at > since`. `sumCancellationReversal`
(§12a) is **removed**. All existing cash-engine tests pass; a new test proves a cash-deposit /
transfer-balance folio splits into the correct buckets.

### US-LG05 — Refunds net the drawer as a negative cash row
**As** an admin confirming a physical refund, **I want** the hand-back to reduce cash collected on
the shift it happens, **so that** the drawer balances without the §12a hack.
**DoD:** `confirmRefund` writes a `refund` row (`method='cash'`, `−refund_amount`,
`created_at=refunded_at`, `verified_by=admin`) in the same transaction as the `refund_status`
flip; `amount_paid` decrements. A refund confirmed in a **later shift** than the cancellation reduces
that later shift's cash (no watermark rewrite). A cancelled **booking** (retained deposit) and a
**rejected** payment write **no** refund row.

### US-LG06 — Cancellation clawback becomes a commission_reversal row
**As** the system cancelling a folio, **I want** a clawed-back commission to post a negative
commission row dated at cancellation, **so that** the ledger, not §12a, carries the reversal.
**DoD:** a clawback (`cancellation_clawback=true`) inserts a `commission_reversal` row
(`−commission`, `created_at=cancelled_at`); an absorbed cancellation (`clawback=false`) inserts
none; `commission_amount` rollup updates. Cross-shift cancellation reduces the current shift's
commission total via the row's date alone.

### US-LG07 — Verification is per-payment; the QR gate is unchanged
**As** an admin, **I want** to verify the specific electronic payment that is pending, **so that** a
folio with one cleared and one pending payment is handled precisely.
**DoD:** `verifyPayment` flips the target `transfer` row `pending → verified` (`verified_at/by`),
recomputes the folio rollup, and — when the folio reaches `paid ∧ no pending row` — runs the
deferred QR/portal/email side effects once. The "Por verificar" admin queue lists folios with a
pending row. Rejecting a pending transfer cancels the folio (unchanged) and writes no refund row.

### US-LG08 — Display derives a method (incl. `Mixto`); `payment_method` is dropped
**As** anyone reading a folio, **I want** the method shown to reflect the ledger, **so that** a
mixed folio is labelled honestly.
**DoD:** `folios.payment_method` column removed; `deriveDisplayMethod` returns the shared method or
`Mixto`; folio-list chips, folio detail (with a **per-payment breakdown**: method · amount ·
collector · date), and the ticket email consume it. No read site references the dropped column.

---

## Implementation — atomic, independently shippable, each green

> The money engine is load-bearing, so we **dual-write then cut over** rather than swap in one
> commit. Every step builds + passes the full API suite (and lint/build for the app) before the
> next. One PR per step (stacked).

**Step 1 — Schema + migration + backfill (US-LG01).** Add `folioPayments` to `db/schema.ts`; new
migration `0049_folio_payments.sql` creates the table + indexes and backfills one `payment` (+
`commission`) row per folio (D11). **No behaviour change** — nothing reads the table yet.
*Test:* migration applies (local + `--env dev` dry check); backfill invariants (`Σ rows =
amount_paid` / `commission_amount`) per folio; `seedTwoOrgs` isolation.

**Step 2 — Dual-write on every money path (US-LG02, LG05 rows, LG06 rows).** `confirmSale`,
`settleBooking`, `confirmRefund`, cancel/reject insert the correct ledger rows **in the same batch**
as today's scalar mutations. Scalars remain authoritative; the ledger is a verified shadow.
*Test:* each path writes the expected rows; a reconcile assertion (`Σ rows = scalars`) after each
operation across the existing POS/folio/refund suites.

**Step 3 — Settle captures its method (US-LG03).** Extend `settleSchema` to `{ method, reference? }`;
`settleBooking` writes the balance row with its **own** method + collector/operator; stop deriving
`cleared` from the deposit method — derive it from the settle method. `payment_method` is no longer
overwritten by settle (it stays the deposit method until Step 5 drops it).
*Test:* cash-deposit → transfer-balance folio (verification `pending`, QR deferred); cash-deposit →
cash-balance (clears); transfer-deposit → cash-balance; settle guards intact; cross-org.

**Step 4 — Cash engine reads the ledger; delete §12a (US-LG04, LG05, LG06, LG07).** Rewrite
`sumCashCollected` / `sumSalesByMethod` / `sumCommissions[ByMethod]` onto `folio_payments`; the
watermark fast path sums ledger rows since the watermark; **remove `sumCancellationReversal`**. Move
verification rollup + QR gate to read the rows.
*Test:* the entire cash-drops/balance suite; new cases — mixed-method folio buckets, cross-shift
refund reduces the later shift, cross-shift clawback, watermark fast-path parity vs full-history
fallback.

**Step 5 — Drop `payment_method`; derive display + `Mixto` (US-LG08).** Migration
`0050_drop_folio_payment_method.sql`; add `deriveDisplayMethod`; update folio-list chips, folio
detail (per-payment breakdown), ticket email. Remove the now-dead scalar reads.
*Test:* display/email unit coverage; grep proves no residual `payment_method` reads; full suite.

**Step 6 — Frontend settle sheet + folio breakdown (US-LG03 UI, US-LG08 UI).** Replace the one-tap
*Liquidar saldo* in `BookingActions` with a `BottomSheet`/`FormSheet`: segmented method (default =
deposit's method), `MoneyText` balance, reference required only for transfer. Folio detail renders
the per-payment breakdown; list chips show `Mixto`.
*Test:* `pnpm lint:app` + `pnpm build:app` (baseline warnings only); **Playwright** walkthrough on
`/pos/folio/{id}` at mobile width — settle a booking as transfer (reference required, QR deferred),
as cash (clears), and confirm the breakdown + `Mixto` chip render.

---

## Test plan (cross-cutting)

- **Reconciliation invariant** (Steps 2–4): after every money operation, `folio.amount_paid =
  Σ(payment+refund rows)` and `folio.commission_amount = Σ(commission rows)`.
- **Cash-engine parity** (Step 4): the watermark FAST PATH and the full-history FALLBACK produce
  identical balances for the same event stream (the property §12a protected).
- **Cross-shift money** (Steps 4–5): a refund/clawback dated after a confirmed drop reduces the
  **current** shift, never the frozen `balance_after`.
- **Multitenancy** (all steps): `seedTwoOrgs` — org B never sees org A's rows, sums, or queue.
- **Frozen clock** harness (`2026-06-14T12:00:00Z`) + `mockAgnosticAuth` unchanged.

---

## Out of scope (documented follow-ups)

- **Installments** — recording a balance across multiple partial payments (the ledger supports it;
  the settle UX stays one-shot, D7).
- **Channel-faithful refunds** — mirroring each original method on refund instead of cash-only (D6).
- **Reporting surfaces** — new admin reports that slice revenue by *actual* collection method across
  mixed folios (the data now exists; the read models are a separate story).

## Open risks

- **Money-engine regressions.** The rewrite touches balance derivation and the drop watermark. The
  dual-write reconciliation invariant (Steps 2–3) is the safety net that lets Step 4 cut over with
  confidence; do not skip it.
- **Backfill on prod.** `0049` backfills every historical folio; it must be idempotent and run
  inside the migration transaction, verified on `--env dev` before `--env production`.
- **`Mixto` in the email.** The ticket email currently prints one method; for a mixed folio it will
  read `Mixto` (or the deposit method) — confirm copy with the design system before Step 5.
