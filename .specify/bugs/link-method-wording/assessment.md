# Bug Assessment: The hidden `link` payment method reads «Link de pago», and «enlace» in the timeline

- **Slug**: link-method-wording
- **Created**: 2026-11-03
- **Source**: pasted text — `specs/006-devolada-transfer-verification/research.md:636`, § Defects found on the way, defect 12 (T077)
- **Verdict**: valid
- **Severity**: low

## Report (verbatim or summarized)

> 12. The `link` payment method, hidden at checkout (US-AG41 D1), reads «Link de pago» in its labels and «enlace» in the timeline: two words for one concept, and «link» is a word this feature never uses (D16, constitution VII). […] Its fix names the method; that name must not be «Enlace de pago», which this feature gives the Devolada enlace.

## Symptom

Old sales recorded with the `link` method show «Link de pago» on the receipt, the payment breakdown and the cash views, and «enlace» in the timeline. Since the Devolada feature, «Enlace de pago» names Devolada's enlace, so «Link de pago» now reads as a second, different thing. Expected: one Spanish name for the legacy method, used everywhere, and distinct from «Enlace de pago».

## Reproduction

1. Open any sale whose payment row has `method = 'link'` (none can be created today; existing rows remain).
2. Observed: «Link de pago» in the breakdown and receipt; «enlace» in the timeline.

## Suspected Code Paths

- `app-turistear/src/features/cash/components/paymentPresentation.ts:7`
- `app-turistear/src/features/pos/components/PaymentBreakdown.tsx:19`
- `app-turistear/src/pages/FolioReceiptPage.tsx:42`
- `app-turistear/src/features/folios/components/FolioTimeline.tsx:80`

## Root Cause Hypothesis

Four label maps each name the method independently. Confidence: high.

## Proposed Remediation

**Preferred**: One exported label for the method (in `paymentPresentation.ts`), read by the other three, with a name the product owner chooses — e.g. «Pago en línea» or «Cobro con tarjeta en línea», whichever matches what the method was.

**Files likely to change**:
- the four files above and their tests

**Tests to add or update**:
- A legacy `link` row renders the same label in the breakdown, the receipt and the timeline.

## Risks & Considerations

- Copy only.

## Open Questions

- [NEEDS CLARIFICATION: what did the `link` method collect (a card link, a third-party payment page)? The name must say that, and must not be «Enlace de pago».]
