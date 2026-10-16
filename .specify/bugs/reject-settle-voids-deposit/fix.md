# Bug Fix: Rejecting an apartado's settlement transfer voids the whole sale, cash deposit included

- **Slug**: reject-settle-voids-deposit
- **Fixed**: 2026-10-16
- **Assessment**: ./assessment.md
- **Status**: applied

## Summary

`rejectPayment` now withdraws only the folio's **pending** payment(s) when the sale holds other,
cleared money. The pending row is relabelled `rejected` and an offsetting reversal row, with
mirrored negative allocations, removes its money. The commission that collection accrued is
reversed. The folio becomes an apartado again, with its seats, its cleared money and its own hold
clock intact. A sale whose only money was the rejected transfer is cancelled exactly as before. The
admin's sheet, the timeline, the payment breakdown and the customer notice now say which of the two
outcomes happened.

## Changes

| File | Change | Notes |
|------|--------|-------|
| `api-turistear/src/utils/folioPayments.ts` | modified | New `buildPendingPaymentVoid`: reads the ledger and returns the statements that withdraw the pending payments (relabel, offset row, negative allocations, commission reversal capped per bucket), plus `cleared`, `voidedAmount`, `commissionReversed`, `touchedLineIds` and the verification/reference that remain. `FolioPaymentEntry.verification` gains `rejected`. |
| `api-turistear/src/routes/pos/handler.ts` | modified | `rejectPayment`: partial void when `pendingCount > 0 && cleared > 0` (folio scalars, `settled_at` cleared when a live line owes again, `transfer_rejected` event with `outcome: 'booking'`, `payment_rejected_booking` notice). The full path is unchanged apart from relabelling its pending rows `rejected`. |
| `api-turistear/src/db/schema.ts` | modified | `folio_payments.verification` enum gains `rejected`. TEXT with no CHECK constraint (migration 0049), so no migration is needed. |
| `api-turistear/src/utils/notifications.ts` | modified | New action-tail event `payment_rejected_booking` with its shipped template: the payment was not applied and the apartado continues. |
| `api-turistear/test/pos/reject-settlement.test.ts` | added test | Six API tests (below). |
| `app-turistear/src/features/folios/components/FolioWorkActions.tsx` | modified | The reject sheet mirrors the outcome for its copy only: «Se anula solo este pago…» and **Rechazar solo este pago** when cleared money exists; otherwise the old copy and **Rechazar venta**. |
| `app-turistear/src/features/folios/components/FolioTimeline.tsx` | modified | `transfer_rejected` with `outcome: 'booking'` reads «Transferencia rechazada — sigue como apartado». |
| `app-turistear/src/features/pos/components/PaymentBreakdown.tsx` | modified | A `rejected` row shows a «Rechazado» chip (never «Por verificar»). |
| `app-turistear/src/features/pos/types.ts` | modified | `FolioPaymentEntry.verification` accepts `rejected`. |
| `app-turistear/src/pages/OutboxPage.tsx` | modified | Label for `payment_rejected_booking`. |
| `app-turistear/src/features/folios/components/FolioWorkActions.test.tsx` | updated test | Two sheet-copy cases. |
| `app-turistear/src/features/folios/components/FolioTimeline.test.tsx` | updated test | Both `transfer_rejected` readings. |
| `app-turistear/src/features/pos/components/PaymentBreakdown.test.tsx` | added test | Rejected chip, reversal row, `expectNoA11yViolations`. |

## Diff Highlights

```ts
// rejectPayment — the branch that did not exist
const voidPlan = await buildPendingPaymentVoid(db, { organizationId: org, folioId: id, at: now })
if (voidPlan.pendingCount > 0 && voidPlan.cleared > 0) {
  await db.batch([
    db.update(folios).set({
      amountPaid: Math.max(0, folio.amountPaid - voidPlan.voidedAmount),
      commissionAmount: Math.max(0, folio.commissionAmount - voidPlan.commissionReversed),
      ...(reopensLiveLine ? { settledAt: null, settledBy: null } : {}),
      paymentVerification: voidPlan.remainingVerification,
      paymentReference: voidPlan.remainingReference,
      updatedAt: now,
    }) /* … */,
    ...voidPlan.statements,
    folioEventRow(db, { type: 'transfer_rejected', payload: { reference, reason, outcome: 'booking', amount } /* … */ }),
  ])
  // … payment_rejected_booking, return { folio }
}
// otherwise: today's cancellation, unchanged
```

Per pending row, `buildPendingPaymentVoid` writes:
`UPDATE folio_payments SET verification = 'rejected'`, then a `refund` row for the same amount,
method and collector, then `allocationRows(…, sign: -1)` mirroring that row's own allocations.

## Tests Added or Updated

- `api-turistear/test/pos/reject-settlement.test.ts`
  - `cash deposit + transfer settle + reject → an apartado again, deposit and seats intact` pins:
    - status `booking`, `amount_paid` = deposit, no QR, `booking_expires_at` unchanged, seat still
      booked;
    - the seller's `cash_collected` still 450.00;
    - commission 45.00 in both the scalar and the ledger;
    - the ledger reconciles: Σ money rows = Σ allocations = deposit;
    - the transfer row reads `rejected`, with a −1,050.00 reversal beside it;
    - `payment_rejected_booking` is sent and `payment_rejected` is not;
    - the folio is out of the `?verification=pending` queue.
  - `after the reject the apartado settles again in cash → paid with its ticket` — the apartado is
    fully usable again (QR issued, commission 150.00, `cash_collected` 1,500.00).
  - `the apartado rules take it from there: a lapsed hold is due to the sweep again` — while the
    sale reads paid, the sweep ignores it. After the reject, it enters stage ② (the outbox has
    `booking_grace_entered`) and keeps its seat.
  - `per-line: a cash-settled line keeps its ticket; only the transfer line owes again` — the
    sibling's QR token is unchanged, both seats are held, and money, commission and cash are back to
    their pre-transfer values.
  - `transfer deposit + transfer settle, both pending → cancelled, seats released` — with no cleared
    money the old outcome stands, and both rows now read `rejected`.
  - `an admin of org B cannot reject org A's settlement → 404, folio untouched` — `seedTwoOrgs`
    (constitution III).
