# Feature: Client Ticket Delivery via Email (US-AG09, US-C01, US-C03)

## Context

When an agent confirms a sale, the client should **automatically receive** a transactional
email containing:
- A **purchase receipt** (folio ID, services, amounts, payment method).
- An **itinerary** (service name, date, start time, quantity per service).
- A **QR code image per service line** — the same HMAC-signed token the scanner reads, so
  the tourist can present the email as their access ticket.

When an admin **cancels** a folio, the client should receive a cancellation notification
so they know their booking is no longer active.

**User Stories covered:**
- **US-AG09** — *As an agent, I want the client to automatically receive their purchase
  receipt, itinerary, and QR code via Email upon confirming the sale.*
- **US-C01** — *As a client, I want to automatically receive a purchase receipt via Email
  with details of my service, schedule, and amount paid at the time of sale.*
- **US-C03** — *As a client, I want to receive an Email notification if my folio is
  cancelled to know that my booking is no longer active.*

**Builds on:**
- **POS `confirmSale`** (`src/routes/pos/handler.ts`) — the email is sent after the D1
  batch commits; `customer_email` is captured on the folio at POS.
- **Total Folio Cancellation `cancelFolio`** (`src/routes/folios/handler.ts`) — the single
  integration seam documented in `docs/TECH_DEBT.md §11`. This feature closes that debt.
- **Resend service** (`src/services/resend.ts`) — already wired; `RESEND_API_KEY` and
  `RESEND_FROM` exist in `CloudflareBindings`.
- **QR tokens** — already signed and stored in `folio_lines.qr_token` (HMAC-SHA256,
  `src/utils/qr.ts`). No new signing — we embed the stored token as a QR image.
- **`folios.customer_email`** — the delivery address (nullable); captured at POS via
  `ConfirmSaleInput.customer_email`. No schema change needed.

### Scope boundary

| Concern | Owner |
|---|---|
| **Confirmation email + QR images on sale** (US-AG09, US-C01) | **This feature** |
| **Cancellation notification** (US-C03) | **This feature** — hooks into the `cancelFolio` seam |
| **Tourist self-service portal** (Magic Link, itinerary view, cancellation request, Refund PIN) | Phase 2 (US-T01–T05) — the Magic Link email depends on this feature for the delivery channel |
| **Re-send receipt on demand** (US-AG22) | Phase 2 — deferred, per SPEC |
| **QR token minting or signing** | POS (existing) — this feature only embeds already-signed tokens |
| **Offline QR validation** | Phase 2 (US-AG16) — scanner feature |
| **Resend email account / sender-identity setup** | Ops task (pre-deployment) — not in code |

**No new API endpoints.** Email delivery is a side effect of the existing
`POST /api/pos/folios` (confirmation) and `POST /api/folios/:id/cancel` (cancellation).

---

## Data Model

**No new tables. No new columns. No migration.**

All required data is already on the existing schema:
- `folios`: `customer_name`, `customer_email`, `customer_phone`, `total`, `amount_paid`,
  `payment_method`, `status`, `cancellation_reason`, `cancelled_at`
- `folio_lines`: `service_name` (snapshot), `slot_date`, `slot_start_time`, `quantity`,
  `unit_price`, `line_total`, `qr_token`
- `folio_line_extras`: `name`, `price`, `quantity`
- `organizations`: `name` — queried once per send to personalize the email subject/body

---

## Business Rules

1. **Fire-and-forget via `waitUntil`.** Email is sent **after** the D1 batch commits. A
   Resend error is caught, logged (`console.error`), and **does not fail** the HTTP
   response. The folio/cancellation is the authoritative event; the email is a
   notification. The `201` / `200` response is returned regardless of whether the email
   send succeeds.

   **Workers constraint:** the send must **not** be a bare floating promise. On Cloudflare
   Workers, any in-flight I/O started before `return c.json(...)` can be cancelled once the
   response is returned, silently dropping the email under load. The send MUST be handed to
   `c.executionCtx.waitUntil(...)` so the runtime keeps the request alive until it
   completes, while the response is still returned immediately (not blocked on Resend):
   ```ts
   c.executionCtx.waitUntil(
     sendTicketConfirmationEmail(c.env, emailData).catch((err) =>
       console.error('[email] confirmation send failed', folioId, err),
     ),
   )
   ```
   This supersedes the ambiguous "awaited" wording in earlier drafts of the Definition of
   Done — do **not** `await` the send (that would block checkout on the external HTTP call);
   use `waitUntil`.

