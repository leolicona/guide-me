# Bug Verification: Verificar succeeds on a sale that was already cancelled

- **Slug**: verify-cancelled-sale
- **Tested**: 2026-11-03
- **Assessment**: ./assessment.md
- **Fix**: ./fix.md
- **Result**: verified

## Summary

The assessment's reproduction, Rechazar then Verificar, verifies the payment and queues a message
on `main`. With the fix it answers 409 and changes nothing. The sweep's case behaves the same. The
full API suite passes, and the type-check has no new errors.

## Checks Performed

| Check | Command / Action | Result | Notes |
|-------|------------------|--------|-------|
| Reproduction (pre-fix) | `vitest run test/pos/verify-cancelled.test.ts` against `main`'s `handler.ts` | fail (as expected) | 2 of 4 fail: after Rechazar, and after the sweep, Verificar answers 200 and flips the rows |
| Reproduction (post-fix) | same suite with the fix | pass | assessment steps 1-4 through the HTTP routes: sell by transfer, Rechazar, Verificar → 409; rows, events and messages unchanged |
| New / updated tests | `npx vitest run test/pos/verify-cancelled.test.ts` | pass | 4 tests |
| Batch guard alone | mutation: pre-read `cancelledAt` check removed | pass | `refuseCancelled` plus the 409 after the batch hold |
| Both guards removed | mutation: pre-read check and `refuseCancelled` removed | fail (as expected) | the two cancelled cases fail |
| Regression suite | `npx vitest run` (api-turistear) | pass | 94 files, 1246 tests |
| Type-check | `npx tsc --noEmit -p api-turistear` | pass | 286 errors under `src/`, against a baseline of 288; none new |

## Output Excerpts

```
pre-fix:   Tests  2 failed | 2 passed (4)
post-fix:  Tests  4 passed (4)
full:      Test Files  94 passed (94)   Tests  1246 passed (1246)
```

## Residual Risks

- A sale verified after its cancellation before this fix keeps its `verified` rows and its sent message. No data is repaired.
- The re-read after a batch that flipped nothing costs one query, only on that rare path.

## Recommendation

Close the bug: verified through the HTTP routes, with the symptom reproduced first.
