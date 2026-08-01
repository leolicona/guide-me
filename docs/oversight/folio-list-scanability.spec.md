# Feature: The folio list identifies a sale without opening it

> Process: `docs/PROCESS.md`. Stories **US-A82** (admin *Ventas* list) and **US-AG49** (the seller's
> own *Ventas* list). Reuses the delivery axis of `docs/whatsapp-qr-delivery/whatsapp-qr-delivery.spec.md`
> (US-AG40) and the express-sale name exception of `docs/pos/express-sale.spec.md` (D17) **without
> changing either**.

## Context

A folio card in `/folios` and `/history` renders six things: customer name, sale timestamp, who sold
it, a payment chip, a delivery chip, and two or three money figures. It answers *who bought*, *when*
and *how much*.

It does not answer the two questions an admin actually opens the list with: **what did they buy**,
and **how do I reach them**. Both require entering the detail and coming back — two navigations per
folio. Against the 101 folios in dev alone, locating "the Isla Mujeres sale from the lady who
called" is up to 101 round trips through a route that exists to *cancel* folios.

**Colour stopped carrying meaning.** Two independent axes render as adjacent pills drawn from one
four-tone palette (`FoliosListPage.tsx:145-154`):

| Folio | Payment chip | Delivery chip | What the eye sees |
|---|---|---|---|
| paid + viewed | 🟢 Pagado | 🟢 Visto | green, green |
| paid + sent | 🟢 Pagado | ⬜ Enviado | green, grey |
| paid + pending | 🟢 Pagado | 🟠 Pendiente de enviar | green, amber |
| booking | 🟠 Reserva | *(none)* | amber |
| cancelled | 🔴 Cancelado | *(none)* | red |

Two greens side by side mean two unrelated things, so the row must be **read**, not scanned — which
is the one job a status chip exists to avoid. Amber is worse: it means *apartado* in the payment
chip, *undelivered* in the delivery chip, *expiring* in the countdown chip, and *urgent* in the card's
left border — four meanings, one colour, on one card.

**Two rows lie today.**

1. A transfer awaiting verification is `status='paid'` with `payment_verification='pending'`
   (`pos/handler.ts:1367-1370`). The card prints **🟢 Pagado** for money the organization does not
   have, and because `deliverable` is false it shows no delivery chip either — so it is visually
   *indistinguishable from a sale already collected and delivered*.
2. An Express sale leaves `customer_name` NULL **by design** (`express-sale.spec.md` **D17**), and
   `ExpressSalePanel` deliberately holds service and departure between sales (**D20**). A busy
   counter therefore produces a run of cards that all read `Sin nombre`. That same spec already
   prescribed the fix — *"Surfaces that assume a name must fall back — `Cliente · ••1234`"*
   (`express-sale.spec.md` line 490) — and it was never built: five surfaces still print
   `Sin nombre`.

The data needed to fix most of this is **already in the payload**. `customer_phone` is selected,
serialized and typed (`folios/handler.ts:308,342`; `features/folios/types.ts:23`) and simply never
rendered. Only the service line requires the server to read anything new.

## Scope boundary

**No migration, no new column, no state change.** Reverting this feature changes not one row.

Mechanically:

- `test/folios/*.test.ts` and `test/pos/*.test.ts` must pass **unedited**. The response of
  `GET /api/folios` is **additive only** — no field is removed, renamed or re-typed.
- The **delivery axis vocabulary is untouched**: `Pendiente de enviar → Enviado → Visto` keep the
  meanings D4 of `whatsapp-qr-delivery.spec.md` gave them. This spec changes how they are *drawn*,
  never what they *mean* (see *Deferred*).
- **Detail surfaces are untouched.** `FolioDetailPage`, `FolioHistoryDetailPage`, `FolioReceiptPage`,
  `QueueRow`, `PaymentVerificationTab` and `CancellationRequestsTab` keep `FolioStatusChip` and
  `DeliveryBadge` exactly as they are.
- No money mutation moves onto a list. Verify, refund and cancellation-request resolution stay in
  their tabs (**D12**).

## Design decisions

