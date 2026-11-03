# Bug Assessment: The grace notice asks the customer to settle, but settling is refused

- **Slug**: grace-stage-settle-refused
- **Created**: 2026-11-03
- **Source**: pasted text — `specs/006-devolada-transfer-verification/research.md:637`, § Defects found on the way, defect 13 (T077)
- **Verdict**: valid
- **Severity**: medium

## Report (verbatim or summarized)

> 13. The grace stage contradicts itself. Once a line's clock passes, its grace notice tells the customer «Comunícate con … para liquidar y conservar tu reserva», and Ajustes says the place is released at that clock. But `settleBooking` and `settleFolioLine` already refuse with `BOOKING_EXPIRED`, «Liquidar» stays on screen, and the seats are held until the release time. […] D7 bounds deposit and settlement links by the same clock, so a fix that lets the grace stage take a settlement moves D7's bound with it.

## Symptom

Between a line's clock (`booking_expires_at`) and its release, three surfaces disagree: the grace email invites the customer to settle and keep the reservation; Ajustes says the place is released at the clock; the API refuses the settlement with 409 `BOOKING_EXPIRED` while «Liquidar» is still on screen and the seats are still held. Expected: one rule. Either the grace stage accepts a settlement until the release, or the notice and the button stop offering it.

## Reproduction

1. Create an apartado; move its line's `booking_expires_at` into the past, before its release time.
2. Run the sweep: the grace notice is sent (`booking_grace_entered`).
3. Tap «Liquidar» on the sale.
4. Observed: 409 `BOOKING_EXPIRED`.

## Suspected Code Paths

- `api-turistear/src/routes/pos/settleCore.ts:161-164` (whole sale) and `:194-197` (one line) — refuse once the clock passed.
- `api-turistear/src/services/resend.ts:405-421` — the grace email: «Tus lugares siguen reservados, pero se liberarán si no lo liquidas … Comunícate con … para liquidar y conservar tu reserva». It also shows «Folio #…» (constitution VII says «Venta»).
- `api-turistear/src/routes/pos/sweep.ts:223` — emits `booking_grace_entered`.
- `app-turistear/src/pages/SettingsPage.tsx:358-369, 465` — the copy that says the place is released at the clock.
- `app-turistear/src/features/bookings/components/BookingActions.tsx` — «Liquidar» does not read the clock.

## Root Cause Hypothesis

The grace stage (a courtesy window before the release) was added to the sweep and the notices, but the settle guard kept the clock as its bound. Confidence: high.

## Proposed Remediation

**Preferred**: Let the grace stage take a settlement: bound `settle` by the release time instead of the clock, and move D7's bound for deposit and settlement links with it (`specs/006-devolada-transfer-verification/research.md` D7). Align the Ajustes copy.

**Alternatives**:
- Keep the clock as the bound: change the grace notice to "your hold ended; your seats are released at …", and hide «Liquidar» once the clock passed. Smaller, but the courtesy window then offers nothing.

**Files likely to change**:
- `api-turistear/src/routes/pos/settleCore.ts`, the Devolada link expiry bound (D7)
- `api-turistear/src/services/resend.ts`, `app-turistear/src/pages/SettingsPage.tsx`, `BookingActions.tsx`

**Tests to add or update**:
- Settle between the clock and the release → 200 (preferred) or the button hidden (alternative).
- A settlement link issued in grace expires no later than the release.

## Risks & Considerations

- Changes D7 of a shipped feature: amend its research in place (constitution I).
- The sweep's release still runs at the release time; a settlement racing it must be guarded in the same batch.

## Open Questions

- [NEEDS CLARIFICATION: product choice — does the grace stage accept a settlement?]
