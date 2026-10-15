# Quickstart: validating Automatic Transfer Verification with Devolada

This guide only runs and checks things. Implementation detail lives in `tasks.md`; contracts in
[`contracts/`](./contracts/), and data in [`data-model.md`](./data-model.md).

## Prerequisites

- **Toolchain and local data**: Node 22, `pnpm install`, the local database (`docs/DEVELOPMENT.md` in the archive), and `api-turistear/.dev.vars` from `.dev.vars.example`, `BETTER_AUTH_SECRET` included.
- **A Devolada test credential** (`dk_…`) from a Devolada business set aside for testing, from its panel under **Integraciones → API**. Never use a business that a real integration also uses: Devolada keeps one notification address per business (research D3).
- **For step 14**, a second test business set aside the same way, and its test key.
- **`api-turistear/.dev.vars`** gains:

  ```bash
  DEVOLADA_CREDENTIAL_KEY=<output of: openssl rand -base64 32>
  ```

- **The wrangler local profile**:
  - sets `DEVOLADA_API_BASE_URL=https://api.devoladapago.com`, `DEVOLADA_KEY_MODE=test` and an empty `DEVOLADA_WEBHOOK_URL`;
  - registers no notification address locally, so verdicts arrive through the sweep.
- **Elsewhere**: the dev environment (`api-dev.turistearya.com`) receives real notifications. A pull request's preview registers no address and runs no cron (research D17).

## 1 · Automated validation (the gate)

```bash
# The feature's own suites (fake Devolada; no network)
pnpm --filter api-turistear exec vitest run test/devolada

# Scope boundary: must pass, and must be unedited
pnpm --filter api-turistear exec vitest run \
  test/pos/payment-verification.test.ts \
  test/pos/optional-payment-reference.test.ts \
  test/paid-ledger/settle-method.test.ts
git diff --exit-code origin/main -- \
  api-turistear/test/pos/payment-verification.test.ts \
  api-turistear/test/pos/optional-payment-reference.test.ts \
  api-turistear/test/paid-ledger/settle-method.test.ts

# What CI's `verify` runs after its archive guard and frozen-lockfile install
pnpm lint:app && pnpm test:app && pnpm test:api && node --test '.github/scripts/*.test.mjs' \
  && pnpm build:api && pnpm build:app
```

**Expected**: every suite passes, and `git diff` prints nothing (SC-007).

| Story | Proven by (each file cites `devolada-transfer-verification US<n>`) |
|---|---|
| US1 — a transfer clears itself | `test/devolada/connection.test.ts`, `checkout-link.test.ts`, `webhook.test.ts`, `isolation.test.ts`, `link-view.test.ts`, and the recovery cases of `sweep.test.ts`; app `DevoladaConnectionCard.test.tsx`, `PaymentLinkCard.test.tsx`, `TransferPaymentFields.test.tsx`, `ReceiptPaymentStatus.test.tsx`, `PaymentBreakdown.test.tsx`, `PendingWorkBar.test.tsx`, `delivery.test.ts`, and the «Por verificar» cases of `folioFacets.test.ts`, `folioCardState.test.ts`, `FolioCard.test.tsx` and `FolioDetailScreen.test.tsx` |
| US2 — exceptions reach the right person | `test/devolada/verdicts.test.ts`, and the expiry cases of `sweep.test.ts`; app `FolioCard` label cases, `FolioWorkActions` «Ya lo devolví» |
| US3 — apartados | `test/devolada/apartados.test.ts`; app `SettleSheet` connected-mode cases, `FolioWorkActions` accept and dismiss |
| US4 — closing links | `test/devolada/link-closing.test.ts`; app `BookingActions` replacement notice |
| Security (FR-013, SC-005) | `test/devolada/signature.test.ts`, `credential-cipher.test.ts`, `webhook.test.ts` (forged, foreign, duplicate and test-mode events) |

**Read cost (BUG-042)**: `test/devolada/query-plans.test.ts` runs `EXPLAIN QUERY PLAN` for each new
correlated read (the sale detail's and list's `payment_links`, and the counts). **Expected**: no
`SCAN` inside a correlated subquery.

## 2 · Manual validation, local, with Devolada test mode

Start everything with `pnpm db:migrate:local && pnpm seed:local && pnpm dev`. The API runs on 5173
and the app on 5174. Sign in as the seeded admin, `admin@local.test`, with an email code: locally
the code is printed in the API console (`[otp] <email> <code>`).

To deliver verdicts locally, trigger the scheduled handler through the Cloudflare Vite plugin. The
sweep uses the trigger's time as "now" (research D12), so `time=` lets you jump past a link's expiry:

```bash
curl "http://localhost:5173/cdn-cgi/local/scheduled"
curl "http://localhost:5173/cdn-cgi/local/scheduled?time=<epoch ms after the link's expiry>"
```

