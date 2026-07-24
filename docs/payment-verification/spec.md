# Feature: Payment Reference & Admin Verification of Electronic Payments

**User stories:** US-AG41 (agent/affiliate records the payment method + a reference for electronic
transactions at checkout), US-A67 (admin verifies each electronic payment before tickets are
released — a "Por verificar" queue, verify/reject, and one-step delivery). To register in
`docs/SPEC.md`. **Phase:** 2 (Core Enhancements) · **agent/affiliate + admin surface.**

**Depends on:** *POS Checkout* (`confirmSale`, `settle`) — the paid/booking flow this gates ·
*WhatsApp Ticket Delivery* (`docs/whatsapp-qr-delivery/spec.md`, US-AG39/AG40) — the delivery axis
(Pendiente→Enviado→Visto) that now starts only after the money clears · *Agent Cash Balance*
(US-AG25/AG29) — the cash-vs-electronic split already in place · *Cash-Drop Review* (US-A19/A27) —
the admin review-queue + dispute pattern this mirrors · *Total Folio Cancellation* (US-A21) — the
machinery a rejected payment reuses.

> **What & why.** Today a **paid** sale mints QR tickets **immediately and unconditionally**
> (`confirmSale` → `signLineTickets`), no matter the payment method. For a **bank transfer** the
> money isn't actually in hand yet — the agent has only *claimed* it arrived. This feature makes an
> **admin verify every electronic payment** (against the bank, using a **reference** the seller
> records) **before** the customer's tickets are issued/delivered — closing the "tickets handed out
> for a transfer that never landed" hole. Cash is unaffected (the agent holds it; the existing
> cash-drop reconciliation covers it).

---

## Context

**How payment works today.**
- `folios.paymentMethod` is `cash | card | transfer | link` (default `cash`), chosen at checkout via
  a 4-way toggle (`PosCheckoutPage.tsx`). US-AG25/AG29 already treat everything except `cash` as
  **electronic**: no agent cash-debt, commission still earned, the company collects.
- A **full paid** sale signs one QR per slot line at confirm time (`handler.ts` §4, gated only on
  "not a booking"). A **booking** (apartado) mints **no QR** until `settle`. `dispatchTicketEmail`
  (fire-and-forget) and the agent's WhatsApp send both treat a folio as deliverable once `paid`.
- There is **no payment reference** field and **no verification/notification** infrastructure. The
  closest admin pattern is the **cash-drop review queue** (admin reviews/acks/disputes agent drops).

**Key facts that shape this feature:**
- Verification must be **admin-only** — the seller who records a transfer can never verify their own
  money (separation of duties).
- QR signing already has a **deferred** form: bookings sign at `settle`. The same path is reused so
  an unverified electronic folio has **no QR token at all** until cleared (not "signed but withheld").

---

## Decisions (grilled & confirmed)

- **D1 — Method scope: hide `card` + `link` from the checkout toggle; keep `cash` + `transfer`
  only.** The enum values stay in the schema and reports still render historical card/link folios —
  no data migration of methods. ("Transfer" = *transferencia bancaria*, the one in-scope electronic
  method.)
- **D2 — `payment_reference`** (text, nullable). **Required iff `method = transfer`** (trimmed,
  min 4 / max 64 chars — free text, no format regex; bank confirmation numbers vary). Ignored/absent
  for cash. Shared Zod refine: `method === 'transfer' ⇒ reference present`. Recorded by the
  **agent/affiliate** at checkout (and at settle, if settling by transfer).
- **D3 — Verification is a separate, RE-ARMABLE axis, not a new status.** `status` stays `paid`;
  add `payment_verification`: `not_required` (all-cash) · `pending` · `verified`. It **re-arms to
  `pending`** on each new electronic payment — a folio can carry two (a transfer deposit, then a
  transfer settle). Avoids churning every `status` check; a per-payment ledger table was considered
  and rejected as over-scope.
