# Contract: Turistear API changes

**Feature**: `specs/001-devolada-transfer-verification`. **Decisions**: research D1–D20.

**Base URL**: `https://api.turistearya.com/api` (dev: `https://api-dev.turistearya.com/api`).

Conventions are those of the existing API:
- **Sessions**: HttpOnly cookies.
- **Successes**: answer under a named key.
- **Failures**: answer `{ "error": { "code", "message" } }`; clients branch on `code` (constitution IV).
- **Instants**: epoch **seconds** (`utils/folioDetail.ts:59`).
- **Money**: integer minor units.

Every change is additive, and existing fields keep their meaning. An organization that has not
connected Devolada sees the new read fields empty (`payment_links: []`, `payment_link: null`) and
none of the new response keys on checkout or settle.

## Shared shapes

### `PaymentLinkView`

```json
{
  "id": "6f1c…",
  "kind": "sale",
  "folio_line_id": null,
  "state": "open",
  "amount": 125000,
  "url": "https://link.devoladapago.com/p/kq7m2x9d4tbn3wpa",
  "expires_at": 1791300000,
  "closed_reason": null,
  "label": "validating",
  "payment": {
    "id": "a83e…",
    "status": "validating",
    "asked": 125000,
    "claimed": 125000,
    "received": null,
    "match": null,
    "receipt_number": null,
    "verdict_at": null,
    "awaiting": null,
    "awaiting_reason": null,
    "resolution": null
  }
}
```

**Field values**:
- `kind`: `sale` · `deposit` · `settlement`.
- `state`: `creating` · `open` · `paid` · `expired` · `closing` · `closed` · `failed` · `abandoned` (data-model § devolada_links).
- `payment`: `null` until the customer submits proof. Otherwise it is the link's current (latest non-superseded) payment.
- `payment.id`: the id the resolve endpoint takes.
- `url`: returned to the sale's seller and to admins, the people who send it.

### Labels — the server decides, the client maps to copy (D14, D16)

`label` is derived on the server, in precedence order (first match wins):

| `label` | When | es-MX copy | Chip tone |
|---|---|---|---|
| `link_failed` | state `failed` or `abandoned` | Sin liga de pago — verificar a mano | warning |
| `confirmed` | payment `confirmed` | Pago confirmado | paid |
| `unapplied` | payment `unapplied`, or `confirmed` on a cancelled sale | Dinero recibido sin venta | warning |
| `partial` | payment `partial` | Pago incompleto | warning |
| `invalid` | payment `invalid` | Banxico no confirma la transferencia | error |
| `not_received` | payment `expired`, or state `expired` | No se recibió la transferencia | error |
| `closed` | state `closing` or `closed`, no payment | Liga cerrada | neutral |
| `credit_paused` | payment `queued_for_credit` | Validación en pausa | warning |
| `needs_tracking_key` | payment `validating` with `awaiting` | Pide al cliente su clave de rastreo | warning |
| `validating` | payment `validating` | Validando pago | pending |
| `awaiting_payment` | state `open`, no payment | Esperando pago | pending |

Every chip pairs its colour with an icon and the text (constitution VII).

### `OrganizationDevoladaSummary` — on `GET /organizations/me`, every role

```json
"devolada": { "status": "not_connected", "mode": null }
```

- `status`: `not_connected` · `connected` · `broken` · `disconnected`.
- `mode`: `real` · `test` · `null`.
- It never carries the credential, its hint or the notification address. Agents and shift operators read this payload (D1).

### `DevoladaConnectionView` — admin only

```json
{
  "status": "connected",
  "mode": "real",
  "key_hint": "a1b2",
  "connected_at": 1791200000,
  "connected_by": { "id": "u_…", "name": "Ana Ruiz" },
  "broken_reason": null,
  "last_verdict_at": 1791290000,
  "credit_paused_since": null,
  "webhook": {
    "url": "https://api.turistearya.com/api/webhooks/devolada",
    "is_ours": true,
    "consecutive_failures": 0,
    "last_success_at": 1791290000,
    "last_failure_at": null
  },
  "health_error": null
}
```

- `webhook` is read live from Devolada with an 8 s limit. When Devolada cannot be reached, `webhook` is `null` and `health_error` is `"DEVOLADA_UNAVAILABLE"`. Health never fails the request.

## Endpoints

### Connection — admin (`requireRole('admin')`), organizations router

#### `GET /organizations/me/devolada`

- 200 `{ "connection": DevoladaConnectionView | null }`. `null` when never connected.

#### `PUT /organizations/me/devolada` — connect, or replace the key

