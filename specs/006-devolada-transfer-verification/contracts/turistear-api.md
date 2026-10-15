# Contract: Turistear API changes

**Feature**: `specs/006-devolada-transfer-verification`. **Decisions**: research D1–D20.

**Base URL**: `https://api.turistearya.com/api`; dev: `https://api-dev.turistearya.com/api`; a pull request's preview: `https://api-guideme-pr-<n>.<subdomain>.workers.dev/api`.

Conventions are those of the existing API:
- **Sessions**: the Better Auth session cookie (`__Secure-<AUTH_COOKIE_PREFIX>.session_token`, HttpOnly), read by `authMiddleware`. The app sends every request with `credentials: 'include'` (constitution IV).
- **Methods**: `GET`, `POST`, `PUT` and `DELETE` only, the ones the API's CORS policy allows (`api-turistear/src/index.tsx:62-73`).
- **Successes**: answer under a named key.
- **Failures**: answer `{ "error": { "code", "message" } }`; clients branch on `code` (constitution IV).
- **Instants**: epoch **seconds** (`utils/folioDetail.ts:58`).
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
| `link_failed` | state `failed` or `abandoned` | Sin enlace de pago — verificar a mano | warning |
| `confirmed` | payment `confirmed` | Pago confirmado | paid |
| `unapplied` | payment `unapplied`, or `confirmed` on a cancelled sale | Dinero recibido sin venta | warning |
| `partial` | payment `partial` | Pago incompleto | warning |
| `invalid` | payment `invalid` | Banxico no confirma la transferencia | error |
| `not_received` | payment `expired`, or state `expired` | No se recibió la transferencia | error |
| `closed` | state `closing` or `closed`, no payment | Enlace cerrado | neutral |
| `credit_paused` | payment `queued_for_credit` | Verificación en pausa | warning |
| `needs_tracking_key` | payment `validating` with `awaiting` | Pide al cliente su clave de rastreo | warning |
| `validating` | payment `validating` | Verificando pago | pending |
| `awaiting_payment` | state `open`, no payment | Esperando pago | pending |

Every chip pairs its colour with an icon and the text (constitution VII). The state of money being
checked always uses the word the UI already has, *verificación*; «validar» never appears in the UI.
The link is an *enlace*, the word the customer's ticket message already uses; «liga» and «link»
never appear (research D16).

### Action copy — one verb per action (constitution VII, research D15, D16)

| Where | es-MX copy |
|---|---|
| Ajustes card, title | Cobro con Devolada |
| Ajustes card, status | Conectada · Con fallas (`broken`) · Sin conectar (`disconnected`, or never connected) |
| Ajustes card, mode | Real · Prueba |
| Ajustes card, key hint | Clave …abcd |
| Ajustes card, health | Avisos funcionando · Avisos con fallas · Verificación en pausa · Avisos: solo revisión periódica (when `is_ours` is `null`) |
| Ajustes card, last verdict | Último veredicto: {fecha y hora} |
| Ajustes, the reference switch while connected | Con Devolada conectado, las transferencias se cobran con enlace de pago |
| Connect sheet, field and submit | Clave de API de Devolada · Conectar |
| Address conflict, confirm | ¿Reemplazar la dirección de avisos? |
| Disconnect, confirm | ¿Desconectar Devolada? |
| Payment link card, title | Enlace de pago |
| Payment link card, expiry, only while the link is open | Vence hoy a las HH:MM · Vence mañana a las HH:MM |
| Payment link card, primary action | Cobrar por WhatsApp |
| Link not created (alert) | No se pudo crear el enlace de pago; un administrador verificará la transferencia |
| Link too short (alert, `PAYMENT_LINK_TOO_SHORT`) | Ya no hay tiempo para cobrar con enlace; un administrador verificará la transferencia |
| Checkout and SettleSheet, connected | Se generará un enlace de pago para cobrar por WhatsApp |
| Settlement link open, BookingActions chip | Liquidación en verificación |
| Line cancellation or settlement refused (`SETTLEMENT_IN_PROGRESS`) | La venta ya tiene un enlace de pago para liquidar; espera su resultado |
| Line cancel replaced the link | El enlace de pago cambió — vuelve a enviarlo |
| Settlement exception, accept | Verificar |
| Settlement exception, dismiss | Descartar (the sale stays an apartado; unlike «Rechazar pago», it cancels nothing) |
| Unapplied money, returned | Ya lo devolví |
| Receipt header while the money is unverified | Pago en verificación (instead of «Venta confirmada» and the «Pagado» chip) |
| Sale detail header while Devolada handles the sale (`verification_auto`) | the link's chip, instead of «Por verificar», which names the admin's work |
| Payment breakdown, a pending row while Devolada handles the sale (`verification_auto`) | En verificación (instead of «Por verificar») |
| Payment breakdown, pending row of a sale cancelled with `payment_not_received` | No recibido |
| Cancellation source `payment_not_received` | No se recibió la transferencia |
| Timeline `payment_link_issued` · `payment_link_closed` | Enlace de pago creado · Enlace de pago cerrado |
| Timeline `payment_verdict` | the status's copy from § Labels |
| Timeline `transfer_not_received` | No se recibió la transferencia — venta cancelada |
| Timeline `payment_verified` from Devolada | Transferencia verificada por Devolada · Comprobante {receipt_number} |