- `app-turistear/src/features/folios/components/FolioWorkActions.test.tsx` — the sheet says «Se
  anula solo este pago» / **Rechazar solo este pago** when cleared money exists, and keeps «La venta
  se cancelará» / **Rechazar venta** when it does not.
- `app-turistear/src/features/folios/components/FolioTimeline.test.tsx` — both readings of
  `transfer_rejected`.
- `app-turistear/src/features/pos/components/PaymentBreakdown.test.tsx` — the «Rechazado» chip, no
  «Por verificar», «Reversa · Transferencia», and no a11y violations.

## Local Verification

- **Bug reproduced first:** with `handler.ts` swapped back to `HEAD`, `npx vitest run
  test/pos/reject-settlement.test.ts` → **5 failed / 1 passed**. Only the cross-org test passes,
  since it holds either way. With the fix → **6 passed**.
- `pnpm test:api` (`vitest run`, workerd + local D1) → **80 files, 1014 tests passed**. The
  scope-boundary suites named by spec 006/007 (`payment-verification`, `optional-payment-reference`,
  `paid-ledger/settle-method`, `pos-bookings-sweep`) pass unedited.
- `pnpm test:app` → **57 files, 805 tests passed**.
- `pnpm lint:app` → **0 errors**. The 6 pre-existing warnings are in files this fix does not touch.
- `pnpm build:app` (runs `tsc -b`) and `pnpm build:api` → both build.
- `node --test '.github/scripts/*.test.mjs'` → pass.
- `npx tsc --noEmit` on the API reports the repository's pre-existing errors (`c.req.param()` typed
  `string | undefined`, codes missing from `ErrorCode`, across many untouched files). The new code
  adds only instances of those same classes, in the lines it shares with the existing handler. CI
  does not typecheck the API.

## Deviations from Assessment

- **How the reversed commission is found.** The assessment leaned toward recomputing the
  deposit-state commission from the snapshot. I did not, for two reasons:
  - The deposit's commission is prorated **folio-wide** in `confirmSale`
    (`round(fullPercent × deposit / total)`), while the allocations cascade **per line**.
  - With lines at different rates, a per-line recompute does not land back on the number the deposit
    booked.

  Instead the fix reverses exactly what the rejected collection's own action wrote. A settle writes
  its commission row in the payment's batch, on the payment's method, so "same method, written at or
  after the payment" identifies that accrual. Each (method, collector) reversal is capped at what
  the bucket still holds, so an earlier clawback is never reversed twice. The cash-deposit and
  per-line tests pin the exact pre-transfer figures.
- **`rejected` is applied in the full path too** (scope expansion). The assessment proposed the label
  for the partial path. I applied it in both because the ticket page (`linePending`) and the payment
  breakdown read the **row**, and a rejected row left `pending` is the "pending forever" record spec
  006 measured (66 days). This is one statement, with no money effect.
- **The notice is named for its outcome, not "settlement".** The new event is
  `payment_rejected_booking`, because the rejected payment can also be a deposit whose balance was
  paid in cash (assessment Open Question 1).
- **The sweep test asserts the grace stage, not a release.** The returned apartado is three days
  from departure, so its release instant is ahead. The test therefore proves that it re-enters the
  apartado rules (stage ②, outbox row, seat held). It does not prove a release, which is the sweep's
  own suite's job.
- **Open Question 1 follows the rule but is not pinned.** A transfer deposit pending under a cash
  balance becomes an apartado owing the deposit amount. This follows the preferred rule ("void only
  the rejected payment"), but no test fixes it in place until the business confirms it.

## Follow-ups

- **Confirm Open Questions 1 and 2 of the assessment with the business.** Question 2: one reject
  currently rejects **all** pending payments of a sale.
- **Pre-existing: there is still no guard on Rechazar** (spec 006, "defect 3"). On the cancel path
  the folio keeps its stale `payment_verification = 'pending'`, so a second Rechazar runs the full
  path again and releases the seats twice. The partial path is no worse, but the guard belongs in a
  fix of its own.
- **Pre-existing: the cancel path releases seats for every line, including lines already
  cancelled.** That happens when the sweep lapsed a line while its deposit was pending, and it
  releases those seats twice.
- **A second partial rejection on the same sale does not re-notify** the customer. The outbox's
  unique `(folio, event, channel)` index swallows it. This is rare, and is the same rule every other
  event follows.
- **A line paid in cash while a sibling's transfer was pending got no QR** (`cleared` was false). It
  gets one when the rest is settled through `settleBooking`, but not through a per-line settle. This
  is pre-existing and only made reachable by the sale now surviving.
- **Spec 007 (transfer verification deadline) can reuse `buildPendingPaymentVoid`** for its
  settlement outcome (FR-007).
- **The grace-stage email still asks the customer to settle** while settling is refused past the
  hold. This was flagged earlier in the conversation and is unrelated to this fix.
