# Bug Assessment: Rejecting an apartado's settlement transfer voids the whole sale, cash deposit included

- **Slug**: reject-settle-voids-deposit
- **Created**: 2026-10-16
- **Source**: pasted text — found while tracing the apartado + transfer flow in conversation with the developer
- **Verdict**: valid
- **Severity**: high

## Report (verbatim or summarized)

> Rechazar la transferencia del SALDO de un apartado cancela todo el folio, incluido un anticipo
> cobrado en efectivo. `rejectPayment` (api-turistear/src/routes/pos/handler.ts:2993) no distingue si
> el pago pendiente es el anticipo o la liquidación: cancela el folio completo, libera los lugares,
> hace clawback de la comisión y llama a `buildCancellationReversal` sin `refundAmount`, que revierte
> del ledger TODO lo cobrado (efectivo incluido) "como si nada se hubiera cobrado", aunque el efectivo
> del anticipo sigue físicamente en manos del vendedor — el corte de caja ya no lo pide. Es la misma
> clase de defecto que D20 corrigió en cancelBooking. […] Esperado: rechazar la liquidación anula solo
> el pago rechazado y deja el folio como apartado con su anticipo y sus reglas de plazo intactas
> (mismo criterio que specs/006-devolada-transfer-verification escenario 4 / plan D8: "A sale is
> never cancelled automatically while it holds money that was cleared"). No hay prueba que cubra
> rechazar después de liquidar por transferencia.

## Symptom

An admin rejects a pending transfer on a folio that **also holds cleared money** — typically an
apartado whose deposit was paid in cash and whose balance was then settled by transfer. The whole
folio is cancelled: every line is stamped cancelled, the seats go back on sale, all commission is
clawed back, and the ledger reverses **every** peso collected, the cash deposit included. No refund
obligation is recorded, so the customer's deposit disappears from the books while the cash is still
in the seller's hands.

Expected: rejecting a payment voids **that payment only**. If the folio still holds cleared money
afterwards, it stays alive — an apartado again, with its deposit, its seats and its own hold clock
intact. Only a folio whose sole money was the rejected transfer is cancelled, as today.

## Reproduction

1. Seller creates an apartado with a **cash** deposit:
   `POST /api/pos/sales` with `down_payment` < total, `payment_method: 'cash'` → folio `booking`,
   `payment_verification = 'not_required'`, seats decremented, a `cash` payment row in
   `folio_payments`.
2. Seller settles the balance by **transfer**:
   `POST /api/pos/folios/:id/settle` with `{ method: 'transfer', payment_reference: '…' }` →
   `settleBooking`'s deferred branch (`handler.ts:2314`) writes a `pending` transfer payment row
   with allocations that complete every line, so the folio derives `paid`;
   `payment_verification` re-arms to `pending`; no QR. The folio lands in **Por verificar**.
3. Admin taps **Rechazar pago** → `POST /api/pos/folios/:id/reject`.
4. Observed:
   - folio and all lines stamped `cancelled_at` → status `cancelled`;
   - `slots.booked` decremented → seats back on sale;
   - `buildCancellationReversal` (no `refundAmount`) writes a negative `cash` refund row for the
     deposit **and** a negative `transfer` row for the balance, plus commission reversals for both;
   - the seller's cash balance (`sumCashCollected`, `cash/handler.ts:204`) drops by the deposit,
     so the corte no longer asks for cash that was physically collected;
   - no line gets `refund_status = 'pending'`, so nothing says the customer is owed the deposit;
   - the customer is told (`payment_rejected`, `notifications.ts:77`) that their folio was cancelled.

Same defect, other entry points (same code path, not yet exercised by a test):

- **Per-line settle by transfer** (`settleFolioLine`, `handler.ts:2476`): a two-line apartado whose
  line A was settled in cash (QR issued) and line B by transfer. Rejecting cancels **both** lines,
  voiding line A's ticket and reversing its cash.
- **Transfer deposit still pending + cash balance**: rejecting the deposit also reverses the cash
  balance. [NEEDS CLARIFICATION: what the folio should become — see Open Questions.]

## Suspected Code Paths

- `api-turistear/src/routes/pos/handler.ts:2993` `rejectPayment` — the only reject path. Written for
  US-A67 D6, when a pending payment could only be the sale's **first** money ("nothing was
  collected"). It never asks which payment is pending, or whether cleared money exists.
- `handler.ts:3025-3063` — stamps `cancelledAt` on the folio and **all** lines with no filter by the
  lines the rejected payment funded.
- `handler.ts:3064-3089` — releases every line's seats.
- `handler.ts:3105` — `buildCancellationReversal(db, { …, clawback: true })` without `refundAmount`
  / `reversedCommission` → full reversal of every positive money and commission bucket
  (`utils/folioPayments.ts:215`).
- `handler.ts:2314` (`settleBooking`, deferred branch) and `handler.ts:2476` (`settleFolioLine`) —
  the paths that create a pending payment on a folio that already holds cleared money (US-LG03 made
  the balance's method independent of the deposit's). They are correct; `rejectPayment` was not
  updated when they were introduced.
- `api-turistear/src/db/schema.ts:933` — `folio_payments.verification` has no `rejected` value, so a
  rejected payment row stays `pending` forever. (Spec 006's context table shows a production
  transfer still reading *pending* 66 days after its sale was cancelled.)
- `app-turistear/src/features/folios/components/FolioWorkActions.tsx:357` — the sheet promises
  *"La venta se cancelará: se liberan los lugares…"*, and the button reads **Rechazar venta**, for
  every pending payment, settlement included.
- `app-turistear/src/features/folios/components/FolioTimeline.tsx:109` — the timeline reads
  *"Transferencia rechazada — venta cancelada"*.

## Root Cause Hypothesis

`rejectPayment` equates "a transfer was rejected" with "the sale is void". That held while the
only transfer a folio could wait on was its first payment. The re-armable verification axis
(US-A67) and the per-movement settle method (US-LG03) let a folio that already holds cleared money
take a second, pending transfer, but the reject path kept treating the folio as a single payment. It
cancels, releases and reverses everything instead of voiding the one pending movement. This is the
same class of defect D20 removed from `cancelBooking`: a full ledger reversal that erases cash still
in the agent's drawer (constitution II, Money Law). Confidence: **high** — read directly from the
code, and the existing reject test (`payment-verification.test.ts:180`) covers only a full transfer
sale, where the behaviour is correct.

## Proposed Remediation

**Preferred — reject voids the pending payment(s); the folio is cancelled only when nothing cleared
remains.**

In `rejectPayment`, read the folio's `payment` rows and split them into **pending** (being rejected)
and **cleared** (`not_required` / `verified`, net of any refunds).

- **No cleared money remains** (a full transfer sale, or a transfer deposit with nothing else) →
  today's path, unchanged: cancel, release seats, full reversal, `payment_rejected`.
- **Cleared money remains** → a partial void, one batch:
  1. For each pending payment row: write the offsetting ledger rows — a negative money row on the
     same method, plus **negative allocations** mirroring that payment's allocations (the
     `allocationRows(…, sign: -1)` helper). The lines it funded derive back to owing, so the folio
     derives `booking` again. Mark the rejected row so it never reads as pending again
     (see Alternatives for how).
  2. Reverse only the commission the settlement accrued — the top-up `settleBooking` /
     `settleFolioLine` booked — so the folio's commission returns to its deposit-state value.
  3. `folios`: `amount_paid -= rejected`, `commission_amount -= reversed top-up`,
     `settled_at` / `settled_by` → null, `payment_reference` → null, and `payment_verification`
     recomputed from the payments that remain (`verified` if a verified transfer remains, else
     `not_required`).
  4. **Do not** touch `cancelled_at`, seats, `booking_expires_at` or `reminder_status`. The hold
     clock was never cleared by the settle, so the sweep resumes on its own: a folio rejected past its
     grace instant is released on the next run, priced by the ladder, with credit, like any other
     lapsed apartado.
  5. A `transfer_rejected` folio event with `payload.kind = 'settlement'`, and a
     notification whose copy says the **payment** was not confirmed and the apartado continues
     (today's `payment_rejected` template says the folio was cancelled).
- Frontend: the reject sheet and timeline copy branch on the outcome. A settlement rejection reads
  as *"Se anula el pago del saldo; la venta vuelve a ser apartado con su anticipo"*, and the button
  says **Rechazar pago**, not **Rechazar venta**.

Extract the partial void as a function (e.g. `voidPendingPayments(db, org, folioId, actor, at)`).
The 24 h verification limit requested alongside this bug will need the same action for an expired
settlement, and spec 006 (Devolada) needs it for scenario 4.

**Alternatives**:

- *Add `rejected` to `folio_payments.verification` and exclude rejected rows from every money
  reader* instead of writing offsetting rows. It is cleaner to read, but every ledger reader
  (`cash`, `reports`, `dashboard`, `folioDetail`, the reconciliation suites) gains a filter, and a
  forgotten one re-counts the rejected money. The offsetting rows keep the ledger append-only and
  every existing Σ correct with no reader change. The `rejected` state is still worth adding as a
  **label** on top of the offset, so the row stops reading as pending. It is a TypeScript enum with
  no SQLite CHECK constraint, so no migration is needed. Verify this during the fix.
- *Block the reject when cleared money exists* and make the admin cancel by hand. It is smaller,
  but it leaves an unverifiable transfer with no exit and pushes the admin into the very
  cancellation that loses the deposit.

**Files likely to change**:

- `api-turistear/src/routes/pos/handler.ts` (`rejectPayment`; a shared partial-void helper)
- `api-turistear/src/utils/folioPayments.ts` (offset rows for a single payment, if a helper is missing)
- `api-turistear/src/utils/notifications.ts` (a settlement-rejected template or a variant)
- `api-turistear/src/db/schema.ts` (`verification` enum gains `rejected`, label only — if adopted)
- `app-turistear/src/features/folios/components/FolioWorkActions.tsx`, `FolioTimeline.tsx` (copy)
- `api-turistear/test/pos/reject-settlement.test.ts` (new)

**Tests to add or update** (new file — `payment-verification.test.ts` is held unedited by spec 006's
scope boundary):

1. Cash deposit + transfer settle + reject → `status = 'booking'`, seats still held,
   `amount_paid = deposit`, seller's cash balance still includes the deposit, commission back to
   its deposit-state value, no QR, `booking_expires_at` unchanged, `payment_verification` no longer
   `pending`, folio out of the `?verification=pending` queue.
2. Same folio, after the reject, settles again in cash → `paid`, QR issued (the apartado is fully
   usable again).
3. Rejected past its grace instant → the next `sweepExpiredBookings` run releases it through the
   ladder (credit, not cash), like any lapsed apartado.
4. Two-line apartado: line A settled in cash (QR), line B settled by transfer; reject → line A
   untouched (paid, QR valid), line B back to owing.
5. Full transfer sale reject → unchanged (cancelled, seats released) — already covered at
   `payment-verification.test.ts:180`; keep it green.
6. Transfer deposit pending + transfer settle pending + reject → no cleared money → cancelled as
   today.
7. Cross-org: an admin of org B cannot reject org A's settlement → 404, folio untouched
   (`seedTwoOrgs`).
8. Paid-ledger reconciliation: Σ payment rows == `amount_paid` and Σ allocations per line hold after
   a partial void (`test/paid-ledger/*` stays green).

## Risks & Considerations

- **Ledger invariants.** The paid-ledger suites assert Σ payment rows == `amount_paid` and
  per-line allocation sums. The offsetting rows must keep both. Run `test/paid-ledger/*` and
  `test/folios/folio-allocations*.test.ts`.
- **Commission top-up identification.** The settle's commission row is not linked to its payment
  row. Recomputing the deposit-state commission from the snapshot (as `confirmSale` does:
  percent × cleared / total, fixed only at `paid`) is safer than matching rows by timestamp.
- **Reports.** A negative `transfer` money row that is not a refund must not surface as a refund in
  `reports/handler.ts` or the dashboard. Check how they classify `entry_type = 'refund'` before
  choosing the offset's entry type.
- **Spec 006 overlap.** Plan D8 there records a *Devolada* settlement only once confirmed, so the
  automated path avoids this state entirely. The manual path still records the settlement pending,
  and this fix is what makes its reject safe. Keep the helper shared, not duplicated.
- **24 h verification limit** (requested together with this bug; a feature, not part of this fix):
  on expiry it must take this same partial-void path for a settlement. Land this fix first.
- **Copy and notification changes** reach the customer (WhatsApp outbox, email). No template text
  is stored per organization for `payment_rejected`. Confirm before relying on that.

## Open Questions

- [NEEDS CLARIFICATION: Transfer deposit **pending** + balance settled in **cash**, then the deposit
  is rejected. The folio keeps the cash balance but loses the deposit. Should it become an apartado
  owing the deposit amount (consistent with the rule above), or should the cash be treated as the
  deposit and the folio re-derive from what was actually collected? The rule "void only the
  rejected payment" gives the first answer; confirm it is acceptable to the business.]
- [NEEDS CLARIFICATION: Deposit and settlement **both** pending transfers. Is one reject meant to
  reject both (today's single folio-level axis), or should the admin be able to reject one and
  verify the other? The preferred fix assumes "reject all pending", which with no cleared money
  cancels the sale as today.]
- [NEEDS CLARIFICATION: When the reject lands after the departure has passed, should the seats be
  released immediately rather than waiting for the sweep? With the hold rules intact the sweep
  handles it within one 15-minute run, which seems sufficient.]