The connect sheet maps each refusal to copy. A broken connection's reason reuses the first three:

| `code` | es-MX copy |
|---|---|
| `DEVOLADA_CREDENTIAL_REJECTED` | Devolada rechazó la clave |
| `DEVOLADA_BUSINESS_SUSPENDED` | Devolada suspendió tu negocio |
| `DEVOLADA_CHANNEL_UNAVAILABLE` | Completa en Devolada la configuración de cobro de tu negocio |
| `DEVOLADA_MODE_NOT_ALLOWED` | Esta clave no corresponde a este ambiente (real o de prueba) |
| `DEVOLADA_UNAVAILABLE` | No pudimos contactar a Devolada; intenta de nuevo |
| `VALIDATION_ERROR` | Revisa la clave: empieza con dk_ |
| `INTERNAL_ERROR` | Devolada no está disponible en este ambiente |
| `DEVOLADA_WEBHOOK_CONFLICT` | opens «¿Reemplazar la dirección de avisos?» with the current address |

### `OrganizationDevoladaSummary` — on `GET /organizations/me`, every role

```json
"devolada": { "status": "not_connected", "mode": null }
```

- `status`: `not_connected` · `connected` · `broken` · `disconnected`.
- `mode`: `real` · `test` · `null`.
- It never carries the credential, its hint or the notification address. Agents read this payload (D1).

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
- `webhook.is_ours` is `null` where this environment registers no address (`DEVOLADA_WEBHOOK_URL` empty: local and pull-request previews). There, verdicts arrive only through the sweep, which is expected rather than a failure (research D3, D17).

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
| 500 | `INTERNAL_ERROR` | this environment cannot encrypt the key: `DEVOLADA_CREDENTIAL_KEY` is missing or malformed (research D17). Nothing is called at Devolada |
| 502 | `DEVOLADA_UNAVAILABLE` | Devolada unreachable, timed out or answered 5xx |

#### `DELETE /organizations/me/devolada` — disconnect

- 200 `{ "connection": DevoladaConnectionView | null }`, with status `disconnected`.
- Idempotent. Links already issued are followed to their verdict (FR-004), and the credential is erased once none is left (D12).

### Checkout and settlement — sellers (agents) and admins

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

- `payment_link_error` is present only when `payment_link` is `null`. Its values are `DEVOLADA_UNAVAILABLE`, `DEVOLADA_CREDENTIAL_REJECTED`, `DEVOLADA_BUSINESS_SUSPENDED`, `DEVOLADA_CHANNEL_UNAVAILABLE`, and `PAYMENT_LINK_TOO_SHORT` when the link would stay open less than 15 minutes (research D7). That last one writes no link and calls nothing at Devolada.
- The sale then stays on today's manual path (FR-010).
- These values are a fallback signal, not an HTTP error: the request succeeded.
- The idempotent replay (200 `{ folio, replayed: true }`) returns the sale with `payment_links`.

#### `POST /pos/folios/:id/settle` and `POST /pos/folios/:id/lines/:lineId/settle`

For a connected organization with `"method": "transfer"`, no settlement is recorded (D8):

```json
{ "folio": { "…": "still an apartado" }, "payment_link": "PaymentLinkView | null", "payment_link_error": "…" }
```

- **Link already open** (one per sale, D8): a transfer settlement for the same line, or for the whole sale, returns that link. A settlement for another line answers 409 `SETTLEMENT_IN_PROGRESS`.
- **Link cannot be created**: today's manual settlement is recorded instead, and `payment_link_error` says why (FR-010), `PAYMENT_LINK_TOO_SHORT` included, as for a settlement after departure.
- **Guards and error codes**: as today (`ALREADY_SETTLED`, `FOLIO_CANCELLED`, `BOOKING_EXPIRED`, …).
- **Cash settlement while a settlement link is open**: it closes the link (D13), unless the link's payment is in flight, which answers 409 `SETTLEMENT_IN_PROGRESS` (FR-011).
- **Until PR 3**, nothing closes a settlement link yet, so any settlement other than the same transfer answers 409 `SETTLEMENT_IN_PROGRESS` while one is open (research D19).

#### Line cancellations — `POST /pos/folios/:id/lines/:lineId/cancel` (agent), `POST /folios/:id/lines/:lineId/cancel` (admin)

