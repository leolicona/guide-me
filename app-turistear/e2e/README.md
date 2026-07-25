# E2E walkthrough — paid-ledger settle flow (US-LG03 / US-LG08)

A Playwright walkthrough that verifies the reported fix **through the UI, against a deployed
environment**: an agent settles a booking's balance by a *different* method than the deposit
(cash deposit → transfer balance), an admin verifies the electronic payment, and the folio then
reads as a **Mixto** collection with a per-payment **breakdown** (deposit vs balance).

## ⚠️ Prerequisite: the stack must be deployed

`app-dev.turistearya.com` deploys from **`develop`**. As of writing, the paid-ledger stack is **not
yet on `develop`** (the PRs #19–#25 are merged down the branch chain, not into `develop`), so the
new UI — the settle method picker, `Mixto`, the breakdown — **is not live on app-dev yet**. Merge
the stack into `develop` (which triggers the dev deploy) before running this, or point
`E2E_BASE_URL` at an environment that already has it.

## What you provide (never committed)

Credentials and the target folio come from **environment variables** — the spec never hardcodes a
password, and Playwright types them at runtime:

| Var | Meaning |
|---|---|
| `E2E_AGENT_EMAIL` / `E2E_AGENT_PASSWORD` | the agent/operator who **owns** the booking |
| `E2E_ADMIN_EMAIL` / `E2E_ADMIN_PASSWORD` | an admin (verifies the transfer payment) |
| `E2E_FOLIO_ID` | a **live booking (apartado)** folio, collected with a **cash deposit** |
| `E2E_BASE_URL` | optional; defaults to `https://app-dev.turistearya.com` |

Without `E2E_FOLIO_ID` the walkthrough **skips** (create an apartado first — reserve a service with
a down payment — and pass its id).

## Run

```bash
# from app-turistear/
E2E_BASE_URL=https://app-dev.turistearya.com \
E2E_AGENT_EMAIL=... E2E_AGENT_PASSWORD=... \
E2E_ADMIN_EMAIL=... E2E_ADMIN_PASSWORD=... \
E2E_FOLIO_ID=<live-booking-folio-id> \
pnpm test:e2e            # headless
# pnpm test:e2e:headed   # watch it drive the browser
# pnpm test:e2e:report   # open the HTML report (trace/video on failure)
```

First-time only, install the browser: `npx playwright install chromium`.

## What it checks

1. **Agent** opens `/pos/folio/:id` → **Liquidar saldo** → picks **Transferencia** + reference →
   **Cobrar y liquidar**. The folio flips to paid and shows **Por verificar** (QR deferred).
2. **Admin** opens `/folios/:id` → **Verificar** the electronic payment.
3. **Agent** re-reads the folio → **Desglose de pagos** lists **Efectivo** (deposit) and
   **Transferencia** (balance) as separate movements.

## Tuning

The admin **Verificar** step's exact control/label depends on the admin folio-detail UI — adjust the
selector in `settle-breakdown.spec.ts` if your environment differs. Traces, screenshots, and video
are captured on failure under `e2e/.report/`.
