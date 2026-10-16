# Bug Assessment: the per-line settle that completes a folio skips the ticket delivery

- **Slug**: line-settle-no-ticket-email
- **Created**: 2026-10-16
- **Source**: pasted text — found while auditing how tickets are delivered (session of 2026-10-16)
- **Verdict**: valid (reproduced: `repro.test.ts` in this folder, 3/3 assert today's behaviour)
- **Severity**: medium
- **Code as of**: `main` @ `b1b81d5` (after the Devolada PR #176 moved `verifyPayment`'s tail into
  `verifyCore.ts`). Line numbers below are at that commit; the report's own `:2684` is the same
  comment one commit earlier (now `:2739`).

## Report (verbatim or summarized)

> Liquidar la última línea de un apartado con settleFolioLine (POST
> /api/pos/folios/:id/lines/:lineId/settle) crea el enlace al portal pero NO manda el correo de
> boletos, aunque el comentario en api-turistear/src/routes/pos/handler.ts:2684 dice "the delivery
> tail (portal + ticket email), exactly where the whole-folio settle runs it". settleBooking sí
> llama dispatchTicketEmail; settleFolioLine solo llama issuePortalLink. Resultado: un cliente con
> email cuyo apartado se completa línea por línea nunca recibe el correo con sus QR ni el botón al
> portal. Tampoco se emite el evento tickets_delivered al outbox (ni en settleBooking ni en
> settleFolioLine).

## Symptom

When `settleFolioLine` collects the **last** outstanding balance of an apartado (cash/card/link, no
pending transfer), the folio turns `paid` and gets a portal link, but:

1. **No ticket email is sent**, even when the folio has a `customer_email`. The whole-folio
   `settleBooking` and `verifyPayment` (via `releaseClearedFolio`) both send it; the comment at
   `handler.ts:2739` says this path does too.
2. **A line the deposit already paid in full never gets a QR.** `settleFolioLine` signs only the
   line being settled. `settleBooking` and `releaseClearedFolio` sign every live slot line. When the
   deposit cascade has fully funded a line (`seedAndCascade`, D2/D3), that line is
   `money_state = 'paid'` with `qr_token = NULL`, and nothing later signs it. The customer has paid
   for a tour and has no pass: the portal shows no QR for it, and the gate has nothing to scan.

Expected: the completing per-line settle runs the same delivery tail as the whole-folio settle:
every live slot line has a QR, a portal link is issued, and the ticket email goes out when there is
an address.

Separately, but in the same area: **neither settle path emits `tickets_delivered`** to the
notification outbox, while `confirmSale` (`handler.ts:1969`) and `verifyPayment`
(`releaseClearedFolio`, `verifyCore.ts:251`) do. See Open Questions: that half needs a product call before it is fixed.

## Reproduction

`.specify/bugs/line-settle-no-ticket-email/repro.test.ts` — run from `api-turistear/` with
`npx vitest run --dir ../.specify/bugs/line-settle-no-ticket-email`. Cart: near $1,000 (+3 d) and
far $500 (+10 d), org minimum 30%, `customer_email` set.

**A — no email** (case `BUG — every line settled per line…`)
1. Create the apartado with a $600 deposit.
2. `POST /api/pos/folios/:id/lines/<near>/settle` → the folio stays a `booking`.
3. `POST /api/pos/folios/:id/lines/<far>/settle` → the folio is `paid`, `portal_link` is set and
   both lines have a `qr_token`.
4. Resend received **0** ticket emails. The control case does steps 1–2 and then calls the
   whole-folio settle (`POST /folios/:id/settle`) instead: exactly one email, with both QRs.

**B — no QR** (case `BUG (worse) — …`)
1. Create the apartado with a $1,150 deposit: seeds 300 + 150, surplus 700 → near. The near line is
   fully funded at booking.
2. `POST /api/pos/folios/:id/lines/<far>/settle` → the folio is `paid`.
3. The near line reads `money_state: 'paid'` and `qr_token: null`. No email.

**Reachability.** The current app does **not** take this path in the normal flow. `BookingActions`
shows the per-line **Liquidar** only while two or more lines still owe
(`app-turistear/src/features/bookings/components/BookingActions.tsx:194-206`). With one line left
the button becomes **Liquidar saldo**, which calls `settleBooking`, and that path delivers
correctly (the control case). The broken path is reached by:
- a direct API call (the endpoint accepts it; `test/folios/line-settle.test.ts` "settling the LAST
  live line completes the folio" does exactly this);
- two people settling different lines of the same folio from screens loaded before either settle
  (both see two lines owing; the second settle completes the folio). The endpoint lets the folio's
  agent or any admin of the org settle (`folioActionFilter`);
- any future client that offers the per-line gesture on the last line.

[NEEDS CLARIFICATION: whether this has happened in production — check dev/prod D1 for `paid`
folios whose `settled_at` matches a line-settle `payment` event, and for live slot lines with
`qr_token IS NULL` on a paid folio. The second query also finds case B directly.]

## Suspected Code Paths

- `api-turistear/src/routes/pos/handler.ts:2531` `settleFolioLine` — the endpoint.
- `handler.ts:2559-2576` — its `lineRows` select has no `qrToken`, `unitPrice`, `checkOut` or
  extras, so the handler cannot build the email or know which siblings lack a QR. It also keeps
  cancelled lines; the `completing` check filters them, but the portal-date list at `:2743` does not.
- `handler.ts:2642-2661` — signs **only** `lineId`, even when `completing`.
- `handler.ts:2739-2750` — the "delivery tail": `issuePortalLink` only. No `dispatchTicketEmail`, no
  signing of siblings, no outbox event. The comment promises "portal + ticket email".
- `handler.ts:2410` / `:2460` / `:2490` — `settleBooking`'s tail (signs every live slot line, then
  portal, then email): the reference behaviour.
- `api-turistear/src/routes/pos/verifyCore.ts:122` `releaseClearedFolio` — `verifyPayment`'s tail,
  extracted by PR #176 and shared with Devolada's webhook (`routes/devolada/apply.ts:213`). It does
  the same as above (`:172` / `:195` / `:220`) plus `payment_verified` and `tickets_delivered`
  (`:250-251`).
- `handler.ts:881` `dispatchTicketEmail` — the fire-and-forget email helper `settleBooking` uses
  (`releaseClearedFolio` calls `sendTicketConfirmationEmail` itself, through `deps.waitUntil`).
- `api-turistear/src/utils/folioAllocations.ts` `seedAndCascade` / `bookingSegments` — why a line can
  be fully paid by the deposit alone (case B).
- `api-turistear/src/routes/tickets/handler.ts:149` — the scanner rejects a token that no longer
  matches the line's stored `qr_token`. That is why the fix must not re-sign lines that already
  hold a QR.

## Root Cause Hypothesis

The per-line settle (US-AG54, line-autonomy F3, PR #93, 2026-08-11) only did per-line work: it
signs the settled line's QR and leaves its siblings alone. When it gained a "completing" branch, that
branch copied only the portal half of `settleBooking`'s tail. The email half, and the fact that
`settleBooking` signs **every** live slot line, were left behind, while the comment describes the
full tail. Nothing caught it because no test asserts any email on any settle path.
`client-ticket-delivery.test.ts` covers only `confirmSale` and cancellation, and `line-settle.test.ts`
mocks no fetch. The bug has been there since the feature landed; it is not a regression.
Confidence: **high**. Both symptoms are reproduced against the real endpoints.

## Proposed Remediation

**Preferred** — finish the completing tail inside `settleFolioLine`, signing only what is missing:

1. Add `qrToken` (plus `unitPrice` and `checkOut`) to the `lineRows` select (`:2559`).
2. When `completing && cleared`, sign a QR for **every live slot line that has none**: the line
   being settled plus any line the deposit funded in full. Use the same `signLineTickets` call and
   write the tokens in the **same batch** as the payment, so the folio never reads `paid` with a
   missing pass. Never re-sign a line that already holds a token: the customer may already have it
   (`/t/` page), and the scanner rejects a replaced token (`tickets/handler.ts:149`).
   When not completing, keep today's behaviour: only this line, only when cleared.
3. After the batch: `issuePortalLink` over the **live** lines' dates (`slotDate ?? checkOut ??
   checkIn`, like `settleBooking`). Then read the folio's extras and call `dispatchTicketEmail` with
   every live slot line and its stored or new token. For `paymentMethod`, read the folio's
   `displayMethodSql`: a folio settled across several per-line payments can mix methods, and
   `settleBooking`'s two-way `=== settleMethod ? … : 'Mixto'` check does not cover that.
4. Correct the comment at `:2739` so it describes what the code now does.

The email stays fire-and-forget via `dispatchTicketEmail` (`waitUntil` + `catch`). Constitution
principle VIII: an external service never undoes a sale.

**Alternatives**:
- *Call `releaseClearedFolio` (`verifyCore.ts:122`) from the completing branch.* It already loads
  the lines and extras itself and runs portal + email. Not as it stands: it re-signs **every** live
  slot line (which would invalidate the sibling QRs this path minted at their own settles) and
  emits `payment_verified`, which is false for a cash settle. Making it reusable means adding
  options (sign only missing tokens, skip `payment_verified`) to a function the Devolada webhook
  depends on. That is a reasonable follow-up refactor once this fix lands, also covering
  `settleBooking`, but it widens a bug fix into a module that shipped one commit ago.
- *Reject a completing per-line settle with 409 and send the client to the whole-folio settle.*
  The diff is trivial, and it matches what the UI already does. But it breaks the
  concurrent-sessions case with an error the seller cannot act on, and it contradicts line-autonomy
  F3 ("the folio flips to `paid` only when the LAST live line completes"), which existing tests
  assert. Not recommended.

**Files likely to change**:
- `api-turistear/src/routes/pos/handler.ts` (`settleFolioLine` only)
- `api-turistear/test/folios/line-settle.test.ts` (or `test/email/client-ticket-delivery.test.ts`,
  which already has the Resend fetch mock)

**Tests to add or update** (port the cases from `repro.test.ts`, inverted):
- Completing per-line settle with `customer_email` → exactly one ticket email, containing every live
  slot line's QR and the portal link.
- Completing per-line settle without `customer_email` → no Resend call; the folio still turns
  `paid` with a portal link.
- Deposit-funded line (the $1,150 cart) → after the completing settle, **every** live slot line has a
  `qr_token`, and its `/t/<token>` page renders 200.
- A sibling settled earlier per line keeps its **original** `qr_token`, and it still scans.
- A completing per-line **transfer** settle sends nothing until `verifyPayment` (deferral preserved).
  Then exactly one email, not two.
- A cancelled sibling line is absent from the email and gets no QR.
- A non-completing per-line settle sends no ticket email.

## Risks & Considerations

- **Re-signing invalidates passes.** The scanner rejects a token that differs from the stored one.
  The fix must sign only lines whose `qr_token IS NULL`. A related issue exists **outside this
  fix**: `settleBooking` (`:2410`) and `releaseClearedFolio` (`verifyCore.ts:172`) re-sign every
  live slot line,
  including one already settled per line. That silently invalidates a QR minted earlier for that
  line, which the normal UI flow reaches (per-line settle, then "Liquidar saldo"). Whether that QR
  could have reached the customer before completion is an open question below.
- **Double email.** `completing && cleared` excludes a pending verification, so `verifyPayment`
  and the Devolada webhook (both through `releaseClearedFolio`) will not send a second email for
  the same folio.
- **Observability.** The new email path, like the existing two, records its outcome nowhere: no
  `recordEmailOutcome`. A Resend failure is only a `console.error`. This gap already exists on every
  ticket-email path; do not widen this fix to cover it.
- No migration and no API shape change. The response already carries `portal_link` and the line
  QRs.

## Open Questions

- [NEEDS CLARIFICATION: should `tickets_delivered` be emitted on the settle paths? It would be
  consistent with `confirmSale`/`releaseClearedFolio` and give settled apartados an outbox record. But
  each emit adds a `pending` WhatsApp row to the admin outbox, and nothing drains it:
  `markTicketsSent` does not touch `notifications`. It also adds an email row that stays `pending`,
  because ticket emails never call `recordEmailOutcome`. Recommended: decide this together with the
  outbox/`tickets_sent_at` reconciliation (D26 says the drain is the only writer of
  `tickets_sent_at`, but `markTicketsSent` writes it too), not in this fix.]
- [NEEDS CLARIFICATION: can a QR minted by a non-completing per-line settle reach the customer
  before the folio completes? No portal link exists yet, and the receipt shows QRs only for a
  `paid` folio. If it can, the `settleBooking` re-sign described above is its own bug and deserves
  its own assessment.]
- [NEEDS CLARIFICATION: production impact — the D1 queries under Reproduction.]
