# Bug Verification: Rejecting an apartado's settlement transfer voids the whole sale, cash deposit included

- **Slug**: reject-settle-voids-deposit
- **Tested**: 2026-10-16
- **Assessment**: ./assessment.md
- **Fix**: ./fix.md
- **Result**: verified

## Summary

The bug no longer reproduces. I ran the assessment's three reproduction steps by hand against the
API on `pnpm dev:api`, with a seeded local D1 and a real email-code sign-in:
1. an apartado with a cash deposit;
2. its balance settled by transfer;
3. an admin's Rechazar.

The sale stays an apartado with its deposit, its seat and its hold clock. The seller's cash is
untouched, and the rejected transfer is labelled with its reversal beside it. The fix's tests,
the four scope-boundary suites and both full suites pass, and so do lint and both builds. No
regressions.

## Checks Performed

| Check | Command / Action | Result | Notes |
|-------|------------------|--------|-------|
| Reproduction (post-fix), by hand | `scratchpad/repro.sh <slot>` against `pnpm dev:api`. It runs `POST /api/pos/folios` (360.00 cash deposit of 1,200.00), then `POST …/settle {method: transfer}`, then `POST …/reject` | pass | Before the reject: `paid` + `pending`. After: `booking`, `amount_paid` 36000, `payment_verification` `not_required`, `booking_expires_at` unchanged, no QR. Slot `booked` stays 1, `cash_collected` stays 36000, the folio is out of Por verificar, and the outbox has `payment_rejected_booking` (not `payment_rejected`). |
| Reproduction (pre-fix) | Recorded in `fix.md`: the same steps as `test/pos/reject-settlement.test.ts`, with `handler.ts` swapped back to `HEAD` | fail (as expected) | 5 of 6 failed on the old code. The bug is real and the tests catch it. Not re-run here, because this command does not modify source. |
| New API tests | `npx vitest run test/pos/reject-settlement.test.ts` | pass | 6/6. Covers the deposit-keeps-sale case, settling again, the sweep picking it up again, a per-line sibling keeping its QR, the no-cleared-money cancel, and cross-org 404. |
| Updated / new app tests | `npx vitest run` on `FolioWorkActions`, `FolioTimeline`, `PaymentBreakdown` tests | pass | 3 files, 51 tests, including the axe check on `PaymentBreakdown`. |
| Scope-boundary suites (specs 006/007) | `npx vitest run test/pos/payment-verification.test.ts test/pos/optional-payment-reference.test.ts test/paid-ledger/settle-method.test.ts test/pos/pos-bookings-sweep.test.ts` | pass | 4 files, 37 tests, unedited. |
| API regression suite | `npx vitest run` (api-turistear, workerd + real local D1) | pass | 80 files, 1014 tests. |
| App regression suite | `pnpm test:app` | pass | 57 files, 805 tests. |
| Lint | `pnpm lint:app` | pass | 0 errors. The 6 warnings are pre-existing, in files this fix does not touch. |
| Type-check / build | `pnpm build:app` (`tsc -b`), `pnpm build:api` | pass | Both build, with 0 `error TS` in the app build. The API has no typecheck in CI; its pre-existing `tsc` errors are noted in `fix.md`. |
| Pipeline scripts | `node --test '.github/scripts/*.test.mjs'` | pass | 14 pass, 0 fail. |

## Output Excerpts

Manual reproduction against the local API:

```
== 1. apartado: 360.00 en efectivo de 1,200.00
folio=93fe80c7 status=booking amount_paid=36000 booking_expires_at=1793451600
slot booked=1  cash_collected=36000
== 2. liquidar el saldo (840.00) por transferencia
status=paid payment_verification=pending amount_paid=120000
== 3. el admin rechaza la transferencia
status=booking amount_paid=36000 payment_verification=not_required booking_expires_at=1793451600 qr=null
  payment cash 36000 not_required
  payment transfer 84000 rejected ref BBVA-REPRO-1
  refund transfer -84000 not_required
slot booked=1  cash_collected=36000
en Por verificar: false
outbox: booking_created/email, booking_created/whatsapp, payment_rejected_booking/email, payment_rejected_booking/whatsapp
```

Suites:

```
reject-settlement.test.ts      Tests  6 passed (6)
scope-boundary suites          Test Files  4 passed (4)   Tests  37 passed (37)
api-turistear (full)           Test Files  80 passed (80) Tests  1014 passed (1014)
app-turistear (full)           Test Files  57 passed (57) Tests  805 passed (805)
lint:app                       ✖ 6 problems (0 errors, 6 warnings)
```

## Residual Risks

- **Commission was not exercised by hand.** The seeded local services carry 0% commission. The
  commission reversal (back to the deposit's 45.00) is proven by the API tests only, at 10%.
- **Local only.** The reproduction ran on a local D1 replica, not on dev or a PR preview. A preview
  deploy would exercise the same Worker code against dev's data.
- **Assessment Open Questions 1 and 2 are not confirmed by the business**:
  - a rejected transfer *deposit* under a cash balance → an apartado owing the deposit;
  - one Rechazar rejects every pending payment of the sale.

  The behaviour follows the rule ("void only the pending money"), but no test pins Question 1 yet.
- **Out of scope, pre-existing (see `fix.md` Follow-ups):**
  - no concurrency guard on Rechazar, and a cancelled folio keeps its stale `pending` flag, so a
    double tap on the cancel path releases the seats twice;
  - the cancel path also releases seats of lines that were already cancelled;
  - a second partial rejection is not re-notified (the outbox's unique index).
- **The new notice's email row is written but nothing sends it.** The `payment_rejected_booking`
  email row stays `pending`, exactly as `payment_rejected`'s already does. The WhatsApp row, the
  one the seller drains, is the channel that reaches the customer today.

## Recommendation

Close the bug — verified end-to-end. The assessment's reproduction was exercised by hand against
the running API and no longer reproduces, and the fix is pinned by tests at the layer that enforces
it (constitution VI). Before it ships, the business should confirm Open Questions 1 and 2, and the
pre-existing Rechazar defects should be recorded on their own lite path or debt entry. Spec 007 (the
24-hour verification deadline) can now build on `buildPendingPaymentVoid`.
