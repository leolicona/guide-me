# Bug Verification: customer messages say «folio», and the outbox sends them with holes

- **Slug**: payment-rejected-folio-copy
- **Tested**: 2026-10-16
- **Assessment**: ./assessment.md
- **Fix**: ./fix.md
- **Result**: verified

## Summary

The bug no longer reproduces. The assessment's reproduction was replayed through the real endpoints:
rejecting a pending transfer and cancelling a line now leave messages that say «tu compra en
{organización}», have every placeholder filled, and carry the seller's signature. Both full suites
(API and app), the app's lint and the type checks show no regression.

## Checks Performed

| Check | Command / Action | Result | Notes |
|-------|------------------|--------|-------|
| Reproduction (post-fix) | A temporary API test (`test/folios/zz-repro-…test.ts`, deleted after the run) drove the assessment's steps: sell by transfer → `POST /api/pos/folios/:id/reject` → read the WhatsApp outbox (`GET /api/notifications?status=pending&channel=whatsapp`); and sell → cancel a line of the paid sale → read the outbox | pass | Each row's `message` is the one the composer now sends verbatim (`OutboxPage.tsx`) |
| Reproduction (pre-fix, for contrast) | The old templates passed through the old composer (`composerText`: fill `{customer_name}`, cut every other placeholder) | reproduced | The exact holes of assessment steps 3-4 |
| New / updated tests | `pnpm exec vitest run test/folios/notification-outbox.test.ts` (API); `pnpm exec vitest run src/pages/OutboxPage.test.tsx src/features/folios/refundReceipt.test.ts` (app) | pass | The five API cases and the two app cases listed in fix.md |
| Regression suite — API | `pnpm exec vitest run` in `api-turistear` | pass | 90 files, 1138 tests |
| Regression suite — app | `pnpm exec vitest run` in `app-turistear` | pass | 62 files, 907 tests |
| Lint — app | `pnpm exec eslint .` in `app-turistear` | pass | 0 errors; 6 warnings, all in files this fix does not touch (`features/catalog/…`, `worker-configuration.d.ts`) |
| Type-check — app | `pnpm exec tsc -b` | pass | clean |
| Type-check — API | `pnpm exec tsc --noEmit -p tsconfig.json` | pass (baseline) | 332 errors under `src`, the pre-existing baseline (defect 9: nothing type-checks the API in CI). The seven in `routes/notifications/handler.ts` predate the fix; none is in `utils/notifications.ts` |

## Output Excerpts

Before the fix (the old template through the old composer):

```text
payment_rejected      → Hola Cliente Test, no pudimos confirmar el pago de tu folio , así que tuvimos que cancelarlo. Si crees que es un error, escríbeme. —
cancellation_approved → Hola Cliente Test, aprobamos la cancelación de tu folio en . Te contamos enseguida cómo queda.
```

After the fix (the outbox row's `message`, from the real endpoints):

```text
REPRO payment_rejected → Hola Cliente Test, no pudimos confirmar el pago de tu compra en Empresa repro, así que tuvimos que cancelarla. Si crees que es un error, escríbeme. — Beto Vende
REPRO cancellation_approved → Hola Cliente Test, aprobamos la cancelación de tu compra en Empresa repro. Te contamos enseguida cómo queda.
```

```text
API  Test Files  90 passed (90)   Tests  1138 passed (1138)
App  Test Files  62 passed (62)   Tests  907 passed (907)
Lint ✖ 6 problems (0 errors, 6 warnings)
```

## Residual Risks

- **Not replayed on a deployed environment.** The reproduction ran in the Workers test pool, against
  the real routes and a real D1 schema, not on dev or a preview. The PR's preview is where a person
  can tap «Enviar» in the outbox and read the WhatsApp text.
- **An admin's full cancellation writes no `cancellation_approved` row to the WhatsApp outbox.**
  It only records the cancellation email's outcome. Line cancellations (the seller's and the
  admin's) and an approved tourist request write that row, so the reproduction used a line
  cancellation. That is today's behaviour and outside this fix.
- **`refund_completed` was checked by its API test, not replayed.** The test seeds a cancelled sale
  with a refund and asserts the exact amounts ($2,000.00 paid, $1,500.00 returned, $500.00 kept).
- **Placeholders still dropped.** `{itinerary}` and `{portal_link}` are still cut from the
  clock-produced templates (fix.md § Deviations). None of the three messages this bug names uses them.

## Recommendation

Close the bug: the symptom no longer reproduces through the real endpoints, and nothing regressed.
Merge before Devolada's PR 2 ships (tasks.md T077), since D11 starts sending `payment_rejected`
with no human tap behind it.
