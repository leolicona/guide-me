# Bug Verification: "Verificar y enviar" sends the ticket message with no link on an apartado

- **Slug**: verify-send-empty-link
- **Tested**: 2026-10-06
- **Assessment**: ./assessment.md
- **Fix**: ./fix.md
- **Result**: verified

## Summary

The bug no longer reproduces at any step of the assessment's reproduction, each exercised by its
automated equivalent on the fix commit (`663dd78`): the apartado gets the deposit confirmation, never
the link-less ticket message, and neither mark-sent endpoint will stamp *Enviado* on it. No
regressions in the full app and API suites, lint or either build. Not exercised: a real browser
against a deployed environment (see Residual Risks).

## Checks Performed

| Check | Command / Action | Result | Notes |
|-------|------------------|--------|-------|
| Repro step 1 + 4 — apartado by transfer, admin verifies | `pnpm vitest run test/pos/whatsapp-delivery.test.ts` (api) › *a verified-transfer apartado still has no link…* | pass | Real Worker runtime + D1 (vitest-pool-workers). Verify returns `status: 'booking'`, `portal_link: null`. |
| Repro step 5 (server) — the stamp | same test, plus › *an apartado cannot be marked sent by the seller or the admin* | pass | Both `/ticket-delivery` routes → `409`; `tickets_sent_at` stays null. Unknown folio still `404`. |
| Repro step 2 — the card routes an apartado to this button | scratch test (outside the repo, not committed): `folioAction({ status: 'booking', payment_verification: 'pending', … })` | pass | Admin → `verify` (urgent or not); seller → `message`. No in-repo test pins this for a booking. |
| Repro step 3 + 5 (client) — tap and message | `pnpm vitest run src/features/folios/components/VerifyAndSendButton.test.tsx` (app) | pass | Fed the booking shape step 4 returns; opens *"Confirmamos tu anticipo de $800.00 … saldo pendiente es $1,700.00"*, no ticket wording, mark-sent never called. |
| Reproduction pre-fix (from the fix stage) | same tests with the source changes reverted | fail, as expected | API: `expected 200 to be 409` ×2. App: the apartado received *"…Aquí está tu reserva y tus boletos…"*. Recorded in fix.md. |
| New / updated tests | targeted api (2 files) + app (3 files) | pass | api 19/19 · app 92/92 |
| Regression suite — app | `pnpm test:app` | pass | 47 files, 732 tests |
| Regression suite — api | `pnpm test:api` | pass | 76 files, 997 tests |
| Lint | `pnpm lint:app` | pass | 0 errors, 7 pre-existing warnings (none in changed files) |
| Type-check — api | `npx tsc --noEmit -p api-turistear` (fix stage) | pass | 586 errors before and after, identical set; none introduced |
| Build | `pnpm build:api` · `pnpm build:app` | pass | both exit 0 (app build runs `tsc -b`) |
| End-to-end in a browser | Playwright journeys (`e2e.yml`) | not-run | They run only against a deployed environment with secrets this session does not hold; the fix is not deployed. |

## Output Excerpts

```
api  › Test Files  76 passed (76)   Tests  997 passed (997)
app  › Test Files  47 passed (47)   Tests  732 passed (732)
lint › ✖ 7 problems (0 errors, 7 warnings)
```

Pre-fix (fix stage):
```
× an apartado cannot be marked sent by the seller or the admin (409)   AssertionError: expected 200 to be 409
× an apartado gets the deposit confirmation, never the ticket message…  expected 'Hola Maribel, te escribe Marcos de De…' to contain 'Confirmamos tu anticipo de $800.00'
```

## Residual Risks

- **The client/server seam is covered by contract, not by one run.** The API test asserts what verify
  returns for an apartado (`status: 'booking'`, `portal_link: null`); the component test feeds that
  same shape through mocked HTTP. A real browser tapping the button against a real API was not run.
- **Step 2 has no committed test for a booking** — `folioCardState.test.ts` covers `verify` only on a
  paid folio. Verified here by a scratch run; worth pinning in the repo next time that file changes.
- Folios already mis-stamped *Enviado* while apartados are untouched (no backfill) — see fix.md
  Follow-ups.
- The WhatsApp hop itself (`wa.me` opening on the admin's phone) is the platform's, not ours; the
  test asserts the URL and text handed to `window.open`.

## Recommendation

Close the bug — verified at every step of the reproduction by its automated equivalent, with no
regressions. After the next deploy to dev, one manual smoke check is cheap insurance: create an
apartado by transfer as a seller, tap *Verificar y enviar* as the admin, and confirm the WhatsApp
reads *"Confirmamos tu anticipo…"* and the card does not turn *Enviado*.
