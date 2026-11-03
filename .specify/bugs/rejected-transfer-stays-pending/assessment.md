# Bug Assessment: A rejected or swept transfer stays «por verificar» forever

- **Slug**: rejected-transfer-stays-pending
- **Created**: 2026-11-03
- **Source**: pasted text — `specs/006-devolada-transfer-verification/research.md:629`, § Defects found on the way, defect 5 (T077)
- **Verdict**: valid
- **Severity**: medium

## Report (verbatim or summarized)

> 5. A rejected or swept transfer stays `pending` forever, like the production payment of 2026-07-31. `routes/pos/handler.ts:3025-3113`.

## Symptom

After Rechazar, or after the sweep cancels an apartado with an unverified transfer, the sale's `payment_verification` and its transfer rows' `verification` stay `pending`. Nothing ever moves them. A cancelled sale therefore still reads as awaiting verification, which is what lets Verificar and a second Rechazar run on it. Expected: the rejected money ends in a terminal state (e.g. `rejected`).

## Reproduction

1. Sell by transfer with a reference.
2. Rechazar it.
3. Observed: `folios.payment_verification = 'pending'`; the transfer row's `folio_payments.verification = 'pending'`.

## Suspected Code Paths

- `api-turistear/src/routes/pos/handler.ts:2515-2526` — Rechazar's folio update sets the cancellation stamps, never `payment_verification`.
- `api-turistear/src/db/schema.ts:449-451` and `:939` — `payment_verification` and `folio_payments.verification` have no terminal state but `verified` (`not_required | pending | verified`).
- `api-turistear/src/routes/pos/sweep.ts:175-187` — the sweep's cancellation does not touch verification either.

## Root Cause Hypothesis

The verification axis was designed as re-armable (`pending` ↔ `verified`) with no rejected end; cancellation was modelled only on `cancelled_at`. Every reader must therefore combine both columns, and the admin endpoints do not (`verify-cancelled-sale`, `reject-rereleases-cancelled-seats`). The Devolada feature reads `cancelled_at` everywhere it decides (D9) and left this unchanged. Confidence: high.

## Proposed Remediation

**Preferred**: Add `rejected` to both Drizzle enums (`api-turistear/src/db/schema.ts:449` and `:939`). The columns are plain `text` with no `CHECK` in any migration, so the change needs only a data migration for the backfill. Rechazar sets the rows it rejects and the folio to `rejected` in its batch; the sweep sets the pending rows it cancels likewise. Backfill: every cancelled folio still `pending` → `rejected`, including the production payment of 2026-07-31.

**Alternatives**:
- Leave the column and guard every reader on `cancelled_at`. No migration, but each new reader must remember it.

**Files likely to change**:
- `api-turistear/src/db/schema.ts`, a new migration `api-turistear/migrations/00NN_*.sql`
- `api-turistear/src/routes/pos/handler.ts`, `api-turistear/src/routes/pos/sweep.ts`
- the app's types for `payment_verification`
- tests for Rechazar and the sweep

**Tests to add or update**:
- Rechazar → `rejected` on the folio and on the rejected rows; a cash row stays `not_required`.
- The sweep cancels with a pending transfer → `rejected`.
- Devolada's readers (`folioPendingWork.ts`, the attention counts) ignore `rejected`.

## Risks & Considerations

- A migration that reaches dev is never renamed (`specs/005-delivery-pipeline` D19).
- Every `payment_verification = 'pending'` reader must be audited; a `rejected` value unknown to the app must render safely.

## Open Questions

- [NEEDS CLARIFICATION: does the 2026-07-31 production payment need a manual decision before the backfill, or is `rejected` right for it?]
