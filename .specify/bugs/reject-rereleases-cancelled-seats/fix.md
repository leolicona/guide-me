# Bug Fix: Rechazar gives back seats that were already given back

- **Slug**: reject-rereleases-cancelled-seats
- **Fixed**: 2026-11-03
- **Assessment**: ./assessment.md
- **Status**: applied

## Summary

Rechazar now releases only the seats of the lines it cancels itself, and it rejects a sale once. A
sale already cancelled answers 409 `NOT_PENDING_VERIFICATION` before anything is written. Inside
the batch, every write is gated on this batch's own `transfer_rejected` row. So a Rechazar that
loses a race also changes nothing, even when the same admin taps twice in the same second.

## Changes

| File | Change | Notes |
|------|--------|-------|
| `api-turistear/src/routes/pos/handler.ts` | modified | `rejectPayment`: refuses a cancelled sale; selects only live lines; the folio update is guarded (`cancelled_at IS NULL AND payment_verification = 'pending'`); the event row is the batch's marker; lines, seat release, reversal and link closing are gated on it; a batch whose first statement matched nothing answers 409 |
| `api-turistear/src/utils/folioEvents.ts` | modified | `FolioEventInput.id` (optional): a later statement of the same batch can find the row by its id |
| `api-turistear/src/types/errors.ts` | modified | `NOT_PENDING_VERIFICATION` joins `ErrorCode`; it was already answered by Verificar and Rechazar (research defect 9) |
| `api-turistear/test/pos/reject-inventory.test.ts` | added | five cases, below |

## Diff Highlights

```ts
// The event row is written only by the batch whose first statement cancelled the sale; a second
// Rechazar by the same admin in the same second finds the sale's stamp, but also its row.
folioEventRowWhere(db, { id: eventId, type: 'transfer_rejected', … },
  sql`${cancelledHere} AND ${notRejectedBefore}`)
// Each live line's seats go back only if this batch cancelled that line.
lines: lineRows.map((l) => ({ ...l, gate: lineCancelledHere(l.id) }))
```

## Tests Added or Updated

All five cases are in `api-turistear/test/pos/reject-inventory.test.ts`.

- `gives back only the live lines: a line cancelled before keeps what another sale holds`: a two-line apartado has its first line cancelled, then is settled by a pending transfer and rejected. The first slot keeps the 4 seats another sale holds; before the fix it dropped to 2.
- `a zoned line cancelled before releases nothing again, from its zone or its slot`: the same for zones, including the slot total re-derived from the zones.
- `a second Rechazar answers 409 and changes nothing`: seats, the folio's stamps, the refund rows and the `transfer_rejected` row stay as the first Rechazar left them.
- `two Rechazar at once: one wins, the other changes nothing`: one 200 and one 409; seats drop once; one event.
- `another organization's admin gets 404 and the sale is untouched (constitution III)`: `seedTwoOrgs`.

## Local Verification

- `npx vitest run test/pos/reject-inventory.test.ts` → 5 passed.
- Against `main`'s `handler.ts`, the same suite fails 4 of 5; the isolation case passes in both.
- Mutation probes:
  - With the pre-read's `cancelledAt` check removed, all 5 still pass: the batch's own guards refuse the second Rechazar.
  - With both the pre-read check and the same-second guard (`notRejectedBefore`) removed, 2 fail: the second Rechazar and the concurrent one.
- `npx tsc --noEmit -p api-turistear`: 286 errors under `src/`, against a baseline of 288. None is new; declaring `NOT_PENDING_VERIFICATION` removed three.
- Full API suite: see the PR.

## Deviations from Assessment

- **A per-batch marker, not only the folio's stamp.** The assessment proposed gating every statement on the folio's own transition, as D11 does. D11 has a claim before its batch (the link `open` → `expired`), so its stamp is unique. Rechazar has none: the same admin rejecting twice in the same second writes the same stamp. So the batch's `transfer_rejected` row, written with a known id only by the batch that cancelled the sale, is the marker every later statement reads. This needed one optional field on `FolioEventInput`, a file the assessment did not list.
- **`ErrorCode` gains `NOT_PENDING_VERIFICATION`**, which the fix answers from a third place. It was already in use and missing (defect 9, `api-typecheck-not-gated`).

## Follow-ups

- `rejected-transfer-stays-pending` (defect 5): a rejected sale still reads `payment_verification = 'pending'`. This fix no longer depends on that, but other readers still do.
- `reject-erases-collected-money` (defect 2): Rechazar still reverses money already collected. It is a product decision, untouched here.
