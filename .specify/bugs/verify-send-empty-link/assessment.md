# Bug Assessment: "Verificar y enviar" sends the ticket message with no link on an apartado

- **Slug**: verify-send-empty-link
- **Created**: 2026-10-06
- **Source**: pasted text — a WhatsApp screenshot shared by the developer (conversation from 2026-08-13, org "Descubre Huasca Hgo")
- **Verdict**: valid
- **Severity**: high

## Report (verbatim or summarized)

A tourist books a cabin ("Cabaña Alpina Lp - 5 pax", 2026-08-14 → 2026-08-15, 5 guests), sends a
deposit, and the seller replies *"Resta $1700 en efectivo por favor — a su llegada"* — the sale is an
**apartado** with a pending balance. Minutes later the tourist receives the org's ticket template:

> Hola Maribel Méndez García, te escribe Marcos Noé Hernández Flores de Descubre Huasca Hgo.
> Aquí está tu reserva y tus boletos:
> • Cabaña Alpina Lp - 5 pax · 2026-08-14–2026-08-15 · 5 huéspedes
> Ábrelos (y guarda el enlace) aquí:
> Presenta tu QR en la taquilla 10 minutos antes del evento ¡Buen viaje!

The line where the link belongs is empty. The tourist asks: *"¿Por qué no me sale ni un link?"*

## Symptom

On an apartado (`status = 'booking'`) whose deposit was paid by transfer, the admin's
**Verificar y enviar** opens WhatsApp with the ticket-delivery template and `{portal_link}` filled
with an empty string, then stamps `tickets_sent_at`. Expected: a booking has no tickets yet (they
are minted at settle), so the ticket message must not be sent, and the folio must not read as
"Enviado".

## Reproduction

1. Seller creates an apartado (`down_payment` < total) with `payment_method: 'transfer'` → the folio
   is `booking` with `payment_verification = 'pending'`.
2. Admin opens Ventas; the card's action is `verify` (`folioAction` returns it for any non-cancelled
   folio with a pending verification — booking included).
3. Admin taps **Verificar y enviar**.
4. `POST /api/pos/folios/:id/verify` takes the booking branch: verifies the money, mints **no** QR and
   **no** portal token, returns the folio with `portal_link: null`.
5. The button builds the ticket template with `portalLink: ''`, opens `wa.me` with a link-less
   message, and calls `markTicketsSent` → `tickets_sent_at` is stamped.