Request:

```json
{ "api_key": "dk_0123456789abcdef0123456789abcdef", "replace_webhook": false }
```

Steps (D2, D3):
1. format check;
2. probe link;
3. mode policy;
4. notification address check;
5. encrypt and store.

| Status | Body / code | When |
|---|---|---|
| 200 | `{ "connection": DevoladaConnectionView }` | connected (or key replaced) |
| 400 | `VALIDATION_ERROR` | the key does not match `^dk_[0-9a-f]{32}$` |
| 403 | `FORBIDDEN` | not an admin |
| 409 | `DEVOLADA_CHANNEL_UNAVAILABLE` | the business lacks its CLABE or bank; `message` is `clabe` or `bank` |
| 409 | `DEVOLADA_BUSINESS_SUSPENDED` | Devolada suspended the business |
| 409 | `DEVOLADA_WEBHOOK_CONFLICT` | another address is registered; `message` is that URL. Resend with `replace_webhook: true` |
| 422 | `DEVOLADA_CREDENTIAL_REJECTED` | Devolada answered `AUTHENTICATION_ERROR` |
| 422 | `DEVOLADA_MODE_NOT_ALLOWED` | a test key in production, or a real key elsewhere |
| 502 | `DEVOLADA_UNAVAILABLE` | Devolada unreachable, timed out or answered 5xx |

#### `DELETE /organizations/me/devolada` — disconnect

- 200 `{ "connection": DevoladaConnectionView | null }`, with status `disconnected`.
- Idempotent. Links already issued are followed to their verdict (FR-004), and the credential is erased once none is left (D12).

### Checkout and settlement — sellers (agent, affiliate, shift operator) and admins

#### `POST /pos/folios` (`confirmSale`)

The request is unchanged. For a connected organization with `"payment_method": "transfer"`, `payment_reference` is neither required nor stored (FR-009).

The 201 response is unchanged for everyone else. For a connected organization's transfer sale:

```json
{
  "folio": { "…": "as today; payment_verification is \"pending\"" },
  "payment_link": "PaymentLinkView | null",
  "payment_link_error": "DEVOLADA_UNAVAILABLE"
}
```

- `payment_link_error` is present only when `payment_link` is `null`. Its values are `DEVOLADA_UNAVAILABLE`, `DEVOLADA_CREDENTIAL_REJECTED`, `DEVOLADA_BUSINESS_SUSPENDED` and `DEVOLADA_CHANNEL_UNAVAILABLE`.
- The sale then stays on today's manual path (FR-010).
- These values are a fallback signal, not an HTTP error: the request succeeded.
- The idempotent replay (200 `{ folio, replayed: true }`) returns the sale with `payment_links`.

#### `POST /pos/folios/:id/settle` and `POST /pos/folios/:id/lines/:lineId/settle`

For a connected organization with `"method": "transfer"`, no settlement is recorded (D8):

```json
{ "folio": { "…": "still an apartado" }, "payment_link": "PaymentLinkView | null", "payment_link_error": "…" }
```

- **Link already open**: if the sale already has an open settlement link, that link is returned (one per sale).
- **Link cannot be created**: today's manual settlement is recorded instead, and `payment_link_error` says why (FR-010).
- **Guards and error codes**: as today (`ALREADY_SETTLED`, `FOLIO_CANCELLED`, `BOOKING_EXPIRED`, …).
- **Cash settlement**: settling by cash while a settlement link is open closes the link (D13).

#### Line cancellations — `POST /pos/folios/:id/lines/:lineId/cancel` (agent), `POST /folios/:id/lines/:lineId/cancel` (admin)

- Unchanged, except one case: when the apartado had an open settlement link, the response adds `"payment_link"` (the replacement for the new balance, D13), or `null` plus `"payment_link_error"`.

### Reads

| Endpoint | Change |
|---|---|
| `GET /pos/folios/:id`, `GET /folios/:id` | `folio.payment_links: PaymentLinkView[]`, newest first |
| `GET /pos/folios`, `GET /folios` | each row gains `payment_link: PaymentLinkView | null`: the latest unresolved link, otherwise the latest. Devolada attention items join the pending-work set, so they are listed whatever their age (D14) |
| `GET /folios/counts` | adds `verification_auto` (pending sales an open Devolada link covers; no action needed) and `devolada_attention` (actionable Devolada items). Admin badge = `verification − verification_auto + devolada_attention + folio_requests` |
| `GET /organizations/me` | adds `devolada: OrganizationDevoladaSummary` |

### Resolving Devolada exceptions — admin (`/devolada` router, `requireRole('admin')`)

