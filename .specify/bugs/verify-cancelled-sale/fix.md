# Bug Fix: Verificar succeeds on a sale that was already cancelled

- **Slug**: verify-cancelled-sale
- **Fixed**: 2026-11-03
- **Assessment**: ./assessment.md
- **Status**: applied

## Summary

Verificar now refuses a cancelled sale with 409 `NOT_PENDING_VERIFICATION` and changes nothing:
no row flips, no `payment_verified` event, no message to the customer. The shared core is called
with `refuseCancelled`, so a cancellation that lands between the read and the batch verifies
nothing either, and that case answers the same 409.

## Changes

| File | Change | Notes |
|------|--------|-------|
| `api-turistear/src/routes/pos/handler.ts` | modified | `verifyPayment`: reads `cancelled_at` and refuses a cancelled sale; passes `refuseCancelled: true` to `verifyFolioPayment`; when nothing flipped and the sale is now cancelled, answers 409 |
| `api-turistear/src/types/errors.ts` | modified | `NOT_PENDING_VERIFICATION` joins `ErrorCode`, with the same two lines as `reject-rereleases-cancelled-seats`, so the two branches merge cleanly in either order |
| `api-turistear/test/pos/verify-cancelled.test.ts` | added | four cases, below |

## Tests Added or Updated

All four cases are in `api-turistear/test/pos/verify-cancelled.test.ts`.

- `after Rechazar: 409, and the payment stays as Rechazar left it`: the folio's and the rows' verification, the `payment_verified` events and the `payment_verified` messages are unchanged.
- `after the sweep released an apartado whose transfer deposit nobody verified: 409`.
- `a live sale is still verified, once`: the normal path, and a second Verificar answers 409.
- `another organization's admin gets 404 and the sale is untouched (constitution III)`: `seedTwoOrgs`.

## Local Verification

- `npx vitest run test/pos/verify-cancelled.test.ts` → 4 passed.
- Against `main`'s `handler.ts`, the same suite fails 2 of 4 (the two cancelled cases).
- Mutation probes:
  - With the pre-read's `cancelledAt` check removed, all 4 still pass: `refuseCancelled` and the 409 after the batch hold by themselves.
  - With both the pre-read check and `refuseCancelled` removed, the two cancelled cases fail.
- `npx tsc --noEmit -p api-turistear`: 286 errors under `src/`, against a baseline of 288; none new.
- Full API suite: see the PR.

## Deviations from Assessment

- The assessment proposed the pre-read check plus `refuseCancelled`. With `refuseCancelled` alone, a cancellation landing mid-request would answer 200 with nothing verified. So when nothing flipped, the handler re-reads the sale and answers 409 if it is cancelled. A concurrent second Verificar on a live sale still answers as before.
- The open question (reuse `NOT_PENDING_VERIFICATION` or add a code) was settled by reuse. Rechazar answers the same code for the same state, and the app hides Verificar on a cancelled sale, so the code needs no new copy.

## Follow-ups

- `rejected-transfer-stays-pending` (defect 5): with it fixed, a cancelled sale stops reading `pending`, and this check becomes a second line of defence.
- The app already hides Verificar on a cancelled sale (`FolioWorkActions.tsx:146`, `FolioDetailScreen.tsx:140`). The 409 covers a screen loaded before the cancellation and a direct call. The detail's «Por verificar» chip still shows on such a sale (`FolioDetailScreen.tsx:365`), which is defect 5's to fix.