- **Replaced link**: when the apartado had an open settlement link, the response adds `"payment_link"` (the replacement for the new balance, D13), or `null` plus `"payment_link_error"`.
- **Refused**: 409 `SETTLEMENT_IN_PROGRESS` while that link's payment is in flight (FR-011). Until PR 3, while it is open at all (research D19).
- Otherwise unchanged.

### Reads

| Endpoint | Change |
|---|---|
| `GET /pos/folios/:id`, `GET /folios/:id` | `folio.payment_links: PaymentLinkView[]`, newest first; `folio.verification_auto` and `folio.devolada_attention` (booleans, D14) |
| `GET /pos/folios`, `GET /folios` | each row gains `payment_link: PaymentLinkView | null` (the latest unresolved link, otherwise the latest), `verification_auto: boolean` and `devolada_attention: boolean`. Devolada attention items join the pending-work set, so they are listed whatever their age (D14) |
| `GET /folios/counts` | adds `verification_auto` (sales Devolada is handling with nothing for the admin to do) and `devolada_attention` (sales needing the admin that `verification` does not already count). Each sale counts once: «Por verificar» = `verification − verification_auto + devolada_attention`, in the badge, the pending-work bar and Hoy. Admin badge = that number + `folio_requests` |
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

Sale and deposit exceptions use today's `POST /pos/folios/:id/verify` and `/reject` (FR-018). From PR 3, `/reject` closes the sale's links. `/verify` closes the links of the rows it verifies, except one whose payment is in flight, which stays open until its verdict (D13).

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
| 503 | `DEVOLADA_UNAVAILABLE`: keys or the re-read unreachable, or the organization's credential unreadable here (research D17) | failed attempt, retried |
| 500 | `INTERNAL_ERROR` | failed attempt, retried |

## Error codes (spec FR-023 — constitution IV)

The spec declares them (FR-023). Each is added to the `ErrorCode` union in `api-turistear/src/types/errors.ts`.

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
| `SETTLEMENT_IN_PROGRESS` | 409 | settle, line cancel | the apartado's balance is being collected by an enlace: its payment is in flight, or the request is for another line (D8, D13). Until PR 3, any open settlement link (D19) |
| `PAYMENT_LINK_TOO_SHORT` | — | checkout, settle, line cancel | never an HTTP error: the link would stay open less than 15 minutes, so none was created (D7) |

The four `DEVOLADA_*` causes, and `PAYMENT_LINK_TOO_SHORT`, travel without an HTTP error as
`payment_link_error` on checkout, settlement and line-cancel responses.

## The WhatsApp message for a link (client-built `wa.me`, FR-008)

The action that sends it is labelled **«Cobrar por WhatsApp»**: sending the link is collecting the
payment, and *Cobrar* is the canonical verb for that (constitution VII, research D16).
`paymentLinkWhatsAppUrl` in `app-turistear/src/features/pos/delivery.ts` builds it from
`PaymentLinkView` and the sale. It goes through the same phone normalisation as `ticketWhatsAppUrl`,
and returns `null` for an unusable phone. The texts are shipped defaults, one per link kind, that
the organization does not edit, like `DEPOSIT_VERIFIED_TEMPLATE`:

| `kind` | Default text |
|---|---|
| `sale` | Hola {customer_name}, te escribe {agent_name} de {org_name}. Para confirmar tu compra, transfiere {link_amount} desde tu banco con este enlace: {payment_link} (vence {link_expires}). En cuanto se confirme el pago te enviamos tus boletos. |
| `deposit` | Hola {customer_name}, te escribe {agent_name} de {org_name}. Para apartar tu reserva, transfiere el anticipo de {link_amount} desde tu banco con este enlace: {payment_link} (vence {link_expires}). Tus boletos se envían al liquidar el saldo de {pending_balance}. |
| `settlement` | Hola {customer_name}, te escribe {agent_name} de {org_name}. Para liquidar tu reserva, transfiere {link_amount} desde tu banco con este enlace: {payment_link} (vence {link_expires}). En cuanto se confirme el pago te enviamos tus boletos. |

- `{customer_name}`, `{agent_name}`, `{org_name}` and `{pending_balance}` are `fillTemplate`'s tokens, filled as in every other message.
- `{link_amount}` is the link's `amount`, through the single money formatter (`components/money.ts`, constitution II).
- `{payment_link}` is the link's `url`.
- `{link_expires}` reads «hoy a las HH:MM» or «mañana a las HH:MM» in the organization's time zone. A link lives at most 24 h, and at least 15 minutes (research D7).
- A deposit's text never promises tickets, because an apartado's tickets wait for its settlement (bug `verify-send-empty-link`).
- The message opens in the seller's own WhatsApp; Turistear sends nothing by itself.