2. **`customer_email` is mandatory at POS.** Because email is the **only** ticket-delivery
   channel in Phase 1 (the self-service portal is Phase 2), a sale without a deliverable
   address would produce an undeliverable ticket. `confirmSaleSchema` therefore requires a
   **format-valid** `customer_email` (`z.string().trim().email()`); a sale without it — or
   with a malformed address — is rejected with `400 VALIDATION_ERROR` **before** any folio
   is written. The POS UI mirrors this (required, format-validated field; the *Confirmar
   venta* button is disabled until a valid email is present).

   The DB column stays nullable, so the **send guard remains** (`if (customer_email) …`) as
   defense for legacy/direct-data folios (e.g. an old row, or the cancellation of a folio
   whose email was later nulled). When the guard sees no address it skips the send silently
   — no error, no log. In normal POS flow the address is always present.

3. **One email per folio.** All service lines and their QR codes are bundled in a single
   email. Never one email per line.

4. **QR code as image — external generation.** The `qr_token` is already the string that
   a scanner reads. For the email, a QR code image is generated via an external service:
   ```
   https://api.qrserver.com/v1/create-qr-code/?size=250x250&ecc=M&data={encodeURIComponent(qr_token)}
   ```
   This produces a PNG `<img>` the email client fetches on open — no additional library,
   no new Cloudflare binding. Noted as a third-party dependency in TECH_DEBT.

5. **Org name in email.** The org name (`organizations.name`) is fetched from the DB once
   per send and included in the subject line and body so the client sees the tour
   company's name, not "Turistear Ya!". This is one extra DB read per email; acceptable at MVP scale.

6. **No delivery status tracking.** This is MVP — email send state is monitored via the
   Resend dashboard, not stored in D1. A `sent_at` column or delivery log is not added.

7. **Cancellation email uses already-available data.** By the time `cancelFolio` returns,
   the folio's customer info and service names (from `folio_lines`) are already in memory
   from the `readFolio` call. No extra DB query is needed for the cancellation email.

8. **RESEND_API_KEY guard.** If `env.RESEND_API_KEY` is an empty string (test environment
   without the binding set), the send is skipped. This prevents test suites from
   attempting external HTTP calls in the existing POS / cancellation tests.

9. **Escape user-controlled fields in HTML.** `customer_name`, `cancellation_reason`,
   `service_name`, and `org_name` are interpolated into HTML template strings. The first
   two are free-text entered at POS / cancellation. Every dynamic value MUST pass through a
   small `escapeHtml()` helper (`& < > " '` → entities) before interpolation. Without it, a
   name or reason containing `<`, `>`, or `&` breaks email rendering, and injected markup
   (e.g. a rogue `<a href>`) enables in-email phishing. Email clients sandbox scripts so
   this is not XSS, but escaping is a one-line robustness/anti-phishing safeguard. The
   already-trusted, system-generated values (folio id, amounts, dates) do not need it.

10. **QR token is a live credential — treat the external image URL as a token leak.** The
    `qr_token` embedded in the `api.qrserver.com` GET URL **is** the HMAC-signed, redeemable
    access credential. qrserver.com, its logs, and any network intermediary therefore see a
    valid ticket. Because Phase-1 validation is online and a token stays redeemable until all
    its passes are consumed, a leaked token is a real exposure (someone else could redeem a
    pass). This is the primary reason to self-host the QR image (see TECH_DEBT), ahead of
    mere third-party reliability — track it as a **security** item, not just availability.

---

## Email Templates

Both templates are written in Spanish (consistent with the rest of the transactional
emails in `resend.ts`) and follow Turistear Ya!'s minimal HTML style.

