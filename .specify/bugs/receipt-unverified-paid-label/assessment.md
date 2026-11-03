# Bug Assessment: The receipt still labels unverified transfer money «Pagado»

- **Slug**: receipt-unverified-paid-label
- **Created**: 2026-11-03
- **Source**: pasted text — `specs/006-devolada-transfer-verification/research.md:631`, § Defects found on the way, defect 7 (T077)
- **Verdict**: valid
- **Severity**: low

## Report (verbatim or summarized)

> 7. `FolioReceiptPage` shows «Venta confirmada», «Pagado» and «Folio {id}» for an unverified transfer. `app:pages/FolioReceiptPage.tsx:74-85, 143-148`. Fixed here only on the surfaces this feature touches (D16).

## Symptom

The Devolada feature replaced the receipt's header with `ReceiptPaymentStatus` (D16): no «Venta confirmada» for an unverified transfer, and no «Folio {id}» line. What remains is the amounts block: a full sale paid by an unverified transfer still reads «Pagado $X». Expected: money nobody has verified is not called paid (e.g. «Por verificar» or «Transferencia por verificar»).

## Reproduction

1. Sell a full sale by transfer with a reference (or with Devolada, before the verdict).
2. Open its receipt (`/pos/folios/:id/receipt`).
3. Observed: the header reads the D16 status (correct); the amounts block reads «Pagado» with the full amount.

## Suspected Code Paths

- `app-turistear/src/pages/FolioReceiptPage.tsx:208-211` — `{isBooking ? 'Anticipo' : 'Pagado'}` with no reading of `payment_verification`.
- `app-turistear/src/pages/FolioReceiptPage.tsx:81-84` — the header, already fixed (D16, `ReceiptPaymentStatus`).

## Root Cause Hypothesis

The amounts block predates transfer verification and labels by sale shape only. D16 fixed the surfaces the feature owned and left this line, as research recorded. Confidence: high.

## Proposed Remediation

**Preferred**: Read `folio.payment_verification`: when it is `pending`, label the row «Por verificar» (functional amber, icon-paired, never color alone), else keep «Pagado» / «Anticipo». Reuse the copy `ReceiptPaymentStatus` already uses so the two cannot disagree.

**Files likely to change**:
- `app-turistear/src/pages/FolioReceiptPage.tsx`
- a new `app-turistear/src/pages/FolioReceiptPage.test.tsx` (the page has no suite today; `ReceiptPaymentStatus.test.tsx` covers the header)

**Tests to add or update**:
- Pending transfer → the row does not read «Pagado».
- Cash sale → «Pagado»; apartado → «Anticipo».

## Risks & Considerations

- Copy only; no API change.

## Open Questions

- [NEEDS CLARIFICATION: exact copy for the pending row — «Por verificar» or «Transferencia por verificar»?]
