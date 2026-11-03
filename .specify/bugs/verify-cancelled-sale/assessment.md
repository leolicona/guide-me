# Bug Assessment: Verificar succeeds on a sale that was already cancelled

- **Slug**: verify-cancelled-sale
- **Created**: 2026-11-03
- **Source**: pasted text — `specs/006-devolada-transfer-verification/research.md:625`, § Defects found on the way, defect 1 (T077)
- **Verdict**: valid
- **Severity**: medium

## Report (verbatim or summarized)

> 1. `verifyPayment` succeeds on a rejected or swept sale (no `cancelled_at` check). `routes/pos/handler.ts:2779-2803`.

The line reference predates PRs 1–3 of the Devolada feature; it is re-located below on `main` 6bd538e.

## Symptom

`POST /pos/folios/:id/verify` verifies the transfer of a sale that Rechazar or the apartado sweep already cancelled, and queues a «pago verificado» message to its customer. Expected: a cancelled sale is never verified; the call answers 409 and changes nothing.

## Reproduction

1. Sell by transfer with a reference, so `payment_verification = 'pending'`.
2. Tap Rechazar (`POST /pos/folios/:id/reject`). The sale is cancelled, but its verification stays `pending` (defect `rejected-transfer-stays-pending`).
3. Call `POST /pos/folios/:id/verify` as the admin.
4. Observed: 200, the rows flip to `verified`, a `payment_verified` event is written, and a `payment_verified` notification is queued (WhatsApp row `pending`, email if there is an address).

## Suspected Code Paths

- `api-turistear/src/routes/pos/handler.ts:2412-2479` (`verifyPayment`) — reads `paymentVerification` only (line 2431); never reads `cancelled_at`.
- `api-turistear/src/routes/pos/handler.ts:2441` — calls `verifyFolioPayment` without `refuseCancelled`.
- `api-turistear/src/routes/pos/verifyCore.ts:35-36, 63, 81, 98` — the guard exists (`refuseCancelled`, added by this feature for Devolada's verdict, D9); only the admin's path leaves it off.
- `api-turistear/src/routes/pos/handler.ts:2455-2465` — the notification is emitted for the not-`paid` branch, which a cancelled sale takes.

## Root Cause Hypothesis

`verifyPayment` predates the cancellation paths that leave `payment_verification = 'pending'` behind (Rechazar, the sweep), and its only precondition is that column. The Devolada feature added `refuseCancelled` to the shared core for its own verdicts (D9, D10) but kept the admin's call unchanged, as research § Defects recorded. Confidence: high.

## Proposed Remediation

**Preferred**: In `verifyPayment`, select `cancelledAt` with the folio and refuse a cancelled sale with 409 (an existing code such as `CONFLICT`, or a new `SALE_CANCELLED`, added to `ErrorCode`). Also pass `refuseCancelled: true` to `verifyFolioPayment`, so a cancellation that lands between the read and the batch still changes nothing (constitution V).

**Alternatives**:
- Fix `rejected-transfer-stays-pending` first, so a cancelled sale never reads `pending`. That closes this path too, but not for rows written before the fix; the explicit guard is still needed.

**Files likely to change**:
- `api-turistear/src/routes/pos/handler.ts`
- `api-turistear/src/types/errors.ts` (only if a new code is added)
- `api-turistear/test/pos/payment-verification.test.ts` is a scope-boundary file for the Devolada feature; put the new cases in a new suite, e.g. `api-turistear/test/pos/verify-cancelled.test.ts`.

**Tests to add or update**:
- Verificar after Rechazar → 409; rows still `pending`; no event; no notification row.
- Verificar after the sweep cancelled an apartado with a pending transfer deposit → 409.
- Cross-org: another organization's id → 404 (`seedTwoOrgs`).

## Risks & Considerations

- The app may offer Verificar on a cancelled sale's detail; check that it hides it, so the new 409 is never the normal path.
- No migration.

## Open Questions

- [NEEDS CLARIFICATION: should the 409 reuse `NOT_PENDING_VERIFICATION`, which the app already maps to copy, or get its own code and copy?]