- **D4 — Verification applies to EVERY electronic payment, incl. apartado deposits.** A transfer
  **deposit** reserves spots **immediately** (optimistic — the apartado's purpose) and is queued
  `pending`; it mints no QR (bookings never do pre-settle) but the admin still confirms the money.
- **D5 — The QR invariant: sign only when `status = paid` AND the money that made it paid is
  cleared** (cash, or electronic-`verified`). So: full-cash → sign now; full-transfer → sign on
  verify; cash-settle → sign now; transfer-settle → sign on verify. Deferred signing reuses the
  `settle` path. **`deliverable = paid AND (cash OR verified)`** — the WhatsApp delivery axis
  (Pendiente→Enviado→Visto) doesn't begin until the folio is deliverable.
- **D6 — Reject → cancel the folio.** A bad reference / money-never-arrived reuses `cancelFolio`:
  release spots, claw back the seller's commission, record the admin's reason. Rare; the happy path
  is verify.
- **D7 — Notification = in-app admin queue + badge** ("Por verificar"), modeled on the cash-drop
  review queue and the pending-cancellation badge (`usePendingCancellationCount`). Admin-only
  verify/reject. Each queue item is **labeled by kind** — full sale · deposit · settlement — so the
  admin knows what they're confirming. **External email/WhatsApp ping to the admin is deferred.**
- **D8 — Verify can deliver in one step; the AGENT sends by default.** On verify:
  1. If the folio has an **email**, the server **auto-dispatches the ticket email** (reuses
     `dispatchTicketEmail`) — reliable, no human.
  2. Verification **unlocks the agent's own "Enviar por WhatsApp"** button (previously disabled) —
     **the default delivery path**, since the agent has the customer rapport and sends from their
     own number.
  3. The admin *also* gets an optional **"Verificar y enviar por WhatsApp"** (opens the **admin's**
     WhatsApp pre-filled, stamps `Enviado`) for when the agent isn't around.
- **D9 — Grandfather** every existing `transfer`/`card`/`link` folio → `verified`, every `cash`
  folio → `not_required`. New transfer payments start `pending`.

---

## Data model

`folios` gains (additive migration `0047_payment_verification.sql`):

```ts
// The bank reference for an electronic (transfer) payment — required at checkout/settle when the
// method is 'transfer' (US-AG41). Free text 4–64 chars; null for cash. If a folio takes two transfer
// payments (deposit + settle) this holds the MOST RECENT one awaiting verification.
paymentReference: text('payment_reference'),
// US-A67 — admin verification of electronic money. RE-ARMABLE: 'not_required' for an all-cash folio;
// 'pending' the moment a transfer payment is recorded; 'verified' once an admin confirms it against
// the bank. QR is signed only when the folio is `paid` AND this is 'verified' (or the paying method
// was cash). See D3/D5.
paymentVerification: text('payment_verification', {
  enum: ['not_required', 'pending', 'verified'],
}).notNull().default('not_required'),
paymentVerifiedAt: integer('payment_verified_at', { mode: 'timestamp' }),
paymentVerifiedBy: text('payment_verified_by').references(() => users.id),
```

**Migration backfill (D9):** `payment_verification = 'verified'` where `payment_method != 'cash'`,
else `'not_required'`.

---

## Server changes (`api-turistear/`)

- **`pos/schema.ts`** — `payment_method` accepted set unchanged server-side (still validates the
  enum); add `payment_reference` + the conditional `transfer ⇒ reference` refine to the confirm and
  settle bodies.
- **`confirmSale`** — set `paymentVerification`: `pending` when the paying method is `transfer`
  (full sale **or** deposit), else `not_required`. **Gate QR signing + `dispatchTicketEmail`** on the
  D5 invariant — a `pending` electronic full sale is created **without** QR (defers to verify).
- **`settle`** — if settled by `transfer`, re-arm `paymentVerification = 'pending'`, record the new
  `paymentReference`, and **defer** QR/email to verify; a cash settle signs immediately as today.
- **New `verifyPayment` handler** (`POST /pos/folios/:id/verify` or under the admin folios router,
  admin-only): `pending → verified`, stamp `paymentVerifiedAt/By`; if the folio is now
  `paid`, **sign QR** (reuse `signLineTickets`) and **auto-dispatch the ticket email** if an email
  exists; return the folio incl. `qr` echoes so the UI can render/deliver. Idempotent on an
  already-`verified` folio.
- **New `rejectPayment` handler** (admin-only): delegates to the existing cancellation machinery
  (release spots, commission clawback, reason) — D6.
- **Reads** — `readFolio` / `listFolios` / `listAgentFolios` expose `payment_reference`,
  `payment_verification`, `payment_verified_at`, and update `deliverable = paid AND
  (method==='cash' OR payment_verification==='verified')`.
- **New admin list filter** — `GET /folios?verification=pending` (or a count endpoint) for the
  "Por verificar" queue + badge.

## Client changes (`app-turistear/`)

- **`PosCheckoutPage`** — the toggle shows **Efectivo + Transferencia** only (card/link removed from
  the group). Selecting Transferencia reveals a **required "Referencia"** field (4–64). On submit
  for a transfer, the confirmation UI reads **"Pago en verificación — los boletos se envían al
  confirmar"**; the receipt shows no QR yet.
- **Delivery buttons** (`TicketWhatsAppButton`, email resend) — **disabled with a tooltip**
  ("Pendiente de verificación del pago") while `payment_verification === 'pending'`; enabled once
  `verified`. The agent's WhatsApp send is the default path (D8).
- **Admin "Por verificar" queue** — a folios filter/tab + a **nav badge** (reuse the
  `usePendingCancellationCount` pattern). Each row shows seller, amount, method, **reference**, and
  kind (venta / apartado / liquidación). Actions: **Verificar**, **Verificar y enviar por WhatsApp**
  (admin's phone), **Rechazar** (reason → cancel).
- **Services/hooks** — `verifyPayment` / `rejectPayment` clients + `useVerifyPayment` /
  `useRejectPayment`; extend the folio types with the new fields.

---

## Acceptance criteria

**US-AG41 (agent/affiliate — record method + reference)**
1. Checkout offers **only** Efectivo + Transferencia; card/link are not shown.
2. Choosing Transferencia **requires** a reference (4–64 chars); submitting without it → validation
   error (client + `400` server-side). Cash needs no reference.
3. The recorded method + reference persist on the folio and show on its detail.

**US-A67 (admin — verify/reject + deliver)**
4. A **full transfer** sale is created `paid` + `payment_verification = 'pending'` with **no QR**;
   it appears in the admin "Por verificar" queue with its reference; the seller's delivery buttons
   are disabled.
5. **Verify** → `verified`, QR is signed, the ticket **email auto-sends if an email exists**, and the
   agent's WhatsApp send unlocks. **"Verificar y enviar por WhatsApp"** additionally opens the
   admin's WhatsApp and stamps `Enviado`.
6. A **transfer deposit** on an apartado reserves spots and is queued `pending`; verifying it mints
   **no** QR (still a booking). Settling that apartado **by transfer** re-arms `pending`; verifying
   the settlement signs the QR.
7. **Reject** → the folio is cancelled (spots released, commission clawed back, reason recorded).
8. **Cash** folios never enter the queue (`not_required`) and deliver exactly as today.
9. **Isolation** — an admin only sees/verifies their own org's folios (`seedTwoOrgs`).
10. Existing (pre-migration) transfer/card/link folios are `verified` (deliver unchanged); cash are
    `not_required`.

## Definition of Done

- Migration `0047` applied local + remote; `cf-typegen` clean.
- Tests: reference-required-on-transfer (confirm + settle); QR withheld until verify; verify signs +
  auto-emails; deposit vs settle re-arm; reject → cancel/clawback/spots; cash unaffected; cross-org
  isolation (`seedTwoOrgs`); grandfather backfill. Full API suite green.
- `pnpm build:app` + `pnpm lint:app` clean; checkout + admin queue verified end-to-end.
- Registered in `docs/SPEC.md` (US-AG41 + US-A67 + a Phase-2 feature entry).
