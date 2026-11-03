# Bug Assessment: Rechazar gives back seats that were already given back

- **Slug**: reject-rereleases-cancelled-seats
- **Created**: 2026-11-03
- **Source**: pasted text — `specs/006-devolada-transfer-verification/research.md:627`, § Defects found on the way, defect 3 (T077)
- **Verdict**: valid
- **Severity**: high

## Report (verbatim or summarized)

> 3. `rejectPayment` releases seats for lines already cancelled and has no not-cancelled guard. `routes/pos/handler.ts:3015-3089`.

Re-located on `main` 6bd538e below.

## Symptom

Rechazar subtracts every line's quantity from its slot or zone, including lines that a line cancellation already released, and it runs again on a sale that is already cancelled (its verification stays `pending`). Each extra release lowers `booked` below the seats really sold, so the slot accepts more sales than its capacity. Expected: only live lines release, once.

## Reproduction

1. Sell two lines on one slot by transfer with a reference (`payment_verification = 'pending'`).
2. Cancel one line (`POST /folios/:id/lines/:lineId/cancel`): its seats are released.
3. Rechazar the sale.
4. Observed: the cancelled line's quantity is subtracted again (clamped at zero only by `MAX(0, …)`).
5. Second path: Rechazar the same sale again (it still reads `pending`, defect `rejected-transfer-stays-pending`); every line's seats are subtracted a third time, and `cancelled_at`, `cancelled_by` and the reason are overwritten.

## Suspected Code Paths

- `api-turistear/src/routes/pos/handler.ts:2504-2511` — `lineRows` selects every line, with no `cancelled_at is null`.
- `api-turistear/src/routes/pos/handler.ts:2556` — passes them all to `buildInventoryReleaseStatements` (`api-turistear/src/routes/pos/unreceivedTransfer.ts:47-98`), whose doc comment already names this defect.
- `api-turistear/src/routes/pos/handler.ts:2515-2526` — the folio update has no `cancelled_at is null` guard, and nothing in the batch is gated on it (constitution V).

## Root Cause Hypothesis

Rechazar predates line autonomy (per-line cancellation) and guarded cancellation (`applyCancellation`'s gate). The Devolada feature extracted its release into `buildInventoryReleaseStatements` and gave D11 a per-line gate, but kept Rechazar's input unchanged on purpose. Confidence: high.

## Proposed Remediation

**Preferred**: Select only live lines, and gate the whole batch on the folio's own transition: the folio update matches `cancelled_at IS NULL`, and every release statement carries `gate` on that same condition (as D11 does through `buildInventoryReleaseStatements`' `gate`). A second Rechazar then changes nothing and answers 409.

**Alternatives**:
- Route Rechazar through `applyCancellation` with a "rejected" source. Larger change, but one cancellation path.

**Files likely to change**:
- `api-turistear/src/routes/pos/handler.ts` (`rejectPayment`)
- a new suite, e.g. `api-turistear/test/pos/reject-inventory.test.ts`

**Tests to add or update**:
- Line cancelled, then Rechazar → the slot's `booked` drops only by the live line's quantity.
- Rechazar twice → the second answers 409; `booked` and `cancelled_at` unchanged.
- Zoned slot: the zone counter and the reconciled slot totals.

## Risks & Considerations

- Capacity is guarded by the database (constitution V); every case asserts counters, not only HTTP status.
- Fixing `rejected-transfer-stays-pending` also stops the double Rechazar, but not the cancelled-line case.

## Open Questions

- None.
