# Bug Assessment: customer messages say «folio», and the outbox sends them with holes

- **Slug**: payment-rejected-folio-copy
- **Created**: 2026-10-16
- **Source**: pasted text — defect 11 of `specs/006-devolada-transfer-verification/research.md` § Defects (tasks.md T077)
- **Verdict**: valid
- **Severity**: medium

## Report (verbatim or summarized)

> 11. The `payment_rejected` customer message, which D11 reuses, says «tu folio…» where constitution
> VII says «Venta»; so does the approved-cancellation message just above it.
> `src/utils/notifications.ts:74-81`. Because D11 newly sends `payment_rejected`, this one goes
> through the lite path **before PR 2** ships, not after the feature (T077).

## Symptom

The customer messages for an approved cancellation, a rejected payment and a completed refund call
the sale «folio». Constitution VII names it once, for every screen and message. These messages
are also composed with holes: the outbox's WhatsApp composer drops every placeholder it cannot
fill. The approved cancellation therefore reaches the customer as «…aprobamos la cancelación de
tu folio en . Te contamos…». Expected: the customer's own word for what they bought, «tu compra»
as `payment_verified` already says it. The organization's name and the seller's signature should
be filled in, never cut out.

## Reproduction

1. As an admin, reject a pending transfer: `POST /api/pos/folios/:id/reject`. This writes a
   `payment_rejected` row to the outbox, WhatsApp `pending` (`routes/pos/handler.ts:3121`).
2. Open the outbox (`/outbox`, `OutboxPage`) and tap the row's send. The `wa.me` text is
   `composerText(row)` (`app-turistear/src/pages/OutboxPage.tsx:34-39`).
3. Read the text: «Hola Ana, no pudimos confirmar el pago de tu folio , así que tuvimos que
   cancelarlo. Si crees que es un error, escríbeme. —». The word «folio» is wrong, and the
   `{folio_ref}` and `{agent_name}` placeholders were cut.
4. The same holds for an approved cancellation, `cancellation_approved`: «…la cancelación de tu
   folio en . Te contamos enseguida cómo queda.». It also holds for `refund_completed`: «…tu
   reembolso del folio en . Pagaste , te devolvimos y se retuvo según…».

## Suspected Code Paths

- `api-turistear/src/utils/notifications.ts:71-82` — the `cancellation_approved` and
  `payment_rejected` templates, «tu folio {folio_ref}».
- `api-turistear/src/utils/notifications.ts:119-125` — the `refund_completed` template, «tu
  reembolso del folio {folio_ref}». This is the same defect, and the report did not list it.
- `app-turistear/src/features/folios/refundReceipt.ts:28` — the refund receipt the admin sends
  right after confirming a refund, «confirmamos tu reembolso del folio ABCD1234». This is the
  client copy of the same sentence.
- `app-turistear/src/pages/OutboxPage.tsx:33-39` — `composerText` fills `{customer_name}` and
  deletes every other placeholder. The outbox row (`api-turistear/src/routes/notifications/handler.ts:39-56`)
  carries the raw `template`, the customer's name and phone, and nothing else a template names:
  - no `{org_name}` and no `{agent_name}`;
  - no `{folio_ref}`;
  - no money for `refund_completed`.
- `api-turistear/src/utils/notifications.ts` § `EVENTS` — five of the nine templates name a
  placeholder beyond `{customer_name}` that the outbox can never fill (`booking_created`,
  `payment_verified`, `cancellation_approved`, `payment_rejected`, `refund_completed`). The
  clock-produced ones also name `{pending_balance}`, `{booking_expires_at}` and `{itinerary}`.

Out of scope, recorded:
- `app-turistear/src/features/organization/components/CancellationPolicyCard.tsx:271` says
  «servicio del folio» in admin copy. This is the same constitution VII rule, but on a screen, not
  in a customer message.

## Root Cause Hypothesis

Two causes, both high confidence.

1. **The wording.** The templates predate constitution VII's glossary. «Folio» was the internal
   name of the sale, and it leaked into the copy the customer reads.
2. **The holes.** The outbox was designed so the message "travels with the row so the drain
   screen opens the composer without a second read"
   (`test/folios/notification-outbox.test.ts:209`). But the row carries the *template*, not the
   *message*. The one client that composes it knows only the customer's name, and it cuts the
   rest rather than show raw braces.

