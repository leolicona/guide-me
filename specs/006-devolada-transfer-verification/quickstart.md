# Quickstart: validating Automatic Transfer Verification with Devolada

This guide only runs and checks things. Implementation detail lives in `tasks.md`; contracts in
[`contracts/`](./contracts/), and data in [`data-model.md`](./data-model.md).

## Prerequisites

- **Toolchain and local data**: Node 22, `pnpm install`, the local database (`docs/DEVELOPMENT.md` in the archive), and `api-turistear/.dev.vars` from `.dev.vars.example`, `BETTER_AUTH_SECRET` included.
- **A Devolada test credential** (`dk_…`) from a business set aside for testing in **Devolada's dev environment** (`api.dev.devoladapago.com`), from its panel under **Integraciones → API**. Devolada production does not know a dev key (it answers «Devolada rechazó la clave»). Never use a business that a real integration also uses: Devolada keeps one notification address per business (research D3).
- **For step 14**, a second test business set aside the same way, and its test key.
- **`api-turistear/.dev.vars`** gains:

  ```bash
  DEVOLADA_CREDENTIAL_KEY=<output of: openssl rand -base64 32>
  ```

- **The wrangler local profile**:
  - sets `DEVOLADA_API_BASE_URL=https://api.dev.devoladapago.com`, `DEVOLADA_KEY_MODE=test` and an empty `DEVOLADA_WEBHOOK_URL`;
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
curl -s "https://api.dev.devoladapago.com/v1/payments?customerRef=<folio id>" \
  -H "Authorization: Bearer <dk_ test key>"
curl -s -X POST "https://api.dev.devoladapago.com/v1/test/payments/<payment id>/advance" \
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
| 11 | Pay a link after its sale was cancelled (advance to `unapplied`) | Por verificar: «Dinero por devolver»; «Ya lo devolví» clears it |
| 12 | Set `DEVOLADA_API_BASE_URL=https://devolada.invalid` and sell by transfer. Then restore it, and sell by transfer a service that departs in less than 15 minutes | The sale completes. The receipt shows «No se pudo crear el enlace de pago…», and Por verificar shows «Sin enlace de pago — verificar a mano» (FR-010). The second sale completes with no link at Devolada: the receipt shows «Ya no hay tiempo para cobrar con enlace…», and Por verificar shows it as «Sin enlace de pago — verificar a mano» |
| 13 | Register a second organization at `/register` and sign in as its admin | Sees none of the first organization's connection, links or payments; resolving one of them by id answers 404 (FR-021) |
| 14 | Connect business A's test key and sell two sales by transfer. Confirm a test transfer on the first sale's link page, then replace the key with business B's. Advance that payment to `confirmed` with A's key, and trigger the sweep. Then revoke A's key in A's panel and trigger the sweep again | Ajustes shows B's «Clave …» and «La clave anterior …(A's hint) todavía tiene 2 enlaces pendientes…». The first sale is verified: its link is followed with A's key (research D21), and the line says 1. After the revocation, the second sale moves to Por verificar as «Sin enlace de pago — verificar a mano», nothing is cancelled, and the line is gone |

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

## 4 · Measuring the outcomes

Four read-only queries, one per success criterion the data can measure. Each answers per
organization, with counts, shares and seconds only: no customer, sale or payment identifier leaves
the database. Save one to a file and run it against the environment you want to measure:

```bash
pnpm --filter api-turistear exec wrangler d1 execute guideme-db-prod --env production --remote --file sc-001.sql
pnpm --filter api-turistear exec wrangler d1 execute guideme-db --env dev --remote --file sc-001.sql
```

The first lines (`params`) are the only ones to edit: `since` starts the period measured, and
`mode` is `'real'` in production and `'test'` on dev, where every key is a test key. The queries were
checked against a database with every migration applied: each returns the expected figures on
seeded rows, and none plans a `SCAN` inside a correlated subquery (BUG-042).

**SC-001 — released with no admin action** (target: `pct` at least 95). A confirmed payment counts
as released by the system when its link ended `paid` and the row it collected was verified by no
one (`verified_by` NULL: «Sistema»). Money to return (research D9) is left out: it settles nothing.
A confirmed payment still waiting to be applied counts against.

```sql
WITH params AS (SELECT CAST(strftime('%s', '2026-11-01') AS INTEGER) AS since, 'real' AS mode),
confirmed AS (
  SELECT dp.organization_id, dl.state AS link_state, fp.verified_by
  FROM devolada_payments dp
  JOIN devolada_links dl ON dl.id = dp.link_id
  LEFT JOIN folio_payments fp ON fp.id = dl.folio_payment_id
  WHERE dp.status = 'confirmed'
    AND dl.mode = (SELECT mode FROM params)
    AND coalesce(dp.verdict_at, dp.devolada_created_at) >= (SELECT since FROM params)
    -- Money to return settles nothing (research D9): not a sale to release.
    AND NOT (dl.state <> 'paid' AND (dl.closed_reason IS NOT NULL
      OR EXISTS (SELECT 1 FROM folios f WHERE f.id = dp.folio_id AND f.cancelled_at IS NOT NULL)))
)
SELECT o.name AS organization,
  count(*) AS confirmed,
  sum(c.link_state = 'paid' AND c.verified_by IS NULL) AS released_by_system,
  round(100.0 * sum(c.link_state = 'paid' AND c.verified_by IS NULL) / count(*), 1) AS pct
FROM confirmed c JOIN organizations o ON o.id = c.organization_id
GROUP BY c.organization_id ORDER BY o.name;
```

