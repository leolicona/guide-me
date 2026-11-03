# Bug Assessment: The apartado sweep cancels on an unverified deposit and credits money never received

- **Slug**: sweep-expires-pending-deposit
- **Created**: 2026-11-03
- **Source**: pasted text — `specs/006-devolada-transfer-verification/research.md:628`, § Defects found on the way, defect 4 (T077)
- **Verdict**: valid
- **Severity**: high

## Report (verbatim or summarized)

> 4. `sweepExpiredBookings` cancels apartados whose transfer deposit is still pending, and credits money that was never received. `routes/pos/sweep.ts:146-158`; asserted as current behaviour at `test:folios/cancel-unverified-guard.test.ts:184-209`. This feature keeps the sweep away from every deposit a link collects: it skips an apartado whose deposit, collected by a link, is not verified yet, whatever happened to the link (D8).

## Symptom

An apartado whose deposit was a manual transfer (an organization without Devolada, or a deposit with no link) and is still unverified expires like any other: the sweep cancels it and prices it with `amount_paid`, which counts the unverified transfer, so the customer can be granted credit for money that may never have arrived. Expected: money nobody has verified is never credited; either the sweep holds the apartado until Verificar or Rechazar decides it, or it cancels without crediting the pending amount.

## Reproduction

1. With an organization not connected to Devolada, create an apartado with a transfer deposit and a reference (`payment_verification = 'pending'`).
2. Let its line's clock pass (`booking_expires_at` in the past) and run `sweepExpiredBookings`.
3. Observed: the apartado is cancelled (asserted today by `api-turistear/test/folios/cancel-unverified-guard.test.ts:184`), and `cancelFolioLinesPriced` runs with `creditInsteadOfRefund`.
4. [NEEDS CLARIFICATION: confirm the credit amount on an organization whose ladder does not retain 100% at the terminal tier; on the inherited default the credit is zero (US-A76), so the money symptom needs a configured ladder.]

## Suspected Code Paths

- `api-turistear/src/routes/pos/sweep.ts:51-72` (`dueApartadosQuery`) — holds only what `apartadoHeldSql` / `lineHeldSql` hold: deposits a Devolada link collects (`api-turistear/src/utils/devoladaSql.ts:74-93`, D8). A manual pending deposit is not held.
- `api-turistear/src/routes/pos/sweep.ts:175-187` — `cancelFolioLinesPriced(..., { creditInsteadOfRefund })`.
- `api-turistear/src/routes/folios/handler.ts:926-935` — BUG-030 refuses the admin's cancel while the payment is pending precisely because the ladder prices the unconfirmed transfer; the comment notes the sweep was left untouched.

## Root Cause Hypothesis

BUG-030 closed the admin's entrance but deliberately left the sweep, so "seats do not wait on money". The seats part is a product choice; the credit part prices money that is not verified. The Devolada feature holds link-collected deposits (D8) but not manual ones. Confidence: high for the cancellation, medium for the credit amount (depends on the ladder).

## Proposed Remediation

**Preferred**: Keep releasing the seats, but price the sweep's cancellation without the unverified money: pass the ladder only verified and cash payments, and leave the pending transfer to Verificar or Rechazar (which then decides it on a cancelled sale — see `verify-cancelled-sale`). Update the test that asserts today's behaviour.

**Alternatives**:
- Hold a manual pending deposit like a link-collected one (extend `apartadoHeldSql`). Simpler and consistent with D8, but seats then wait on an admin who may never act.

**Files likely to change**:
- `api-turistear/src/routes/pos/sweep.ts`
- `api-turistear/src/routes/folios/handler.ts` (`cancelFolioLinesPriced` input)
- `api-turistear/test/folios/cancel-unverified-guard.test.ts`

**Tests to add or update**:
- Manual pending deposit, ladder retaining 50% at the terminal tier → sweep cancels; credit computed on verified money only.
- Cash deposit → unchanged.
- Link-collected pending deposit → still held (D8, `test/devolada/apartados.test.ts`).

## Risks & Considerations

- Money law: assert the ledger and the credit rows.
- Interacts with `verify-cancelled-sale` and `rejected-transfer-stays-pending`: after the fix the admin still has a pending transfer on a cancelled sale to decide.

## Open Questions

- [NEEDS CLARIFICATION: product choice — hold the apartado (seats wait on money) or cancel without crediting the pending amount?]