#### `POST /devolada/payments/:id/resolve`

`:id` is `PaymentLinkView.payment.id`. Request:

```json
{ "action": "accept", "note": "El cliente transfirió el resto en efectivo" }
```

| `action` | Allowed when | Effect |
|---|---|---|
| `accept` | settlement link, payment `partial` or `invalid`, unresolved | records the settlement as the admin (`verified_by` = admin) and releases tickets if the sale is now paid and cleared |
| `dismiss` | settlement link, payment `partial` or `invalid`, unresolved | closes the link; the apartado continues |
| `returned` | payment `unapplied` (or `confirmed` on a cancelled sale), unresolved | records that the money was returned outside the system |

`note` is optional, up to 500 characters.

| Status | Body / code |
|---|---|
| 200 | `{ "folio": FolioDetail }` |
| 400 | `VALIDATION_ERROR` |
| 403 | `FORBIDDEN` |
| 404 | `NOT_FOUND`: unknown, or another organization's (constitution III) |
| 409 | `DEVOLADA_PAYMENT_NOT_RESOLVABLE`: the action does not fit the payment's status or kind, or it was already resolved |
| 409 | `FOLIO_CANCELLED`: `accept` on a cancelled sale |

Sale and deposit exceptions use today's `POST /pos/folios/:id/verify` and `/reject` (FR-018). These now also close the link (D13).

### Webhook — public, Devolada only (`/webhooks` router, no auth)

#### `POST /webhooks/devolada`

- **Headers**: `Devolada-Event-Id`, `Devolada-Timestamp`, `Devolada-Key-Id`, `Devolada-Signature`.
- **Body**: Devolada's `WebhookEvent`, at most 64 KiB.
- **Procedure**: research D4.

| Status | Body / code | Devolada's reading |
|---|---|---|
| 200 | `{ "received": true }`: applied, duplicate, unknown link or mode mismatch | delivered |
| 400 | `WEBHOOK_PAYLOAD_INVALID`: not JSON, wrong shape, or over 64 KiB | failed attempt |
| 401 | `WEBHOOK_SIGNATURE_INVALID` | failed attempt |
| 503 | `DEVOLADA_UNAVAILABLE`: keys or the re-read unreachable | failed attempt, retried |
| 500 | `INTERNAL_ERROR` | failed attempt, retried |

## Error codes (declared before code — constitution IV)

Each is added to the `ErrorCode` union in `api-turistear/src/types/errors.ts`.

| Code | HTTP | Raised by | Meaning |
|---|---|---|---|
| `DEVOLADA_CREDENTIAL_REJECTED` | 422 | connect | Devolada answered `AUTHENTICATION_ERROR` |
| `DEVOLADA_MODE_NOT_ALLOWED` | 422 | connect | the key's mode is not this environment's (D2) |
| `DEVOLADA_CHANNEL_UNAVAILABLE` | 409 | connect | the business has not configured its CLABE (`clabe`) or bank (`bank`) |
| `DEVOLADA_BUSINESS_SUSPENDED` | 409 | connect | Devolada suspended the business |
| `DEVOLADA_WEBHOOK_CONFLICT` | 409 | connect | another notification address is registered (FR-006) |
| `DEVOLADA_UNAVAILABLE` | 502 (connect), 503 (webhook) | connect, webhook | Devolada unreachable, timed out or answered 5xx |
| `DEVOLADA_PAYMENT_NOT_RESOLVABLE` | 409 | resolve | the action does not apply to that payment now |
| `WEBHOOK_SIGNATURE_INVALID` | 401 | webhook | the signature does not verify against Devolada's keys |
| `WEBHOOK_PAYLOAD_INVALID` | 400 | webhook | malformed or oversized body |

The four `DEVOLADA_*` causes also travel, without an HTTP error, as `payment_link_error` on checkout,
settlement and line-cancel responses.

## The WhatsApp message for a link (client-built `wa.me`, FR-008)

`paymentLinkWhatsAppUrl` in `app-turistear/src/features/pos/delivery.ts` builds it from
`PaymentLinkView` and the sale, normalising the phone like `ticketWhatsAppUrl`. Default text:

> Hola {nombre}, para confirmar tu compra con {empresa} transfiere {monto} desde tu banco con esta
> liga: {liga} — vence {vence}. En cuanto se confirme el pago te enviamos tus boletos.

- `{monto}` goes through the single money formatter (`components/money.ts`, constitution II).
- `{vence}` is the expiry's time in the organization's time zone.
- The message opens in the seller's own WhatsApp; Turistear sends nothing by itself.