**SC-002 — seconds from the verdict to the tickets** (target: `pct_within_120s` at least 95).
`verdict_at` is Devolada's verdict; `applied_at` is when this system applied it, in the request that
signed the QR, sent the email and unlocked WhatsApp. Only payments the system released are measured,
and only the kinds that release tickets (a deposit releases none). Both times are in seconds.

```sql
WITH params AS (SELECT CAST(strftime('%s', '2026-11-01') AS INTEGER) AS since, 'real' AS mode),
released AS (
  SELECT dp.organization_id, max(0, dp.applied_at - dp.verdict_at) AS secs
  FROM devolada_payments dp
  JOIN devolada_links dl ON dl.id = dp.link_id
  JOIN folio_payments fp ON fp.id = dl.folio_payment_id
  WHERE dp.status = 'confirmed' AND dp.applied_status = 'confirmed'
    AND dl.state = 'paid' AND dl.kind IN ('sale', 'settlement') AND fp.verified_by IS NULL
    AND dl.mode = (SELECT mode FROM params)
    AND dp.verdict_at >= (SELECT since FROM params)
),
ranked AS (
  SELECT organization_id, secs,
    row_number() OVER (PARTITION BY organization_id ORDER BY secs) AS n,
    count(*) OVER (PARTITION BY organization_id) AS total
  FROM released
)
SELECT o.name AS organization,
  max(r.total) AS released,
  round(100.0 * sum(r.secs <= 120) / max(r.total), 1) AS pct_within_120s,
  max(CASE WHEN r.n = (r.total + 1) / 2 THEN r.secs END) AS median_secs,
  max(CASE WHEN r.n = (95 * r.total + 99) / 100 THEN r.secs END) AS p95_secs
FROM ranked r JOIN organizations o ON o.id = r.organization_id
GROUP BY r.organization_id ORDER BY o.name;
```

**SC-004 — transfers waiting more than 24 hours** (target: `without_label` 0). A pending transfer of
a connected organization, received after it connected, on a live sale. Every link gives its sale a
label (contracts § Labels), so a transfer without a link has none. `link_still_open` is not a
failure of SC-004, but a link lives 24 hours at most (D7): a non-zero count means the sweep cannot
reach Devolada for that organization.

```sql
WITH params AS (SELECT CAST(strftime('%s', 'now') AS INTEGER) - 24 * 3600 AS cutoff),
waiting AS (
  SELECT fp.organization_id,
    (SELECT dl.state FROM devolada_links dl
      WHERE dl.organization_id = fp.organization_id AND dl.folio_id = fp.folio_id
        AND dl.folio_payment_id = fp.id
      ORDER BY dl.created_at DESC LIMIT 1) AS link_state
  FROM folio_payments fp
  JOIN devolada_connections dc ON dc.organization_id = fp.organization_id AND dc.status <> 'disconnected'
  JOIN folios f ON f.id = fp.folio_id
  WHERE fp.entry_type = 'payment' AND fp.method = 'transfer' AND fp.verification = 'pending'
    AND f.cancelled_at IS NULL
    AND fp.created_at >= dc.connected_at AND fp.created_at < (SELECT cutoff FROM params)
)
SELECT o.name AS organization,
  count(*) AS waiting_over_24h,
  sum(w.link_state IS NULL) AS without_label,
  sum(w.link_state IN ('creating', 'open')) AS link_still_open
FROM waiting w JOIN organizations o ON o.id = w.organization_id
GROUP BY w.organization_id ORDER BY o.name;
```

**SC-008 — the transfers' share of payments** (hypothesis: `after` above 5%, against today's 0.5%).
Every positive payment row 60 days before connecting and up to 60 days after, by count and by
amount, cancelled sales included. `days_after_connecting` below 60 means the window is still
open. `connected_at` is the latest connection: an organization that reconnected is measured from
then.

```sql
WITH windows AS (
  SELECT organization_id, connected_at AS t0,
    min(60, (CAST(strftime('%s', 'now') AS INTEGER) - connected_at) / 86400) AS days_after
  FROM devolada_connections
),
pays AS (
  SELECT w.organization_id, w.days_after,
    CASE WHEN fp.created_at >= w.t0 THEN 'after' ELSE 'before' END AS period,
    fp.method, fp.amount
  FROM windows w
  JOIN folio_payments fp ON fp.organization_id = w.organization_id
  WHERE fp.entry_type = 'payment' AND fp.amount > 0
    AND fp.created_at >= w.t0 - 60 * 86400 AND fp.created_at < w.t0 + 60 * 86400
)
SELECT o.name AS organization, p.period, max(p.days_after) AS days_after_connecting,
  count(*) AS payments,
  round(100.0 * sum(p.method = 'transfer') / count(*), 1) AS transfer_pct_by_count,
  round(100.0 * sum(CASE WHEN p.method = 'transfer' THEN p.amount ELSE 0 END) / sum(p.amount), 1) AS transfer_pct_by_amount
FROM pays p JOIN organizations o ON o.id = p.organization_id
GROUP BY p.organization_id, p.period ORDER BY o.name, p.period DESC;
```
