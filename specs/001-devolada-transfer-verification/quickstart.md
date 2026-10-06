# Quickstart: validating Automatic Transfer Verification with Devolada

This guide only runs and checks things. Implementation detail lives in `tasks.md`; contracts in
[`contracts/`](./contracts/), and data in [`data-model.md`](./data-model.md).

## Prerequisites

- **Toolchain and local data**: Node 22, `pnpm install`, and the local database (`docs/DEVELOPMENT.md` in the archive).
- **A Devolada test credential** (`dk_…`) from a Devolada business set aside for testing, from its panel under **Integraciones → API**. Never use a business that a real integration also uses: Devolada keeps one notification address per business (research D3).
- **`api-turistear/.dev.vars`** gains:

  ```bash
  DEVOLADA_CREDENTIAL_KEY=<output of: openssl rand -base64 32>
  ```

- **The wrangler local profile**:
  - sets `DEVOLADA_API_BASE_URL=https://api.devoladapago.com`, `DEVOLADA_KEY_MODE=test` and an empty `DEVOLADA_WEBHOOK_URL`;
  - registers no notification address locally, so verdicts arrive through the sweep;
  - the dev environment (`api-dev.turistearya.com`) receives real notifications.

## 1 · Automated validation (the gate)

```bash
# The feature's own suites (fake Devolada; no network)
pnpm --filter api-turistear exec vitest run test/devolada

# Scope boundary: must pass, and must be unedited
pnpm --filter api-turistear exec vitest run \
  test/pos/payment-verification.test.ts \
  test/pos/optional-payment-reference.test.ts \
  test/paid-ledger/settle-method.test.ts
git diff --exit-code origin/develop -- \
  api-turistear/test/pos/payment-verification.test.ts \
  api-turistear/test/pos/optional-payment-reference.test.ts \
  api-turistear/test/paid-ledger/settle-method.test.ts

# Everything CI's `verify` job runs
pnpm test:api && pnpm test:app && pnpm lint:app && pnpm build:api && pnpm build:app
```

**Expected**: every suite passes, and `git diff` prints nothing (SC-007).

| Story | Proven by (each file cites `devolada-transfer-verification US<n>`) |
|---|---|
| US1 — a transfer clears itself | `test/devolada/connection.test.ts`, `checkout-link.test.ts`, `webhook.test.ts`, `isolation.test.ts`; app `DevoladaConnectionCard.test.tsx`, `PaymentLinkCard.test.tsx`, `TransferPaymentFields.test.tsx` |
| US2 — exceptions reach the right person | `test/devolada/verdicts.test.ts`, `sweep.test.ts`; app `FolioCard` label cases |
| US3 — apartados | `test/devolada/apartados.test.ts`; app `SettleSheet` connected-mode cases |
| US4 — closing links | `test/devolada/link-closing.test.ts` |
| Security (FR-013, SC-005) | `test/devolada/signature.test.ts`, `credential-cipher.test.ts`, `webhook.test.ts` (forged, foreign, duplicate and test-mode events) |

**Read cost (BUG-042)**: run `EXPLAIN QUERY PLAN` for each new correlated read (the sale detail's and
list's `payment_links`, and the counts). **Expected**: no `SCAN` inside a correlated subquery.

## 2 · Manual validation, local, with Devolada test mode

Start everything with `pnpm db:migrate:local && pnpm seed:local && pnpm dev`. The API runs on 5173
and the app on 5174. Log in as the seeded admin.

To deliver verdicts locally, trigger the scheduled handler through the Cloudflare Vite plugin. The
sweep uses the trigger's time as "now" (research D12), so `time=` lets you jump past a link's expiry:

```bash
curl "http://localhost:5173/cdn-cgi/local/scheduled"
curl "http://localhost:5173/cdn-cgi/local/scheduled?time=<epoch ms after the link's expiry>"
```

Find a test payment's id with your test key, then move it to a verdict:

```bash
curl -s "https://api.devoladapago.com/v1/payments?customerRef=<folio id>" \
  -H "Authorization: Bearer <dk_ test key>"
curl -s -X POST "https://api.devoladapago.com/v1/test/payments/<payment id>/advance" \
  -H "Authorization: Bearer <dk_ test key>" -H "Content-Type: application/json" \
  -d '{"to":"confirmed"}'
```

| # | Do | Expect |
|---|---|---|
| 1 | Ajustes → «Cobro con Devolada» → Conectar, with the test key | «Conectada · Prueba · …abcd». An expired "Prueba de conexión — Turistear Ya!" link appears in Devolada's panel. A real key is refused (`DEVOLADA_MODE_NOT_ALLOWED`) |
| 2 | POS → sell a full sale by Transferencia | No Referencia field. The receipt shows the «Liga de pago» card: amount, «Vence a las …», «Esperando pago». «Enviar liga por WhatsApp» opens `wa.me` with the link in the text |
| 3 | Open the link and confirm a test transfer on Devolada's page; trigger the sweep | «Validando pago» |
| 4 | Advance it to `confirmed`; trigger the sweep | Tickets appear (QR, portal link), «Pago confirmado». The timeline shows «Transferencia verificada · Sistema» with the Comprobante Devolada. The sale never appears in Por verificar |
| 5 | Repeat 2–3, advance to `partial` with a lower `receivedCents` | Por verificar: «Pago incompleto» with asked and received amounts; Verificar and Rechazar work as today |
| 6 | Repeat with `invalid` | Por verificar: «Banxico no confirma la transferencia» |
| 7 | Repeat 2, don't pay; trigger the sweep with `time=` after the expiry | The sale is cancelled by «Sistema», reason «No se recibió la transferencia», and its seats are back on sale (SC-009) |
| 8 | Create an apartado with a transfer deposit; confirm it | Deposit verified, no tickets. Settle by transfer → a settlement link, and the sale is still an apartado. Confirm it → tickets |
| 9 | Settle an apartado by transfer, but let the link expire unpaid | The sale stays an apartado with its deposit, and its clocks unchanged |
| 10 | With a settlement link open, cancel a line | The link is closed in Devolada's panel; the response carries a replacement link for the new balance |
| 11 | Pay a link after its sale was cancelled (advance to `unapplied`) | Por verificar: «Dinero recibido sin venta»; «Ya lo devolví» clears it |
| 12 | Set `DEVOLADA_API_BASE_URL=https://devolada.invalid` and sell by transfer | The sale completes. The receipt shows «No se pudo crear la liga de pago…», and Por verificar shows «Sin liga de pago — verificar a mano» (FR-010) |
| 13 | Log in as a second organization's admin (seeded) | Sees none of the first organization's connection, links or payments; resolving one of them by id answers 404 (FR-021) |

## 3 · Dev environment checks (after PR 1 deploys to `develop`)

- Connect a test business in `app-dev.turistearya.com`. Devolada's `GET /v1/webhook` for that business shows `https://api-dev.turistearya.com/api/webhooks/devolada`.
- Repeat manual steps 2–4 without triggering anything. **Expected**: the verdict arrives by notification within seconds (SC-002), and the sweep finds nothing to do.
- Send a request to the webhook with a bad signature. **Expected**: 401 `WEBHOOK_SIGNATURE_INVALID`, and nothing changes.
