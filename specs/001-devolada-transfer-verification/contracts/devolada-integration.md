# Contract: how Turistear uses Devolada's collections API v1

**Authority**: [`devolada-collections-v1.openapi.yaml`](./devolada-collections-v1.openapi.yaml), kept verbatim.

This file records three things, as constitution VIII asks of any service we do not own:
- the part of Devolada's API we depend on;
- how we call it;
- what breaks when it is down.

Devolada is reached only through `api-turistear/src/services/devolada.ts` (research D5). It is
called with the connected organization's own credential (`Authorization: Bearer dk_…`), never a
shared one.

## Calls we make

| Purpose | Call | When | Timeout | `Idempotency-Key` | We use | On failure |
|---|---|---|---|---|---|---|
| Probe the credential, its mode and the channel (D2) | `POST /v1/payment-links` `{customerRef: "turistear-conexion", askCents: 100, mode: "one_time", expiresAt: <now − 60 000 ms>, label}` | connect | 8 s | fresh UUID per attempt | `isTest` | refuse the connection (contracts/turistear-api.md) |
| Read the notification address (D3) | `GET /v1/webhook` | connect; health | 8 s | — | `url`, failure counters | 404 = none registered |
| Register our address (D3) | `PUT /v1/webhook` `{url}` | connect | 8 s | — | — | `INSECURE_URL` = our configuration bug |
| Count failing deliveries (FR-005) | `GET /v1/webhook/deliveries?status=failed&limit=20` | health | 8 s | — | count | health shows `DEVOLADA_UNAVAILABLE` |
| Issue a payment link (D6, D7) | `POST /v1/payment-links` `{customerRef: <folio id>, askCents, mode: "one_time", expiresAt, label, concept}` | checkout, settlement, replacement | **3 s** | link row id; `#<n>` after a non-retryable refusal | `id`, `url`, `notices` | fallback to the manual path |
| Learn whether a timed-out link exists (D12) | the same `POST`, same key | sweep | 8 s | link row id | a replayed answer means it exists | retry next run |
| Close a link (D13) | `PATCH /v1/payment-links/{id}` `{close: true}` | after cancel, reject or another settlement; sweep retry | 8 s | `close:` + link row id | — | `LINK_CLOSED`, or an answer showing it paid or expired, means already closed |
| Read one payment (D4) | `GET /v1/payments/{paymentId}` | every webhook | 8 s | — | everything D9 needs | `NOT_FOUND` = not this organization's (or other mode): change nothing |
| Read a sale's payments (D12) | `GET /v1/payments?customerRef=<folio id>` | sweep | 8 s | — | every payment of every link of the sale | retry next run |
| Signing keys (D4) | `GET /.well-known/jwks.json` (no credential) | unknown `kid`; respects `Cache-Control` | 8 s | — | JWK by `kid` | webhook answers 503 so Devolada retries |

**Never called**:
- `GET /v1/transfers` (deferred, D20);
- `POST /v1/webhook/deliveries/{id}/retry`;
- `/v1/test/*`. The test-mode advance is used only by the test fake and by a developer validating by hand (quickstart).

### What we send

| Field | Value | Who sees it |
|---|---|---|
| `customerRef` | the folio id, an opaque identifier | Devolada |
| `askCents` | the amount of the payment the link collects | the payer |
| `label` | the customer's name | the payer, who is that customer |
| `concept` | organization name, first service and date | the payer |

Nothing else about the customer (phone, email) or the seller ever leaves Turistear.

### Units and identities

- Devolada's instants are milliseconds; ours are seconds. Converted only in `services/devolada.ts`.
- `askCents` and every `*Cents` field are our minor units unchanged (MXN, integer).
- `paymentLinkId` and `paymentId` are globally unique; we store them as `devolada_link_id` and `devolada_payment_id` (UNIQUE).
- Devolada's `folio` (`DV-…`) is its receipt number. We store it as `receipt_number` and show it as «Comprobante Devolada».