### Confirmation email (US-AG09 / US-C01)

| Field | Value |
|---|---|
| **To** | `folio.customer_email` |
| **Subject** | `Tu reserva está confirmada — {org_name}` |
| **From** | `env.RESEND_FROM` (same sender identity as all Turistear Ya! emails) |

**Body structure:**
```
Hola {customer_name | "cliente"},

Tu compra ha sido confirmada. Aquí están los detalles de tu reserva:

Folio: {folio_id_short}        Fecha: {created_at}
Método de pago: {Efectivo | Tarjeta}

--- POR CADA LÍNEA DE SERVICIO ---

🎫 {service_name}
   Fecha: {slot_date}   Hora: {slot_start_time}
   Personas: {quantity}   Precio: {unit_price × quantity}
   [extras if any: "  + {extra_name} (×qty): {price}"]

   [QR code image]
   Presenta este código QR al llegar al servicio.

--- FIN DE LÍNEAS ---

TOTAL PAGADO: {total}

{org_name}
Servicio gestionado por Turistear Ya!
```

**QR image tag per line:**
```html
<img
  src="https://api.qrserver.com/v1/create-qr-code/?size=250x250&ecc=M&data={encodeURIComponent(line.qr_token)}"
  alt="Código QR — {line.service_name}"
  width="250" height="250"
/>
```

### Cancellation notification (US-C03)

| Field | Value |
|---|---|
| **To** | `folio.customer_email` |
| **Subject** | `Tu reserva ha sido cancelada — {org_name}` |

**Body structure:**
```
Hola {customer_name | "cliente"},

Lamentamos informarte que tu reserva ha sido cancelada.

Folio: {folio_id_short}

Servicios cancelados:
  • {service_name} — {slot_date} {slot_start_time} (×{quantity})
  [repeat per line]

{reason_block: "Motivo: {cancellation_reason}" — only if reason is set}

Si tienes alguna pregunta, comunícate directamente con {org_name}.

{org_name}
Servicio gestionado por Turistear Ya!
```

---

## Scenarios

### Confirmation email (US-AG09, US-C01)

#### Scenario 1 — Email sent when customer_email is provided
**Given** an agent confirming a sale with `customer_email: "juan@example.com"` and two
service lines (each with a `qr_token`)
**When** `POST /api/pos/folios` succeeds and the D1 batch commits
**Then** Resend is called once with `to = "juan@example.com"`, the HTML body contains
two QR code `<img>` tags (one per line) and the folio totals. The `201` response is
returned normally.

#### Scenario 2 — Sale without (or with malformed) customer_email is rejected
**Given** an agent confirming a sale **without** `customer_email`, or with a malformed
address (e.g. `"not-an-email"`)
**When** `POST /api/pos/folios` is called
**Then** the request is rejected with `400 VALIDATION_ERROR`, **no folio is written**, and
Resend is **not called**. (Email is mandatory at POS — Business Rule 2.)

#### Scenario 3 — Email failure does not roll back the sale
**Given** Resend returns a non-2xx response (or throws a network error)
**When** `POST /api/pos/folios` succeeds (D1 batch committed)
**Then** the error is caught and logged; the folio still returns `201` with the correct
body. The folio and inventory decrements are persisted correctly.

#### Scenario 4 — Multi-service folio: one email, all QR codes
**Given** a sale with three service lines
**When** the confirmation email is sent
**Then** exactly **one** Resend call is made, and the HTML body contains **three** QR
code images (one per line, each with the correct `qr_token`).

#### Scenario 5 — No email when RESEND_API_KEY is not set (test guard)
**Given** `env.RESEND_API_KEY` is an empty string
**When** `confirmSale` is called with a `customer_email`
**Then** the send is skipped silently; the folio returns `201` normally.

### Cancellation notification (US-C03)

#### Scenario 6 — Cancellation email sent when customer_email is present
**Given** a folio with `customer_email: "juan@example.com"` that is cancelled by an admin
**When** `POST /api/folios/:id/cancel` succeeds (batch committed)
**Then** Resend is called once with `to = "juan@example.com"`, the HTML body contains
the list of cancelled services. The `200` response is returned normally.