| # | Decision | Why |
|---|---|---|
| **D1** | **One channel per axis, and never two.** `rail = money · checkmark = message · chip = time · button = pending work`. | The defect in *Context* is not that the chips are ugly — it is that two axes share one palette on one line, so colour identifies nothing. Giving each axis its own visual channel restores scanning without adding ink: a folio's payment state and its delivery state can no longer be confused because they are no longer drawn with the same kind of mark. |
| **D2** | **The card title is what was sold, not who bought it.** First line's `service_name` + its date/time + `· +N` when the folio has more. | The name was already the title and the list still failed, because the name is not the fact the reader is searching by. Decisive: **a folio always has at least one line; it does not always have a name** (D17 express). A title must be a field that always exists. Accepted cost: an Express burst yields near-identical titles (D20 holds the service), which is why the identity line beneath it carries `••1234` and the sale time. |
| **D3** | **Identity degrades, never blanks:** `customer_name` → `Cliente ••1234` (last four digits) → `Cliente`. One helper, `folioCustomerLabel()`. | This is `express-sale.spec.md` line 490 finally built. `Sin nombre` is not a fallback, it is an apology: it says the record is deficient when in fact the sale was deliberately anonymous and we hold a phone number that identifies it. |
| **D4** | **The left rail carries the money axis only** — green paid · amber booking or unverified · red cancelled. Apartado urgency moves entirely into the `Vence en 3 h` chip. | The rail currently means *urgent apartado* while the chip beside it means *apartado* — the same card stating one axis twice and another axis nowhere. The countdown chip already says urgency in words with a number; the rail cannot, so the rail takes the axis it can carry with three values. |
| **D5** | **`paid` + `payment_verification='pending'` reads amber, `$2,400 · por verificar`** — never green *Pagado*. | The green pill is a factual error about money (*Context* 1). The organization does not have the funds; a list that says otherwise is worse than one that says nothing. No new action is added here — verification keeps living in its tab (**D12**). |
| **D6** | **One money figure, read semantically:** paid → `$2,400 pagado` · booking → `Debe $1,600 de $2,400` · unverified → `$2,400 · por verificar` · cancelled owing → `Reembolsar $2,400` · cancelled settled → `$2,400 (reembolsado)`. | On a paid folio `Total` and `Pagado` print the same integer twice under two labels — pure noise on the element the design system says must read first. Reading the figure semantically also gives every rail colour a **text anchor**, satisfying *state is never colour-alone* without adding a chip back. |
| **D7** | **Exactly one button per card, and its verb is the folio's first pending job.** With no pending job the verb is the neutral `Enviar mensaje`. | Two consequences, both load-bearing. First, `customer_phone` is **required on every sale** (`pos/schema.ts:67-70`), so a contact path is always possible and its absence was an omission, not a constraint. Second — and this is why the generic button is safe — a specific verb and the generic verb **can never coexist**. Were they both present, a seller would send the portal link through the generic button, the folio would never be marked sent, and it would sit in the undelivered queue forever: a queue that grows from correct behaviour. One button, one job, no ambiguity about what gets recorded. |
| **D8** | **Presence is not the signal; weight and verb are.** Pending → filled button with a specific verb. Nothing pending → plain text button, `Enviar mensaje`. | D7 costs us the strongest scan signal there is (presence/absence), so it must be replaced by the next strongest. Filled-versus-flat is a luminance difference far larger than green-versus-green, and the verb differs in words — so the signal survives sunlight and colour-blindness, which the chips it replaces did not. |
| **D9** | **The pending button is teal (action), not success green.** | `TicketWhatsAppButton` ships `color="success"` today. In this system green is a *state* (paid/available) and teal is *action* — a green button on a card whose rail is also green re-merges the two channels D1 exists to separate. Cited, not restated: `.design/design-system/DESIGN_TOKENS.md` §Functional colour. |
| **D10** | **The action button is a SIBLING of the link region, not nested inside it.** `<Card><CardActionArea>…</CardActionArea><CardActions>…</CardActions></Card>`. | The card is an `<a>`; a `<button>` inside it is invalid HTML, which is why `BookingWhatsAppButton` renders `component="span"` and `TicketWhatsAppButton` calls `stopPropagation()` — two different workarounds for the same structural mistake. As siblings both become real keyboard stops and the escape hatches disappear. |
| **D11** | **Delivery evidence is two checkmarks, and only two:** `✓` grey = *Enviado* · `✓✓` green = *Visto*. There is deliberately **no grey `✓✓`**. | WhatsApp's three-tick language is instantly readable, and borrowing it is the right call — but its middle tick means *delivered to the device*, and we do not measure that. `tickets_sent_at` records that the seller opened the composer (`TicketWhatsAppButton.tsx:53-55`, "record the send regardless"); `tickets_viewed_at` records a JS beacon the tourist's browser actually fired (`portal/handler.tsx:377-392`). Two events, two marks. Inventing a third would put a promise on screen that no column backs. The green `✓✓` uses the success token that already means *Visto* today — never WhatsApp blue, which is not in the palette. |
| **D12** | **Only communication actions live on the card.** *Verificar pago*, *Confirmar reembolso* and *Resolver solicitud* stay in their tabs. | Those three mutate money or resolve a customer request; two of them need fields the list row does not carry (the tourist's cancellation request is not in this payload at all). `pending-work-queues.spec.md` **Q6** already settled the principle for refunds: a money action one tap from a list is how the wrong folio gets confirmed. |
| **D13** | **One `FolioCard`, used by `/folios` and `/history`; the byline is a prop.** Admin → `agent.name`. Seller/affiliate → `operator_name`, collapsing silently when the sale was direct. | The two cards are today near-identical inline JSX in two page files. That is exactly how they came to disagree about which name to show, and redesigning one would re-open the same gap. The byline differs by audience, not by card: an admin reconciles by agent, an affiliate by which operator worked the shift. |
| **D14** | **The list payload carries lean lines in the `ItineraryLine` shape**, not a bespoke summary. | The same array feeds both consumers: the card renders line 1 + `+N`, and `ticketWhatsAppUrl()` renders `{itinerary}` from it unchanged. A summary object would have forced the card's WhatsApp button either to send a message with an empty itinerary or to fetch the detail on click — and opening `wa.me` after an `await` is what popup blockers exist to stop. |
| **D15** | **`FolioStatusChip` and `DeliveryBadge` stay on detail surfaces.** | The rail exists because a list competes for scanning. A detail page has one folio and nothing to scan against, so the chip is the better instrument there. Divergence by surface, chosen; not drift. |

## Data Model

**No migration.** Every field this feature reads already exists:
`folios.customer_phone`, `folios.payment_verification`, `folios.sale_mode` (migration `0057`),
`folios.tickets_sent_at`, `folios.tickets_viewed_at`, `folios.refund_status`, `folios.refund_amount`,
`folio_lines.*`, `folio_access_tokens.token`.

## Business rules (enforced server-side)

1. `GET /api/folios` returns, **for each folio in the caller's organization only**, a `lines` array
   scoped by `folio_lines.organization_id` as well as `folio_id` — the same double scope
   `readFolio` already applies.
2. `lines` is ordered by `folio_lines.created_at ASC`, so "the first line" is stable across requests
   and matches what the detail page shows.
3. `portal_link` is derived from the folio's **newest** `folio_access_tokens` row, and is `null`
   when the folio has no token or `API_BASE_URL` is unset — identical to `readFolio`'s rule.
4. `sale_mode` is echoed as stored; no surface may infer Express from a null name.
5. Ordering, filters and every pre-existing field of the response are **unchanged**.
6. *(frontend mirror)* Rail colour, money wording, checkmarks and the button's verb are all derived
   from these fields. No new state is stored anywhere.

## Authorization — who may do this

Unchanged. `GET /api/folios` stays admin-scoped and organization-scoped; `GET /api/pos/folios`
stays scoped to the calling seller. A cross-org folio id returns **404**, never 403. The new fields
add no capability: `lines` and `portal_link` are already readable by the same caller through
`GET /api/folios/:id`.

## API surface

### `GET /api/folios` — additive response fields

```jsonc
{
  "folios": [{
    // …every existing field, unchanged…
    "sale_mode": "standard",                    // 'standard' | 'express'
    "portal_link": "https://api…/portal/<tok>", // null when no token
    "lines": [{                                 // ItineraryLine shape (D14)
      "service_name": "Tour Isla Mujeres",
      "line_type": "slot",                      // 'slot' | 'stay'
      "slot_date": "2026-08-10",
      "slot_start_time": "09:00",
      "check_in": null, "check_out": null, "guests": null,
      "quantity": 2
    }]
  }]
}
```

Implementation: two `WHERE … IN (<folio ids>)` reads after the main query — one over `folio_lines`,
one over `folio_access_tokens` — grouped in JS. No N+1, no join fan-out on the money columns.

`GET /api/pos/folios` gains the same three fields, so `/history` renders the identical card.

### Error responses

None. This feature adds no failure mode: it widens a read that already exists.

## Frontend

**New shared component** — `features/folios/components/FolioCard.tsx`, consumed by
`FoliosListPage` (tab 0) and `FolioHistoryPage`. Props: `folio`, `to`, `byline`.

Anatomy (D1 · D10):

```
┃🟢  Tour Isla Mujeres · Sáb 10, 9:00 · +2      ← title: what was sold (D2)
┃    María González · Ana R. · hoy 14:32         ← identity · byline · sale time (D3, D13)
┃    ────────────────────────────────────
┃    $2,400 pagado                        ✓✓    ← money (D6) + delivery evidence (D11)
┃    [ 💬 Enviar boletos ]                       ← CardActions, sibling of the link (D10)
```

| State | Rail | Money | Marks | Button |
|---|---|---|---|---|
| paid, undelivered | green | `$2,400 pagado` | — | **Enviar boletos** *(filled)* |
| paid, sent | green | `$2,400 pagado` | `✓` | Enviar mensaje *(plain)* |
| paid, viewed | green | `$2,400 pagado` | `✓✓` | Enviar mensaje *(plain)* |
| paid, unverified | amber | `$2,400 · por verificar` + `Ref. …` | — | Enviar mensaje *(plain)* |
| booking, slack | amber | `Debe $1,600 de $2,400` | `✓` if reminded | Enviar mensaje *(plain)* |
| booking, urgent or overdue | amber | `Debe $1,600 de $2,400` + `Vence en 3 h` | `✓` if reminded | **Recordar saldo** *(filled)* |
| cancelled, refund owed | red | `Reembolsar $2,400` | — | Enviar mensaje *(plain)* |
| cancelled, settled | red | `$2,400 (reembolsado)` | — | Enviar mensaje *(plain)* |

Reused primitives: `MoneyText` (semantic colour, tabular figures), `TicketWhatsAppButton`
(`variant='icon'` retired in favour of a labelled variant; `surface='admin'` on `/folios`),
`BookingWhatsAppButton`, `useOrgDateFormatter`, `isUrgentBooking` / `venceLabel`,
`folioLineMeta`. Design tokens: `.design/design-system/DESIGN_TOKENS.md` — this spec restates no value.

**Accessibility.** The rail is decorative; the money wording carries the state. Each checkmark
carries a visually-hidden label (`Boletos enviados 14:32` / `Boletos vistos por el cliente 15:02`) —
a glyph alone is not state. The link region and the action button are two separate keyboard stops.

**Removed from these two lists only:** `FolioStatusChip`, `DeliveryBadge`, the `Total`/`Pagado`
figure pair, and the urgency-coloured left border. All four remain in use elsewhere (D15).

## Scenarios

### US-A82 — identify a sale from the list

**S-1 — The list names what was sold**
Given a folio with lines `Tour Isla Mujeres (Sáb 10, 09:00)` and two more
When the admin opens `/folios`
Then the card's title reads `Tour Isla Mujeres · Sáb 10, 9:00 · +2`, with no navigation to the detail.

**S-2 — An Express folio is identified by its phone, not apologised for**
Given a folio with `sale_mode='express'`, `customer_name IS NULL`, `customer_phone='5215512345678'`
When the admin opens `/folios`
Then the identity line reads `Cliente ••5678` — and the string `Sin nombre` appears nowhere.

**S-3 — Unverified money does not read as collected**
Given a folio `status='paid'`, `payment_verification='pending'`, total 240000
When the admin opens `/folios`
Then the rail is amber and the money reads `$2,400 · por verificar`
And no green *Pagado* mark appears on the card.

**S-4 — A settled sale and an unsent one are told apart without reading**
Given folio A `paid` + `tickets_viewed_at` set, and folio B `paid` with neither stamp
Then A shows `✓✓` and a plain `Enviar mensaje`
And B shows no checkmark and a filled `Enviar boletos`.

**S-5 — Cancelled with money owed reads as a debt**
Given a folio `cancelled` with `refund_status='pending'` and `refund_amount=240000`
Then the money reads `Reembolsar $2,400` in the error tone, not the total collected.

**S-6 — Exactly one button, never two**
Given any folio in any state
Then the card renders exactly one action button
And when a delivery is pending its label is `Enviar boletos` — the generic `Enviar mensaje` is absent,
so a manually pasted link can never leave the folio silently undelivered (D7).

### US-AG49 — the same card on the seller's own list

**S-7 — The byline follows the audience**
Given a folio sold by agent *Ana* through affiliate operator *Luis*
When the admin opens `/folios` the byline reads `Ana`
And when the seller opens `/history` it reads `Luis`
And on a direct sale `/history` shows no byline and no placeholder dash.

### Multitenancy isolation (required)

**S-8 — Another org's lines are invisible**
Given two organizations seeded with `seedTwoOrgs`, each with folios carrying lines
When org A calls `GET /api/folios`
Then every returned `lines` array belongs to org A's folios only, and org B's `service_name` values
appear nowhere in the response.

**S-9 — Another org's portal token is never issued**
Given org B's folio holds an access token
When org A calls `GET /api/folios`
Then no `portal_link` in the response resolves to org B's token.

## Definition of Done

- [ ] `listFolios` + `listMyFolios` return `lines`, `portal_link`, `sale_mode` (additive; existing
      fields byte-identical)
- [ ] Scenarios S-1…S-9 covered in `test/folios/folio-list-scanability.test.ts`
- [ ] Cross-org isolation tests (S-8, S-9) using `seedTwoOrgs`
- [ ] `folioCustomerLabel()` helper + `FolioCard` shared by `/folios` and `/history`
- [ ] `FolioCard` accessibility: hidden labels on checkmarks, two keyboard stops
- [ ] `SPEC.md`: US-A82 + US-AG49 stories, *Features by Phase* line, glossary entry for **Riel de estado**
- [ ] `TECH_DEBT.md`: `Sin nombre` on the three remaining surfaces; `/api/folios` still unpaginated

## Deferred — and why each is safe to defer

| What | Why it can wait |
|---|---|
| **Search over the loaded list** (name · phone · service · folio ref) | Its own PR. The card change stands alone and search needs no schema from it; shipping them together would put two independent failure modes in one review. Until it lands, the filters and the richer card already cut the scan cost. |
| **Renaming the delivery axis** — `Visto` → `Entregado`, plus a new `Visto` stamped when the tourist opens their tickets | The three-state model is better, but *Visto* is a **glossary term with an owner**: it titles `whatsapp-qr-delivery.spec.md` and names US-AG40 and US-T06, and the third state needs instrumentation that does not exist. Shipping half a rename is how a vocabulary splits: this PR uses today's names, the migration PR changes spec, code, tests and glossary in one move. |
| **Delivery timestamps on the folio detail** | Rides with the rename PR — the detail is where the hour belongs, and it is the surface the rename touches anyway. |
| **`Cliente ••1234` on `FolioDetailPage`, `QueueRow`, `CancellationRequestsTab`** | `FolioCard` covers the two highest-traffic surfaces. The helper is shared from day one, so adopting it elsewhere is a one-line change per file. Recorded in `TECH_DEBT.md` rather than left to be rediscovered — as line 490 of the express spec was. |
| **Pagination / `LIMIT` on `GET /api/folios`** | The response grows by roughly 150 bytes per folio; at the current largest org this is not the binding cost. Recorded in `TECH_DEBT.md`. It becomes urgent when search goes server-side, and that PR is where the cursor belongs — client-side search over a paginated list would only search what was already downloaded. |
| **Contextual verify / refund / resolve on the card (D12)** | Each mutates money or a customer request; the cancellation-request axis is not even in this payload. `pending-work-queues.spec.md` Q6 already ruled on the shape. |

## Known behaviour change

- A transfer awaiting verification **stops reading as paid** in both lists. Organizations that
  worked transfers will see amber where they saw green — the rows did not change, the claim did.
- `Sin nombre` disappears from `/folios` and `/history`. Express sales, which are the bulk of it at
  a busy counter, now read `Cliente ••1234`.
- The `Total` / `Pagado` figure pair collapses to one figure on paid folios. The pair survives only
  where the two numbers actually differ.
- The delivery chips (`Pendiente de enviar` / `Enviado` / `Visto`) leave the two list cards. The
  same states remain visible on every detail surface and drive the unchanged *Sin entregar* filter
  and its count badge (US-A80).

## Open

| Question | Smallest change that answers it |
|---|---|
| Should the admin list show the affiliate operator alongside the agent (`Ana R. · op. Luis`)? Decided **no** for now — D13 keeps the byline single-valued per audience — but `operator_name` already travels in the payload. | One conditional in `FoliosListPage`'s `byline` prop. No server change. |
| Does the plain `Enviar mensaje` want a template, or is an empty `wa.me` compose correct? Shipping empty: the seller knows what they are answering. | An org-level `wa_generic_template`, mirroring `wa_ticket_template`. |
| Should a slack apartado's button be `Recordar saldo` (plain) rather than the generic verb, given the reminder claim (`useClaimReminder`) only fires on the specific action? | Swap the verb in the not-urgent booking branch; the claim behaviour follows the button, not the state. |