## Error mapping

| Devolada answers | On | Turistear does |
|---|---|---|
| `AUTHENTICATION_ERROR` (401) | any call | connection → `broken` (`DEVOLADA_CREDENTIAL_REJECTED`); checkout falls back; the admin is warned in Ajustes |
| `BUSINESS_SUSPENDED` (409) | any call | connection → `broken`; checkout falls back |
| `CHANNEL_UNAVAILABLE` (409) | issue link | connection → `broken`, recording `clabe` or `bank`; checkout falls back |
| `VALIDATION_ERROR` (400) | any call | our bug: logged with Devolada's `message`; the link → `failed`; the key gets a new suffix |
| `LINK_CLOSED` (409) | `PATCH` | already closed → `closed` |
| `NOT_FOUND` (404) | read payment | not this organization's or not this mode → no change |
| `RATE_LIMITED` (429) | any call | retryable; the sweep stops calling for that organization until the next run |
| `INTERNAL_SERVER_ERROR` (500), network error, timeout | any call | retryable; at checkout a timeout leaves the link `abandoned` and the sale on the manual path |
| a link with notice `VALIDATION_UNAVAILABLE` | issue link | the link works but validation is delayed; health shows it |

## Webhook verification (research D4)

1. Refuse a body over 64 KiB, then read it raw.
2. Read `Devolada-Timestamp`, `Devolada-Key-Id` and `Devolada-Signature`. The signature must start with `v1=`.
3. Get the JWK whose `kid` is `Devolada-Key-Id`: from the isolate cache, else fetch the key set once. Import it as ECDSA P-256 for `verify`.
4. Verify the base64url-decoded raw `r‖s` signature over `` `${timestamp}.${rawBody}` `` with SHA-256. On failure, answer 401.
5. Only now parse the JSON and validate its shape. On failure, answer 400.
6. Resolve the link by `data.paymentLinkId`. Unknown → 200 and a log line.
7. Check that `data.isTest` matches the connection's mode, then de-duplicate on `eventId`.
8. Re-read `GET /v1/payments/{data.paymentId}` with the owning organization's credential, and apply D9 to that answer.

Devolada's rules this satisfies:
- verify before parsing;
- ignore an `eventId` already processed;
- answer within 10 s;
- order by `createdAt`, which the re-read makes moot;
- credit only on a verdict.

## Failure modes — what breaks when Devolada is down

| Devolada condition | Effect on Turistear | Who notices | Recovery |
|---|---|---|---|
| Unreachable at checkout or settlement | No link is created. The sale completes on today's manual path | Seller: an alert on the receipt. Admin: Por verificar «Sin liga de pago — verificar a mano» | None needed: the admin verifies as today |
| Its notifications stop (outage, address taken by another system) | Verdicts arrive late | Ajustes health: `consecutive_failures`, `is_ours = false` | The sweep re-reads every open link at least every 15 minutes (SC-003) |
| Keys endpoint unreachable | The webhook answers 503 | — | Devolada retries for 4 h; the sweep needs no keys |
| Credential revoked or business suspended | Connection `broken`; new transfers fall back | Admin, in Ajustes | The admin replaces the key, or Devolada lifts the suspension |
| Validation credit exhausted | Payments wait as `queued_for_credit`; tickets wait with them | Admin: «Validaciones en pausa» in Ajustes | The business tops up at Devolada; validation resumes by itself |
| Down longer than a link's lifetime | Nothing is cancelled: the unpaid branch needs a successful re-read showing no payment in flight (D9) | — | When Devolada answers again, the sweep applies whatever happened |
| Devolada answers wrongly (a verdict a human disputes) | — | Admin | Verificar or Rechazar by hand remain available (FR-018) |

A Devolada outage never blocks or undoes a sale, a cancellation or a manual verification (constitution VIII).
