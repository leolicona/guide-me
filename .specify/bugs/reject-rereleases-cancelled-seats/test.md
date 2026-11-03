# Bug Verification: Rechazar gives back seats that were already given back

- **Slug**: reject-rereleases-cancelled-seats
- **Tested**: 2026-11-03
- **Assessment**: ./assessment.md
- **Fix**: ./fix.md
- **Result**: verified

## Summary

The symptom reproduces on `main` and not with the fix. A line cancelled before Rechazar keeps
another sale's seats held, and a second Rechazar changes nothing. The full API suite passes, and
the type-check has no new errors.

## Checks Performed

| Check | Command / Action | Result | Notes |
|-------|------------------|--------|-------|
| Reproduction (pre-fix) | `vitest run test/pos/reject-inventory.test.ts` against `main`'s `handler.ts` | fail (as expected) | 4 of 5 fail: the cancelled line's seats are released again (4 → 2), a second Rechazar answers 200, and seats drop twice. The isolation case passes on both |
| Reproduction (post-fix) | same suite with the fix | pass | 5 of 5, through the real HTTP routes in workerd |
| New / updated tests | `npx vitest run test/pos/reject-inventory.test.ts` | pass | 5 tests |
| Batch guards alone | mutation: pre-read `cancelledAt` check removed | pass | the batch refuses the second Rechazar by itself |
| Same-second guard | mutation: pre-read check and `notRejectedBefore` both removed | fail (as expected) | 2 fail: the second and the concurrent Rechazar double the event and the release |
| Regression suite | `npx vitest run` (api-turistear) | pass | 94 files, 1247 tests |
| Type-check | `npx tsc --noEmit -p api-turistear` | pass | 286 errors under `src/`, against a baseline of 288; none new |

## Output Excerpts

```
pre-fix:   Tests  4 failed | 1 passed (5)
post-fix:  Tests  5 passed (5)
full:      Test Files  94 passed (94)   Tests  1247 passed (1247)
```

The full run also prints workerd «uncaught exception … internal error» lines. They come from
suites that already exist on `main` (for example `test/pos/payment-verification.test.ts`), not from
this suite, and match `tests-reach-resend` (research defect 10).

## Residual Risks

- The assessment's step 2 (cancel a line while the transfer is pending) is refused today with `PAYMENT_UNVERIFIED`. The real path is the one tested: cancel the line first, then settle the rest by a transfer that is still pending. A line the apartado sweep cancels while a transfer deposit is pending (`sweep-expires-pending-deposit`) reaches the same code, and it is covered by the same gate.
- The concurrent test does not force the same-second race: in the test runtime, the second request is refused at the pre-read. The mutation probe above is the evidence for the batch's own guard.
- A sale already rejected twice before this fix keeps both events and its counters as they are. No data is repaired.

## Recommendation

Close the bug: verified through the HTTP routes, with the symptom reproduced first.