Fixing only the word would still send «…de tu compra en .». D11 (Devolada PR 2) will start
sending `payment_rejected` with no human tap behind it, for every unpaid transfer. So both causes
go in one fix.

## Proposed Remediation

**Preferred**:

1. **Rewrite the three templates without «folio».** They speak of «tu compra», as
   `payment_verified` does, and of the organization by name:
   - `cancellation_approved`: «Hola {customer_name}, aprobamos la cancelación de tu compra en
     {org_name}. Te contamos enseguida cómo queda.»
   - `payment_rejected`: «Hola {customer_name}, no pudimos confirmar el pago de tu compra en
     {org_name}, así que tuvimos que cancelarla. Si crees que es un error, escríbeme. —
     {agent_name}»
   - `refund_completed`: «Hola {customer_name}, confirmamos el reembolso de tu compra en
     {org_name}. Pagaste {amount_paid}, te devolvimos {refund_amount} y se retuvo
     {retained_amount} según la política de cancelación.»

   `{folio_ref}` leaves the customer copy. An 8-character UUID prefix means nothing to a customer,
   and the seller already finds the sale by name or phone.
2. **Render the message on the server.** The outbox read returns `message`, the template filled
   for that row. The query already joins the folio. It additionally reads:
   - the organization's name;
   - the seller's name;
   - the money the template names;
   - the itinerary and dates the clock-produced templates name, through the same readers their
     senders use.

   A placeholder the server cannot fill is never sent raw. The renderer drops it the way
   `composerText` does today, and a unit test pins that no shipped template keeps one for its
   event.
3. **The app sends `message` and stops composing.** `OutboxPage`'s `composerText` becomes
   `row.message`. `refundReceipt.ts` says «el reembolso de tu compra en {org}», which needs the
   organization's name: the screen calling it already reads `useMyOrganization`.

**Alternatives**:
- *Only change the word.* This is the smallest diff, and it leaves «tu compra en .» and the cut
  signature in every outbox message. Rejected: D11 sends `payment_rejected` automatically in
  PR 2.
- *Fill placeholders in the app.* The outbox row would carry `org_name`, `agent_name` and the
  amounts, and the app would fill the template. That makes two renderers for one message (the
  email side already renders on the server), and every new placeholder needs both. Rejected in
  favour of one server renderer.

**Files likely to change**:
- `api-turistear/src/utils/notifications.ts` — the three templates, plus `renderNotification(template, values)`.
- `api-turistear/src/routes/notifications/handler.ts` — the outbox read returns `message`, and
  joins the organization and the seller.
- `app-turistear/src/pages/OutboxPage.tsx` (and its outbox types) — sends `row.message`.
- `app-turistear/src/features/folios/refundReceipt.ts` and its caller — «tu compra en {org}».
- Tests: `api-turistear/test/folios/notification-outbox.test.ts`, the refund receipt test, and the
  outbox page test if one exists.

**Tests to add or update**:
- **API, outbox read:** a `payment_rejected` row's `message` is «Hola Ana Buceo, no pudimos
  confirmar el pago de tu compra en Empresa…, así que tuvimos que cancelarla… — <seller name>»:
  the org and the seller are filled, no «folio», no brace, no « .».
- **API, `cancellation_approved` and `refund_completed`:** their messages carry the org name and
  the money (formatted), and never «folio».
- **API, unit over `EVENTS`:** no template contains the word «folio».
- **API, isolation:** org B's admin never sees org A's rows or names through the message
  (`seedTwoOrgs`, as the outbox suite already does).
- **App:** the outbox opens `wa.me` with `row.message` verbatim; the refund receipt says «tu
  compra en <org>».

## Risks & Considerations

- **Contract change.** The outbox read gains `message`. Keep `template` one release for any
  cached client, or drop it at once, since the only consumer is this app and it ships with the
  API.
- **Money formatting on the server.** `refund_completed` needs `$1,250.00` the way the app formats
  it. Reuse the email side's formatter, so emails and WhatsApp agree.
- **Clock-produced rows.** `booking_grace_entered` and `departure_reminder` come from the sweeps.
  Filling `{pending_balance}` and `{itinerary}` server-side reads the lines per row. Keep that read
  bounded to the rows of the page (the outbox is paged), and check its query plan (BUG-042).
- **No behaviour beyond copy and rendering.** Who gets a row, and when, does not change.

## Open Questions

- None blocking. The exact Spanish wording above follows the existing «tu compra» messages, and
  can be tuned in review without changing the shape of the fix.