#### Scenario 7 — No email when customer_email absent on cancelled folio (defensive)
**Given** a folio whose `customer_email` is `null` (legacy/direct data — POS now always
captures one) being cancelled
**When** `POST /api/folios/:id/cancel` succeeds
**Then** the send guard skips it: Resend is **not called**, and the `200` response is
returned normally. (Tested by nulling the column on a normally-created folio, then
cancelling.)

#### Scenario 8 — Cancellation email failure does not fail the cancellation
**Given** a Resend error occurs when sending the cancellation notification
**When** `POST /api/folios/:id/cancel` succeeds (D1 batch committed)
**Then** the error is caught and logged; the cancellation returns `200` with the cancelled
folio. Inventory has been released correctly.

#### Scenario 9 — Cancellation reason included when set
**Given** an admin cancels a folio with `{ "reason": "Cliente no se presentó" }` and the
folio has a `customer_email`
**When** the cancellation email is sent
**Then** the HTML body includes the cancellation reason text.

#### Scenario 10 — Cancellation reason omitted when null
**Given** an admin cancels a folio with no `reason` and the folio has a `customer_email`
**When** the cancellation email is sent
**Then** the HTML body does **not** include a "Motivo:" section (no null or empty line).

---

## Definition of Done

### Backend
- [ ] `pos/schema.ts`: `customer_email` is required + format-validated
      (`z.string().trim().email()`) — Business Rule 2
- [ ] `src/services/resend.ts`: `sendTicketConfirmationEmail(env, data)` and
      `sendCancellationEmail(env, data)` added; typed input interfaces defined
- [ ] `pos/handler.ts` (`confirmSale`): after `db.batch` commits, if
      `input.customer_email` is set and `env.RESEND_API_KEY` is non-empty, send the
      confirmation email via `c.executionCtx.waitUntil(send(...).catch(log))` (Business
      Rule 1 — not bare-floating, not `await`)
- [ ] `folios/handler.ts` (`cancelFolio`): after `db.batch` commits, if
      `folio.customer_email` is set and `env.RESEND_API_KEY` is non-empty, send the
      cancellation notification (same `waitUntil` fire-and-forget pattern)
- [ ] `resend.ts`: `escapeHtml()` helper applied to `customer_name`,
      `cancellation_reason`, `service_name`, `org_name` before HTML interpolation
      (Business Rule 9)
- [ ] Scenarios 1–11 covered in `test/email/client-ticket-delivery.test.ts`
      (Resend `fetch` mocked via `vi.spyOn(globalThis, 'fetch')`), including Scenario 2/2b
      (sale rejected without/with malformed email) and Scenario 11 (HTML escaping)
- [ ] Existing suites that create folios via POS (`pos-controlled-discount`,
      `folio-qr-signing`, `online-qr-scanner`, `folio-cancellation`) updated to send a
      valid `customer_email`; full `pnpm --filter api-turistear test` green
- [ ] `pnpm --filter api-turistear test` green; `pnpm build:app` clean

### Frontend
- [ ] `PosCheckoutPage`: `customer_email` is a **required**, format-validated field; the
      *Confirmar venta* button is disabled until a valid email is present (mirrors the
      backend rule, gives the agent immediate feedback).
- [ ] Optional enhancement: POS confirm success screen shows a subtle
      "Recibo enviado a {customer_email}" helper text (already present on `FolioReceiptPage`).

### Docs
- [ ] `docs/SPEC.md` SHOULD-HAVE item ticked: **Sending receipt and QR code to client
      via Email (Resend)** *(US-AG09, US-C01, US-C03)*
- [ ] `docs/TECH_DEBT.md` §11 (Client Cancellation Email Not Sent) marked **✅ RESOLVED**
- [ ] `docs/TECH_DEBT.md`: new entry for the **QR-image external-service dependency**
      (api.qrserver.com) — acceptable at MVP, action if revisited: self-host a
      `/api/qr/:token.png` endpoint using a WebAssembly QR library