Reproduced by code reading; not yet reproduced in a running app. The screenshot matches step 5
character for character (the org template's `{portal_link}` sits right before "Presenta tu QR…").
[NEEDS CLARIFICATION: the deposit's payment method for this folio was not checked in production —
the developer declined (the conversation is old). Only the `verify` path can produce this message:
every other ticket send disables itself when the link is empty.]

## Suspected Code Paths

- `app-turistear/src/features/folios/components/VerifyAndSendButton.tsx:40-57` — the defect. On
  success it unconditionally builds `ticketWhatsAppUrl(..., { portalLink: verified.portal_link ?? '' })`,
  opens it, and calls `markSent.mutate`. It never checks `verified.status` or the link.
- `api-turistear/src/routes/pos/handler.ts:2944-2962` (`verifyPayment`) — correct by design: "A booking
  (deposit) is confirmed but mints no QR — its tickets wait for settle." It returns the folio without a
  link; the client ignores that.
- `app-turistear/src/features/folios/folioCardState.ts:180` — `folioAction` returns `'verify'` for a
  `booking` folio with a pending transfer, so the card offers *Verificar y enviar* on an apartado. The
  verb promises a send that cannot happen for a booking.
- `app-turistear/src/features/pos/delivery.ts:117-121` (`ticketWhatsAppUrl`) — builds a URL even when
  `portalLink` is empty. The other callers guard before calling it (`TicketWhatsAppButton.tsx:41`
  disables on `!portalLink`; `ExpressSalePanel.tsx:167` checks `folio.portal_link`), so the builder
  itself has no defence.
- `api-turistear/src/routes/folios/handler.ts:396` (`markTicketsSentAdmin`) and
  `api-turistear/src/routes/pos/handler.ts:2180` (`markTicketsSent`) — stamp `tickets_sent_at` on any
  folio, including a `booking` with no portal token, so the false "Enviado" is accepted by the server.

## Root Cause Hypothesis

`VerifyAndSendButton` was written for the paid case (US-A84 D13: "verify, open WhatsApp with the
freshly-minted portal link, stamp `tickets_sent_at`"), but `folioAction` also routes **apartados**
with a pending transfer to it. For a booking, `verifyPayment` deliberately mints no link, and the
button sends the ticket template anyway with `{portal_link}` → `''`, then records the delivery.
Confidence: **high**.

## Proposed Remediation

**Preferred**: branch the button on the verified folio.

- `verified.status === 'paid'` and `verified.portal_link` → unchanged (ticket template + mark sent).
- Otherwise (a booking: deposit verified, tickets wait for settle) → do **not** use the ticket
  template and do **not** call `markTicketsSent`. Open WhatsApp with a deposit-confirmation message
  instead — the money was just confirmed, and "¿ya les llegó mi transferencia?" is the inbound this
  verify exists to answer (`verifyPayment` already emits `payment_verified` for it). Text, mirroring
  `BookingWhatsAppButton`: *"Hola {nombre}, te escribe {agente} de {org}. Confirmamos tu anticipo de
  {amount_paid}. Tu saldo pendiente es {pending_balance}; tus boletos se envían al liquidarlo."*
  Toast: *"Anticipo verificado"*.

Defence in depth, same fix:

- `ticketWhatsAppUrl` returns `null` when `portalLink` is empty, so no future caller can send a
  link-less ticket message.
- **Server decides (Constitution IV)**: both mark-sent endpoints refuse a folio that has no portal
  token (`409`), so a client bug can never record a delivery that did not happen.

**Alternatives**:
- *Verify only, no WhatsApp, for a booking* — smallest change; but the customer who asked about their
  transfer gets no answer, and the admin has to open the chat by hand.
- *Hide `verify` on bookings from the card and verify only from the detail* — moves the problem, the
  detail's verify has no send.

**Files likely to change**:
- `app-turistear/src/features/folios/components/VerifyAndSendButton.tsx`
- `app-turistear/src/features/pos/delivery.ts`
- `api-turistear/src/routes/pos/handler.ts` (`markTicketsSent`)
- `api-turistear/src/routes/folios/handler.ts` (`markTicketsSentAdmin`)
- tests below

**Tests to add or update**:
- `app-turistear/src/features/pos/delivery.test.ts` — `ticketWhatsAppUrl` returns `null` for an empty
  portal link.
- `app-turistear/src/features/folios/components/VerifyAndSendButton.test.tsx` (new) — booking verify:
  opens a message without the ticket wording, never calls mark-sent; paid verify: unchanged.
- API (vitest, `api-turistear/test/`) — mark-sent on a `booking` folio with no portal token → `409`,
  `tickets_sent_at` stays null; on a paid folio → `200` (both seller and admin routes).

## Risks & Considerations

- The `409` on mark-sent is a behaviour change: any other client path that marks a link-less folio
  starts failing loudly. Today all of them guard on the link first, so none should.
- Folios already mis-stamped `Enviado` while still bookings stay stamped; when they settle, the
  delivery axis will read "Enviado" for tickets never sent. Not fixed by this change (no backfill);
  noted for the fix report.
- Out of scope, recorded for the lodging-QR spec: a stay has no QR at all, so even a correct link
  lands on a portal with nothing to "presentar en taquilla"; and the apartado hold for a stay runs to
  check-in 00:00 (expiry 23:45 the night before arrival).

## Open Questions

- [NEEDS CLARIFICATION: wording of the deposit-confirmation WhatsApp — the proposed text above, or
  verify-only with no message?]
