# Bug Assessment: Rechazar reverses money that was collected, and owes nobody a refund

- **Slug**: reject-erases-collected-money
- **Created**: 2026-11-03
- **Source**: pasted text — `specs/006-devolada-transfer-verification/research.md:626`, § Defects found on the way, defect 2 (T077)
- **Verdict**: valid
- **Severity**: high

## Report (verbatim or summarized)

> 2. `rejectPayment` erases a cash or verified deposit with no refund owed. `routes/pos/handler.ts:3104-3112`.

Re-located on `main` 6bd538e below.

## Symptom

On an apartado whose deposit was paid in cash (or by a transfer already verified) and whose settlement is a pending transfer, Rechazar cancels the whole sale and reverses every collected peso out of the ledger, the cash deposit included, while every line keeps `refund_status = 'none'`. The cash is still in the seller's drawer, but no corte asks for it and no refund is owed to the customer. Expected: Rechazar voids only the money it rejects; money already collected stays in the books, or becomes a refund the admin owes (cancellation ladder), never nothing.

## Reproduction

1. With an organization not connected to Devolada, create an apartado with a cash deposit.
2. Settle it by transfer with a reference: `payment_verification = 'pending'`.
3. Rechazar it (`POST /pos/folios/:id/reject`).
4. Observed: the folio is cancelled, `buildCancellationReversal` writes refund rows for the cash bucket too, and the lines' `refund_status` stays `none`, so the derived `refund_status` reads `none`.

## Suspected Code Paths

- `api-turistear/src/routes/pos/handler.ts:2482-2600` (`rejectPayment`).
- `api-turistear/src/routes/pos/handler.ts:2561-2569` — `buildCancellationReversal` without `refundAmount`, which reverses every positive bucket in full (`api-turistear/src/utils/folioPayments.ts:240-300`).
- `api-turistear/src/routes/pos/handler.ts:2527-2539` — the lines' update sets `cancelledAt`, `cancelledBy` and `cancellationSource` only; `refund_status` stays `none` (`api-turistear/src/db/schema.ts:574`; derived by `deriveRefundStatusSql`, `api-turistear/src/utils/folioStatus.ts:75`).

## Root Cause Hypothesis

US-A67 wrote Rechazar for a full sale paid by one transfer, where "nothing was collected" holds. Mixed folios (a cash or verified deposit, then a pending transfer settlement) came later with apartados and per-movement payments, and Rechazar still treats every bucket as never received. Confidence: high.

## Proposed Remediation

**Preferred**: Reverse only the rows Rechazar rejects. Pass `buildCancellationReversal` the pending rows' amount (`refundAmount` = Σ pending transfer payments), so the verified and cash buckets stay live. Then decide what the customer is owed for that kept money through the same ladder every cancellation uses (`cancelFolioPriced`, D20), so a refund or a credit is recorded, or the money is retained as the ladder says.

**Alternatives**:
- Refuse Rechazar on a sale that holds verified or cash money (409), and make the admin cancel it through the priced path once the transfer is decided. Simpler, but leaves the admin with two steps for one decision.

**Files likely to change**:
- `api-turistear/src/routes/pos/handler.ts` (`rejectPayment`)
- `api-turistear/src/utils/folioPayments.ts` (possibly a "pending only" reversal helper)
- a new suite, e.g. `api-turistear/test/pos/reject-mixed-money.test.ts`

**Tests to add or update**:
- Cash deposit + pending transfer settlement → Rechazar: the cash bucket's net stays; the refund obligation follows the ladder; the paid-ledger reconciliation suite stays green.
- Verified transfer deposit + pending transfer settlement → same.
- Full sale, one pending transfer → unchanged behaviour (`refund_status 'none'`).

## Risks & Considerations

- Money law (constitution II): every case needs a ledger reconciliation assertion.
- D11 (automatic cancellation when a transfer never arrives) shares `buildCancellationReversal` and the inventory builder; keep its behaviour unchanged or fix both together.
- `test/folios/cancel-unverified-guard.test.ts` asserts `refund_status: 'none'` after Rechazar on a deposit; it may need to change with the decision.

## Open Questions

- [NEEDS CLARIFICATION: when Rechazar voids the settlement, should the apartado survive on its deposit (only the settlement is rejected), or is the sale cancelled with the kept money priced by the ladder?]