The sweep re-reads a link only once 10 minutes have passed since its last check (research D12),
and nothing is notified locally. Give every new trigger a `time=` at least 10 minutes later than
the previous one, or the verdict you just advanced is not read.

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
| 1 | Ajustes → «Cobro con Devolada» → Conectar, with the test key | «Conectada · Prueba · Clave …abcd», and the health reads «Avisos: solo revisión periódica» (no address locally). An expired "Prueba de conexión — Turistear Ya!" link appears in Devolada's panel. A real key is refused (`DEVOLADA_MODE_NOT_ALLOWED`) |
| 2 | POS → sell a full sale by Transferencia | No Referencia field. The receipt shows the «Enlace de pago» card: amount, «Vence hoy a las …» (or «mañana»), «Esperando pago». «Cobrar por WhatsApp» opens `wa.me` with the link in the text. Por verificar does not list the sale, and its count does not change |
| 3 | Open the link and confirm a test transfer on Devolada's page; trigger the sweep | «Verificando pago» |
| 4 | Advance it to `confirmed`; trigger the sweep | Tickets appear (QR, portal link), «Pago confirmado». The timeline shows «Transferencia verificada por Devolada · Comprobante DV-…», by «Sistema». The sale never appears in Por verificar |
| 5 | Repeat 2–3, advance to `partial` with a lower `receivedCents` | Por verificar: «Pago incompleto» with asked and received amounts; Verificar and Rechazar work as today |
| 6 | Repeat with `invalid` | Por verificar: «Banxico no confirma la transferencia» |
| 7 | Repeat 2, don't pay; trigger the sweep with `time=` after the expiry | The sale is cancelled by «Sistema», reason «No se recibió la transferencia», and its seats are back on sale (SC-009). With PR 1 alone, before the automatic cancellation exists, the sale is back in Por verificar instead |
| 8 | Create an apartado with a transfer deposit; confirm it. Then, on a second apartado, settle by transfer, confirm a test transfer on Devolada's page and, while it is «Verificando pago», tap «Verificar» on the sale's detail | The deposit link's WhatsApp text asks for the anticipo and promises no tickets. Confirm it → deposit verified, no tickets. Settle by transfer → a settlement link, and the sale is still an apartado. Confirm it → tickets. On the second apartado, «Verificar» records the settlement and releases the tickets; advancing its payment to `confirmed` afterwards records nothing twice, and the link ends paid |
| 9 | Settle an apartado by transfer, but let the link expire unpaid | The sale stays an apartado with its deposit, and its clocks unchanged |
| 10 | With a settlement link open, cancel a line. Then confirm a test transfer on the replacement link and, while it is «Verificando pago», cancel another line | The first time, the link is closed in Devolada's panel and the response carries a replacement link for the new balance. The second time, the cancellation is refused with «La venta ya tiene un enlace de pago para liquidar; espera su resultado», and the link stays open |
| 11 | Pay a link after its sale was cancelled (advance to `unapplied`) | Por verificar: «Dinero recibido sin venta»; «Ya lo devolví» clears it |
| 12 | Set `DEVOLADA_API_BASE_URL=https://devolada.invalid` and sell by transfer. Then restore it, and sell by transfer a service that departs in less than 15 minutes | The sale completes. The receipt shows «No se pudo crear el enlace de pago…», and Por verificar shows «Sin enlace de pago — verificar a mano» (FR-010). The second sale completes with no link: the receipt shows «Ya no hay tiempo para cobrar con enlace…», and the sale waits in Por verificar like any manual transfer |
| 13 | Register a second organization at `/register` and sign in as its admin | Sees none of the first organization's connection, links or payments; resolving one of them by id answers 404 (FR-021) |
| 14 | Connect business A's test key and sell two sales by transfer. Confirm a test transfer on the first sale's link page, then replace the key with business B's. Advance that payment to `confirmed` with A's key, and trigger the sweep. Then revoke A's key in A's panel and trigger the sweep again | Ajustes shows B's «Clave …». The first sale is verified: its link is followed with A's key (research D21). After the revocation, the second sale moves to Por verificar as «Sin enlace de pago — verificar a mano», and nothing is cancelled |

## 3 · On the pull request's preview, then on dev

**On PR 1's preview** (`app-guideme-pr-<n>`; the PR's note gives its address). The preview runs on
dev's D1, so migration `0073` is already there. It registers no notification address and runs no
cron (research D17).
- If the `dev` GitHub environment holds `DEVOLADA_CREDENTIAL_KEY`, connect a test business.
  **Expected**: «Conectada · Prueba», and Devolada's `GET /v1/webhook` for that business is unchanged.
- Without the key, the pull request's note says Devolada is off on that preview: connecting answers
  500 `INTERNAL_ERROR`, and a transfer sale stays on the manual path, as in step 12.
- Repeat manual step 2. **Expected**: the link card and the WhatsApp text, as locally. Before the
  merge nothing applies verdicts to a preview's sales: validate those locally (§2).

**On dev, after the merge** (`app-dev.turistearya.com`):
- The deploy's «Secrets for the API» step shows no notice for `DEVOLADA_CREDENTIAL_KEY`.
- Connect a test business. **Expected**: Devolada's `GET /v1/webhook` for that business shows
  `https://api-dev.turistearya.com/api/webhooks/devolada`.
- If a preview connected that organization first, the connection already exists and registered no
  address. Replace the key with the same key to register dev's address.
- Repeat manual steps 2–4 without triggering anything. **Expected**: the verdict arrives by
  notification within seconds (SC-002), and the sweep finds nothing to do.
- Send a request to the webhook with a bad signature. **Expected**: 401 `WEBHOOK_SIGNATURE_INVALID`,
  and nothing changes.

**In production, after the `v*` tag**: connecting with a test key is refused with
`DEVOLADA_MODE_NOT_ALLOWED`.
