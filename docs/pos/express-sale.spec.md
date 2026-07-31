# Feature: Express Sale — a cash walk-up closed in one sheet, with the ticket handed over the counter

**User stories:** **US-AG45** (the express sheet), **US-AG46** (the reset loop), **US-AG47** (60-second void),
**US-T07** (the tourist scans the QR and gets their ticket), **US-A80** (pending-delivery queue).
Registered in `docs/SPEC.md`. **Phase:** 2 (Core Enhancements) · **agent + B2C surface.**

**Builds on:** *Fast Sale via Bottom Sheet* (`docs/pos/fast-sale-bottom-sheet.spec.md`, US-AG31/AG32) —
the sheet this feature adds a second body to · *Reactive Date & Time Matrix*
(`docs/pos/reactive-date-time-matrix.spec.md`, US-AG33/AG34) · *POS Controlled Discount*
(`docs/pos/pos-controlled-discount.spec.md`) — `confirmSale`, the price floor, the atomic decrement ·
*Folio QR Signing* (`docs/qr/folio-qr-signing.spec.md`) — the token this feature wraps in a URL ·
*Tourist Self-Service Portal* (`docs/tourist-portal/tourist-self-service-portal.spec.md`) — the SSR
shell and `qrSvg()` reused by the ticket page · *WhatsApp QR Ticket Delivery*
(`docs/whatsapp-qr-delivery/whatsapp-qr-delivery.spec.md`) — the delivery axis this feature feeds.

**Sibling:** *Group Redemption* (`docs/scanner/group-redemption.spec.md`, US-AG48/US-A81) — one scan
boards a whole party. Independent of this feature, but the two are why a family of four becomes
**one** QR, **one** scan.

---

## Context

A walk-up customer at a booth wants four seats on the boat leaving in forty minutes and is holding
cash. Today the agent closes that sale like this:

| # | Interaction | Surface |
|---|---|---|
| 1 | Tap the service card | `/pos` → `ServiceSheet` opens |
| 2–3 | Set party to 4, tap the 16:00 chip | sheet |
| 4 | Tap *Agregar al carrito* | sheet closes, Snackbar |
| 5 | Tap *Ver carrito* | → `/pos/checkout` |
| 6–7 | Type the customer's **name**, type the **phone** | checkout |
| 8 | Confirm the amount (pre-loaded) | checkout |
| 9 | Tap *Cobrar* | → `/pos/folio/:id` |
| 10 | Tap *Enviar boletos por WhatsApp* | **leaves the app** |
| 11 | Send, inside WhatsApp | WhatsApp |
| 12 | Return to the app, navigate back to `/pos` | — |

**Twelve interactions, three routes, and an application switch**, to sell one service for cash to a
person who is physically standing there. The next customer in the queue waits through all of it.

Two costs stand out, and neither is the tap count on its own:

1. **The cart and checkout exist to solve problems this sale does not have.** A cart carries multiple
   lines; this sale has one. Checkout chooses a payment method; this sale is cash. Checkout derives
   full-vs-apartado from an amount; this sale is always full. Checkout collects a name for the
   WhatsApp template; this customer is receiving their ticket in person.
2. **Step 10 is the loop-breaker.** The only automatic delivery leaves the application. `wa.me` is
   the agent's own WhatsApp, so the agent must switch apps, send, and come back — per customer, with
   a queue in front of them. The one thing that must not happen in a fast sale is the agent losing
   the screen.

Express is the same sale, on one surface, ending with the ticket handed across the counter:

| # | Interaction |
|---|---|
| 1 | Tap ⚡ on the service card |
| 2 | Set seats (`+`, or `+5` / `+10`) |
| 3 | Type the phone |
| 4 | Tap *Cobrar* — the QR appears full-bleed; the customer scans it with their own camera |

Four interactions, one surface, no app switch, and the sheet is already reset for the next customer.

**Delivery inverts.** Today the agent pushes a link to the customer. In Express the customer **pulls**
their ticket by scanning the code on the agent's screen — which is both faster and a stronger receipt
signal than the portal beacon, because a phone camera cannot be a crawler. A customer who cannot or
will not scan is not lost: the folio stays `● Pendiente de enviar` and surfaces in a **pending-delivery
queue**, where the existing one-tap WhatsApp finishes the job later — and where a future WhatsApp
Business API integration will finish it automatically.

---

## Scope boundary

**What this feature must not change:**

1. **`confirmSale` is the same endpoint on the same path.** Express supplies a different *payload
   shape*, not a different code path — same Zod schema module, same validate → insert-folio →
   atomic per-line decrement → `compensate()` → batch, same `folio_payments` writes, same commission
   snapshot. Express adds no second sale implementation.
2. **Mechanically checkable:** these must pass **unedited** —
   `test/pos/pos-controlled-discount.test.ts`, `test/pos/pos-bookings-create.test.ts`,
   `test/pos/pos-sales-cutoff.test.ts`, `test/pos/pos-zoned-sales.test.ts`,
   `test/paid-ledger/cash-engine-ledger.test.ts`, `test/tickets/online-qr-scanner.test.ts`,
   `test/qr/folio-qr-signing.test.ts`, `test/portal/tourist-self-service-portal.test.ts`.
3. **A folio with `sale_mode = 'standard'` behaves byte-identically to today**, including the
   name-required validation. Express is reachable only through a payload that says so.
4. **The cancellation ladder is untouched.** The void (D14) is a separate, guarded path that never
   calls `cancelFolioPriced`; `test/cancellation/*` must pass unedited.
5. **Every QR already issued keeps scanning.** The URL form is a render-time wrapper; the stored
   token is unchanged, and the scanner accepts both forms forever (D9).

---

## Design decisions

| # | Decision | Why |
|---|---|---|
| **D1** | Express is a **second body inside the existing `ServiceSheet`**, not a new route — `ExpressSalePanel.tsx` beside `ServiceSelectionPanel.tsx`. | `ServiceSheet` already owns `usePosService`, the loading/error states and the org timezone. A separate route would fork the slot and capacity logic, which is precisely how the POS grew four copies of "pick a time". |
| **D2** | Entry point is a **⚡ icon button on the POS catalog card**; the card body keeps opening the standard sheet. | No regression to the shipped flow, and the mode is chosen per sale rather than held in a mode the agent can forget. A global toggle would let an agent take cash under the wrong flow. Requires restructuring the card away from its single `CardActionArea` (a nested button inside one is a DOM-nesting and a11y fault). |
| **D3** | Express **bypasses the cart and `/pos/checkout` entirely** — it calls `confirmSale` directly with one synthesized line. | The cart's only job is multi-line staging, which Express does not have. Routing through it would re-introduce every screen this feature removes. |
| **D4** | Eligible services: **slot-based, `zones_enabled = false`, at least one sellable slot today**. Lodging, zoned services and extras are excluded; the ⚡ simply does not render. | Lodging is a date-range primitive with no slots. A zoned service needs a zone pick, and defaulting one would silently oversell a deck. Extras are a second decision per sale. Each exclusion is a whole sub-flow that Express cannot collapse. |
| **D5** | Express is **same-day only** and **ignores the catalog's `selectedDate`**. | The premise is a customer standing in front of the agent. Inheriting a catalog filtered to Saturday would sell a walk-up a ticket for Saturday. This is a deliberate divergence from US-AG31's inheritance rule. |
| **D6** | The **nearest fitting departure is preselected**: earliest slot today with `start_time > now + sales_cutoff` and `effectiveRemaining ≥ partySize`. **Every** of today's departures stays visible with its remaining count. | US-AG32 hides non-fitting slots because it *clears* the selection and expects a re-pick. Express **holds** the selection (D7), so hiding would trap the agent: the 16:00 has 2 seats, a group of 10 arrives, the count clamps to 2, and the 17:00 with 40 free is invisible. Deliberate divergence from US-AG32. |
| **D7** | Once picked, the **departure is held**. Growing the party **clamps** to that slot's effective remaining and says why — *"Máx 2 en las 16:00 · 17:00 tiene 40"*. It never auto-advances. | The agent decides which boat they are selling; the software does not move their sale under them. The named alternative is what makes the clamp non-trapping. |
| **D8** | Seats: `−` / `+` plus **`+5` and `+10` shortcuts**, additive, clamped as D7. | A group of ten is exactly the demand spike Express exists for; ten taps of `+` is not a fast sale. Additive rather than set-to, so the chips compose with the stepper. |
| **D9** | The QR encodes **`${API_BASE_URL}/t/<qr_token>`** instead of the bare token, for **all sales**. `folio_lines.qr_token` keeps the raw token; `TicketQr` wraps at render; the scanner strips a known URL prefix before verifying. | A phone camera scanning `<payload>.<signature>` shows unusable text. A URL makes the same code serve two readers — tourist camera and agent scanner. Applied everywhere because two QR encodings in one system is a fork waiting to happen; the scanner must tolerate both regardless, since QRs already sit in customers' inboxes. |
| **D10** | `/t/:token` renders a **minimal ticket page** — service, date, time, `N pases`, the QR. **Never** the customer name, the amount, or the Refund PIN. | Whoever holds the QR can already board with it; that risk is inherent. The portal additionally carries a 6-digit Refund PIN that is the tourist's proof for collecting cash. A photographed QR must not become a refund credential. |
| **D11** | `/t/:token` is **line-scoped and read-only**. It never redeems. Redemption remains exclusively `POST /api/tickets/scan`. | A tourist checking their ticket on the bus must not burn their own seat. Line scope also means least privilege: one QR opens one boarding pass, not the whole folio. Division of labour: **`/t/` = one boarding pass · `/portal/` = the whole reservation**. |
| **D12** | `/t/:token` derives the org key from the payload's **`organization_id`**, not from a caller. | There is no caller — the route is public. This is a deliberate departure from the scanner's caller-org derivation, which exists to stop org A redeeming org B's ticket. Forgery still requires `QR_SECRET`, so the signature guarantee is unchanged. Recorded because the scanner spec states the opposite rule for its own path. |
| **D13** | A tourist scan sets **both `tickets_sent_at` and `tickets_viewed_at`**, via the same JS-beacon pattern as the portal. | Handing the QR across the counter *is* the send. Setting only *Visto* would leave the folio reading "viewed but never sent" and sitting in the pending queue prompting a redundant WhatsApp. The beacon (not a raw GET) keeps the signal honest, consistent with whatsapp-qr-delivery D6. |
| **D14** | A mis-tapped Express sale is undone by a **void**, not a cancellation: `POST /api/pos/folios/:id/void`, **selling seller only**, `sale_mode = 'express'`, **≤ 60 s**, not delivered, `redeemed_count = 0`, not settled. | An agent **cannot** undo their own paid sale today — the agent cancel route is booking-only and `/api/folios/*` is admin-only. An admin cancel would run the ladder, which for a same-day departure is the terminal tier: 0 % refund, 100 % commission retained — the company keeping the money for a sale that never happened. 60 s because the guards, not the clock, are what make it safe; 10 s is shorter than noticing. |
| **D15** | The void **bypasses the cancellation ladder entirely** and settles the refund immediately: `refund_status = 'refunded'`, `refunded_at/by` set, **`refund_pin` stays null**. | A void asserts the sale never happened; a cancellation prices an unwinding. Minting a PIN for cash already handed back across the counter would open a fake obligation in the admin refund queue that someone must then close. |
| **D16** | Scope of the void is **Express sales only**. | Smallest surface, and it cannot become a backdoor around the ladder for ordinary sales. The general case is already specified as US-AG44/US-A73 and stays there. |
| **D17** | **No customer name in Express.** `customer_name` is left null. | It is already **nullable in the DB** — only `confirmSaleSchema` requires it — so this is a validation change with no migration. The name exists to address a WhatsApp template; a customer receiving their ticket in person is not being addressed. Deliberate, documented exception to whatsapp-qr-delivery **D2**. |
| **D18** | **Phone stays required** and dialable, exactly as D2 requires. | It is the fallback-delivery handle for the pending queue, the folio's contact of record, and the manifest key if manifest boarding is ever built. It is the one field worth typing. |
| **D19** | Express is **always full payment in cash**. No method toggle, no `down_payment`, no apartado. | "Reservations are not supported" is the product decision; cash-only means the sale enters the seller's caja through the ordinary ledger row with no new money path. |
| **D20** | After *Cobrar*: **service and departure held**, seats → 1, price → base, phone cleared. Confirmation strip with *Mostrar QR*, *WhatsApp*, *Deshacer (60 s)*, plus a header tally **"Esta sesión · N ventas · $X"**. | The next five customers usually want the same boat; re-selecting it discards the taps this feature just saved. The tally is labelled *sesión*, never *caja* — the authoritative caja figure is computed at `/balance` over the whole shift, and two different numbers under one label is how reconciliation disputes start. |
| **D21** | `POST /api/pos/folios` accepts a client-generated **`idempotency_key`**; a replay returns the existing folio. | At speed, a double-tap or a 3G retry writes a second folio **and** a second `folio_payments` cash row — real duplicated cash debt against the agent, discovered at the cash drop. This is the highest-risk gap in the design and it is not visible in the UI. |
| **D22** | `folios.sale_mode` (`standard \| express`) is persisted. | Measuring whether the mode is used is the point of shipping it, and a cash-reconciliation dispute will want to know how the sale was taken. One additive column. |
| **D23** | Pending-delivery surfaces reuse the existing axis: admin `SectionCard` on `/dashboard`; count badge on *Ventas* plus a **"Sin entregar"** filter chip for agent/affiliate. **No new route.** | `tickets_sent_at` / `tickets_viewed_at` and `DeliveryBadge` already exist (US-AG40). `/dashboard` is admin-only and agents land on `/pos`, so the two audiences need two placements — matching how `/balance` and `/folios` already carry role-scoped badges. |
| **D24** | **No change calculator** in this phase. | Raised and declined. Noted here because cash-only plus a `+10` shortcut means large tenders; if agents are doing that arithmetic on paper, it is a cheap follow-up (see *Deferred*). |
| **D25** | **The scanner's re-arm tap is untouched.** | `ScannerPage` pauses after each scan so one QR produces exactly one request. With group redemption (sibling spec) cutting a family of four from four scans to one, the remaining tap is no longer the bottleneck, and a working race guard is not worth disturbing in this PR. |

---

## Data Model

### Migration `0057_express_sale.sql`

```sql
-- US-AG45 (D22) — how the sale was taken. Existing rows are standard by definition.
ALTER TABLE `folios` ADD COLUMN `sale_mode` text NOT NULL DEFAULT 'standard';

-- US-AG45 (D21) — client-generated replay guard. Nullable: pre-feature and standard
-- sales carry none. Partial unique index so many NULLs coexist while a key is unique
-- within its organization.
ALTER TABLE `folios` ADD COLUMN `idempotency_key` text;
CREATE UNIQUE INDEX `folios_idempotency_key_idx`
  ON `folios` (`organization_id`, `idempotency_key`)
  WHERE `idempotency_key` IS NOT NULL;
```

Drizzle (`src/db/schema.ts`, `folios`):

```ts
saleMode: text('sale_mode', { enum: ['standard', 'express'] }).notNull().default('standard'),
idempotencyKey: text('idempotency_key'),
```

**No new table.** The ticket page authenticates with `folio_lines.qr_token`, which is
self-verifying — unlike `folio_access_tokens`, it needs no row to prove itself.

> The sibling spec `docs/scanner/group-redemption.spec.md` adds
> `organizations.qr_redemption_mode` in the **same** migration file. One migration, two features,
> because they ship together; if they are split, the column moves to `0058`.

---

## Business rules (enforced server-side)

1. An Express confirm carries `sale_mode: 'express'`, exactly **one** `slot` line, **no** extras,
   **no** `down_payment`, and `payment_method: 'cash'`. Any violation → `422 EXPRESS_PAYLOAD_INVALID`.
2. `customer_name` is **optional when `sale_mode = 'express'`** and remains **required** otherwise
   (D17). `customer_phone` is required and dialable in **both** modes (D18).
3. The line's service must satisfy D4: slot-based, `zones_enabled = false`. A zoned or lodging
   service → `422 EXPRESS_NOT_ELIGIBLE`. *(The frontend hides the ⚡; this is the server's own gate.)*
4. `unit_price` is validated against the **snapshot** exactly as today —
   `minimum_price ≤ unit_price ≤ base_price`, else `400 PRICE_BELOW_MINIMUM` / the base-price ceiling
   error. Express introduces **no** new pricing authority and **no** surge.
5. Slot availability, the Effective Capacity ceiling, the sales cutoff (`409 SLOT_CLOSED`) and the
   atomic decrement (`409 SLOT_UNAVAILABLE`) apply unchanged.
6. When `idempotency_key` is present and a folio already exists for `(organization_id,
   idempotency_key)`, the request is a **replay**: return that folio with `200`, perform no
   inventory or ledger write (D21).
7. The **void** (D14) requires **all** of: caller is the folio's `agent_id`; `sale_mode = 'express'`;
   `status = 'paid'`; `now − created_at ≤ 60 s`; `tickets_sent_at IS NULL` **and**
   `tickets_viewed_at IS NULL`; every line has `redeemed_count = 0`. Any failure →
   `409 VOID_WINDOW_CLOSED` with the reason. The window check is server-side; the countdown in the
   UI only mirrors it.
8. A void **releases the seats** (`booked = MAX(0, booked − quantity)`), writes a **full** reversal of
   the folio's `payment` and `commission` ledger rows dated **now**, and sets `status = 'cancelled'`,
   `cancellation_source = 'agent'`, `refund_status = 'refunded'`, `refund_amount = amount_paid`,
   `refunded_at/by` — and **never** mints a `refund_pin` (D15). It does **not** call
   `cancelFolioPriced` and does **not** read the cancellation policy.
9. `GET /t/:token` verifies the HMAC under the key derived from the payload's `organization_id`
   (D12) and is **read-only** — it never writes `redeemed_count` (D11). An invalid signature, an
   unknown line, or an expired payload renders the generic not-found page; a **cancelled** folio
   renders "Este boleto fue cancelado" with **no QR**, mirroring the portal's Rule 3.
10. `POST /t/:token/seen` sets `tickets_sent_at` **and** `tickets_viewed_at` if unset (first write
    wins, idempotent) and returns `204` (D13).

---

## Authorization — who may do this

| Action | Who |
|---|---|
| Express confirm (`sale_mode: 'express'`) | `agent`, `admin`, `affiliate`, and affiliate **operators** — identical to the standard confirm. Express is a mode, not a privilege; each seller's cash lands in their own caja exactly as today. |
| `POST /api/pos/folios/:id/void` | **The folio's own `agent_id` only.** Not an admin — an admin already has the ladder-priced cancel path (D16). An operator session acts as its manager, so the manager's `agent_id` is the owner. |
| `GET /t/:token`, `POST /t/:token/seen` | **Public**, registered outside `/api/*` like `/portal/*`, so CORS and `authMiddleware` never apply. The token is the credential. |
| Pending-delivery queue | Admin sees the org; agent and affiliate see their own — the existing folio-list scoping, unchanged. |

**Cross-org:** every tenant-scoped query ANDs `organization_id` from context. A void against another
org's folio returns **`404`**, never `403`. A `/t/:token` for a foreign org resolves normally *for its
own org* — the token maps 1:1 to one line and grants nothing else; there is no listing surface to leak
across.

---

## API surface

### `POST /api/pos/folios` — extended, not replaced

```jsonc
{
  "sale_mode": "express",              // optional, default "standard"
  "idempotency_key": "01J8…",          // optional; client-generated, unique per attempt
  "customer_name": null,               // optional ONLY when sale_mode = "express"
  "customer_phone": "5512345678",      // required, dialable
  "payment_method": "cash",
  "lines": [
    { "slot_id": "slt_…", "quantity": 4, "unit_price": 120000, "extras": [] }
  ]
}
```

Server-derived and refused from the body, as today: `organization_id`, `agent_id`, `status`,
`total`, `commission_amount`, `cancellation_policy_snapshot`, every QR token.

### `POST /api/pos/folios/:id/void`

Empty body. `200 { "id", "status": "cancelled", "refund_amount", "released_seats" }`.

### `GET /t/:token` — public SSR

HTML. Reuses `renderer.tsx`, the `.portal-*` classes in `style.css`, `qrSvg()`, `formatSlotDate`
and an extracted shared `<TicketCard>`. Carries the beacon script.

### `POST /t/:token/seen` — public

`204`. Idempotent, first write wins.

### Error responses

| Code | HTTP | When |
|---|---|---|
| `EXPRESS_PAYLOAD_INVALID` | 422 | Express confirm with ≠1 line, extras, a `down_payment`, or a non-cash method |
| `EXPRESS_NOT_ELIGIBLE` | 422 | Express confirm against a zoned or lodging service |
| `VOID_WINDOW_CLOSED` | 409 | Any void guard fails (expired window, delivered, redeemed, settled, not the seller) |
| `PRICE_BELOW_MINIMUM` | 400 | Unchanged |
| `SLOT_CLOSED` / `SLOT_UNAVAILABLE` | 409 | Unchanged |

---

## Frontend

Design system: `.design/design-system/DESIGN_TOKENS.md`. Teal is the one primary CTA per surface;
money is `MoneyText`, never teal; state is icon-paired functional colour.

**`PosCatalogPage`** — the card is restructured off its single `CardActionArea` into explicit tap
zones (the pattern `ListRow` already uses) so the **⚡ `IconButton`** can sit top-right without
nesting a button inside a button. It renders only for D4-eligible services. Body tap is unchanged.

**`ServiceSheet`** — takes a `mode: 'standard' | 'express'`; renders `ExpressSalePanel` for express.
Everything else (the `usePosService` read, spinner, error, org timezone) is shared. *(It duplicates
the shared `BottomSheet` markup today; not this feature's job to fix, noted in `TECH_DEBT.md`.)*

**`ExpressSalePanel`** (new) — fixed header (service · session tally) · seats row (`−`/`+`, `+5`,
`+10`, clamp message) · today's departures with counts, nearest preselected, none hidden · price
field clamped `[minimum, base]` · phone field · pinned **Cobrar** footer showing the live total in
`MoneyText`. On success it swaps the footer for the confirmation strip (D20) and resets.

**`ExpressTicketOverlay`** (new) — the counter-handoff panel, **non-blocking**: docked in the
**lower half** of the sheet (between the scroll body and the pinned footer), never a modal — a
backdrop would block exactly the selling loop Express protects. QR at **≥ 280 px**, error level
**L**, on pure white with a teal top edge marking the handoff zone; the form above stays live, so
the agent starts the next sale while this customer is still scanning. Auto-hides after ~20 s so it
is not left exposed to the queue; re-opened by *Mostrar QR*. *(Amended in build from the original
full-screen design — confirmed with product: the handoff must not interrupt the loop.)*

**Ticket page** (Worker SSR) — `<TicketCard>` extracted from `PortalPage`'s line `.map` and shared by
both pages. The ticket page renders **only** that card plus the beacon: no header total, no
`CancellationBlock`, no PIN.

**Delivery queue** — admin `SectionCard` on `/dashboard`; count badge on *Ventas* and a
**"Sin entregar"** chip on `/history` and `/folios`, driven by the existing `DeliveryBadge` state.

**Scanner** — `stripTicketUrl()` applied to the scanned string before verification, so both encodings
work. No other change (D25).

---

## Scenarios

### US-AG45 — the express sheet

**S-1 — ⚡ opens Express without leaving the catalog**
Given an eligible service with a sellable slot today
When the agent taps ⚡ on its card
Then the sheet opens in express mode with the nearest fitting departure already selected, and the
catalog stays mounted beneath.

**S-2 — ⚡ is absent where Express cannot work**
Given a zoned service, a lodging unit type, and a service whose last departure today has passed
When the catalog renders
Then none of the three shows a ⚡.

**S-3 — The catalog date is ignored**
Given the catalog is filtered to `today + 2`
When the agent opens Express
Then the departures shown are **today's**.

**S-4 — Seats clamp to the held departure and name the alternative**
Given the 16:00 departure is selected with effective remaining 2, and the 17:00 has 40
When the agent taps `+10`
Then the count clamps to 2, the 16:00 stays selected, and the panel reads
*"Máx 2 en las 16:00 · 17:00 tiene 40"* — the 17:00 is visible throughout.

**S-5 — A sale closes with phone only**
Given seats 4, the price at base, a dialable phone, and no name typed
When the agent taps *Cobrar*
Then a folio is created `status='paid'`, `sale_mode='express'`, `customer_name IS NULL`, one line of
4, one `folio_payments` row `entry_type='payment'` `method='cash'`, and one `commission` row.

**S-6 — A standard sale still requires a name**
Given a `sale_mode='standard'` confirm with `customer_name` omitted
When it is submitted
Then it is rejected exactly as today — Express's exemption does not leak.

**S-7 — Price stays inside the snapshot floor and ceiling**
Given `minimum_price = 120000`, `base_price = 150000`
When an Express confirm sends `unit_price = 119999`
Then `400 PRICE_BELOW_MINIMUM`; and at `150001` the base-price ceiling error.

**S-8 — A replayed confirm creates one folio**
Given an Express confirm with `idempotency_key = K` that succeeded
When the identical request is sent again
Then `200` with the **same** folio id, `slots.booked` is unchanged, and exactly **one** payment row
exists for that folio.

**S-9 — Express payload guards**
Given an Express confirm carrying two lines / an extra / a `down_payment` / `payment_method:'transfer'`
When it is submitted
Then `422 EXPRESS_PAYLOAD_INVALID` in each case, and no folio is created.

### US-AG46 — the reset loop

**S-10 — The sheet resets but keeps the boat**
Given a completed Express sale of 4 seats at 16:00
When the confirmation strip appears
Then the service and the 16:00 departure remain selected, seats read 1, the price is back at base,
the phone is empty, and the header tally increments by one sale and by the sale's total.

### US-AG47 — the 60-second void

**S-11 — A mis-tap is undone inside the window**
Given an Express sale confirmed 15 s ago, not delivered, nothing scanned
When its seller calls `POST /api/pos/folios/:id/void`
Then the folio is `cancelled`, the seats are back on the slot, the `payment` and `commission` rows
are fully reversed dated now, `refund_status='refunded'` with `refunded_at` set, and
**`refund_pin IS NULL`**.

**S-12 — The void nets the seller's caja to zero**
Given the seller's cash balance before the sale was `B`
When the sale is confirmed and then voided
Then `deriveBalance` returns `B` — the reversal lands in the same shift.

**S-13 — The ladder is never consulted**
Given an org whose cancellation policy terminal tier retains 100 %
When an Express sale is voided
Then the refund is the **full** `amount_paid`, no commission is retained, and
`cancellation_policy_snapshot` is not read.

**S-14 — Every guard closes the window**
Given, in turn: 61 s elapsed · `tickets_viewed_at` set · a line with `redeemed_count = 1` ·
a `sale_mode='standard'` folio · a different agent calling
When the void is attempted
Then `409 VOID_WINDOW_CLOSED` in each case and nothing is written.

### US-T07 — the tourist scans the QR

**S-15 — The camera resolves to a ticket**
Given a paid Express folio whose line has a `qr_token`
When `GET /t/<token>` is requested
Then the page renders the service, date, time and `N pases` with the QR — and contains **no**
customer name, **no** amount, and **no** refund PIN.

**S-16 — Viewing never redeems**
Given `redeemed_count = 0`
When `/t/:token` is loaded ten times
Then `redeemed_count` is still 0.

**S-17 — A cancelled folio shows no ticket**
Given the folio was voided or cancelled
When `/t/:token` is loaded
Then it reads "Este boleto fue cancelado" and renders no QR.

**S-18 — A tampered or foreign token is refused**
Given a token with one flipped payload byte, and a token signed under another org's key
When each is loaded
Then both render the generic not-found page — no distinction between "invalid" and "not ours".

**S-19 — The scan closes the delivery loop**
Given `tickets_sent_at IS NULL`
When the tourist's browser fires `POST /t/:token/seen`
Then **both** `tickets_sent_at` and `tickets_viewed_at` are set, and the folio leaves the pending
queue.

**S-20 — Both QR encodings scan**
Given one QR rendered as the raw token (pre-feature, sitting in an inbox) and one as
`${API_BASE_URL}/t/<token>`
When each is scanned at `POST /api/tickets/scan`
Then both verify and redeem identically.

### US-A80 — the pending-delivery queue

**S-21 — An unscanned sale is visible to both audiences**
Given an Express sale whose customer never scanned
When the admin opens `/dashboard` and the seller opens `/history`
Then both see it counted as *sin entregar*, and the existing one-tap WhatsApp sends it.

### Multitenancy isolation (required)

**S-22 — A foreign folio cannot be voided**
Given two organizations seeded with `seedTwoOrgs`
When org A's agent calls `POST /api/pos/folios/:id/void` for org B's folio
Then `404` — never `403`, which would confirm it exists.

**S-23 — A foreign ticket token resolves to nothing usable**
Given org B's `qr_token`
When org A's scanner submits it to `POST /api/tickets/scan`
Then `INVALID_SIGNATURE` — the caller-org key derivation is unchanged by this feature.

---

## Definition of Done

- [x] Migration `0057` — `folios.sale_mode`, `folios.idempotency_key` + partial unique index;
      Drizzle schema updated; no binding shift (no `wrangler.jsonc` change), so no cf-typegen
- [x] `confirmSaleSchema` extended: `sale_mode`, `idempotency_key`, conditional `customer_name`;
      rules 1–6 enforced in `confirmSale`
- [x] `POST /api/pos/folios/:id/void` — rules 7–8, no call into `cancelFolioPriced`
- [x] `GET /t/:token` + `POST /t/:token/seen` — rules 9–10, registered outside `/api/*`
- [x] `TicketQr` renders the URL form; `stripTicketUrl()` in the scan path; both encodings verified
      (S-20)
- [x] Server scenarios S-5–S-9, S-11–S-20 covered in `test/pos/express-sale.test.ts` and
      `test/portal/ticket-page.test.ts`; the sheet behaviours S-1–S-4/S-10 (added in build:
      frontend-only) are verified by build/lint, matching the fast-sale spec's precedent
- [x] Cross-org isolation S-22/S-23 using `seedTwoOrgs` (in the two suites above)
- [x] Frontend: card ⚡ (an absolutely-positioned SIBLING of the `CardActionArea` — see the
      amendment note below), `ExpressSalePanel`, `ExpressTicketOverlay`, shared `<TicketCard>`,
      delivery-queue surfaces
- [x] `pnpm build:app` and `pnpm lint:app` clean; API suite 689/689
- [x] `SPEC.md`: US-AG45/AG46/AG47, US-T07, US-A80 under their roles; one Features-by-Phase line;
      glossary — *Venta Express*, *Ticket page (`/t/`)*, *Void*

---

## Amended in build

- **Rule 7's window is measured in SQL** (`unixepoch() - created_at`), not in JS: the Workers
  runtime freezes `Date.now()` per request (the test pool pins it outright), while `created_at`
  is stamped by `unixepoch()` — one clock, the DB's, or the window drifts.
- **The catalog read gained `express_eligible`** (boolean per tour card): D4's eligibility needs
  `zones_enabled` + a sellable slot TODAY, neither of which the lightweight card payload carried.
  Today-anchored regardless of the selected window (D5).
- **The replay response** (rule 6) is `200 { folio, replayed: true }` in the same shape as
  `GET /api/pos/folios/:id`, so the client renders it exactly like the sale it already made.
- **The ⚡ is an absolutely-positioned sibling** of the `CardActionArea`, not a restructure of the
  card into explicit tap zones — same a11y outcome (no button nested in a button), a fraction of
  the churn.
- **S-21's queue count** is derived client-side from the existing paid-list reads (shared query
  cache), not a new endpoint — the delivery axis already travels on the list payloads.
- **The QR handoff is non-blocking** (product decision post-build): `ExpressTicketOverlay` was
  first a full-screen Dialog, which held the sheet hostage for up to 20 s per customer — the exact
  interruption Express exists to remove. It is now a panel docked in the sheet's lower half with
  the form live above it; sale N+1 starts while customer N is still scanning.

## Deferred — and why each is safe to defer

| What | Why it can wait |
|---|---|
| **Change calculator** (*Recibí / Cambio*, denomination chips) | Declined for this phase (D24). Purely additive UI over state Express already holds; no schema, no endpoint. If agents are doing the arithmetic on paper, it drops in as a follow-up without touching anything here. |
| **Manifest boarding** (seat by last-4 of phone, no QR) | The QR doing double duty (D9/D10) covers delivery, and `customer_phone` is captured on every Express sale (D18), so the data it needs already exists. It is a scanner-side feature with its own story. |
| **Per-service Express eligibility flag** | D4's derived eligibility needs no admin configuration. A `services.express_enabled` column can be added later with the derived rule as its default — no data migration. |
| **Offline / queued Express sales** | The MVP is online-only by design (`SPEC.md` § Design Principles). D21's idempotency key is what makes an eventual retry-queue safe, and it ships now. |
| **WhatsApp Business API auto-delivery** | The pending-delivery queue (D23) is the seam: today a human taps, later the API fills the same queue automatically. Belongs in `docs/integrations/` with its per-message cost. |

---

## Known behaviour change

1. **Every newly rendered QR is a URL, not a bare token.** A tourist who scans a *new* ticket with a
   plain camera now lands on a page instead of seeing gibberish. QRs already sent as email images
   stay raw and keep working; the scanner accepts both indefinitely.
2. **`customer_name` can now be null on a paid folio.** Surfaces that assume a name must fall back —
   `Cliente · ••1234` — and the WhatsApp templates must degrade on `{customer_name}`. This is the
   documented exception to whatsapp-qr-delivery **D2**; standard sales are unchanged.
3. **A folio can now reach `cancelled` without the cancellation ladder ever running** (the void).
   Reports that assume `cancelled ⇒ a policy snapshot was evaluated` must tolerate it;
   `cancellation_source = 'agent'` with `sale_mode = 'express'` and a sub-minute lifetime is the
   signature.
4. **Delivery status can flip to *Enviado* without any agent tapping WhatsApp** (D13). Any metric
   counting agent sends must read `tickets_sent_by` (null for a counter handoff), not
   `tickets_sent_at`.

---

## Open

| Question | Smallest change that answers it |
|---|---|
| **Does a URL-form QR reliably scan off a phone screen, in sunlight, at arm's length?** The token is `<payload>.<signature>` with three UUIDs — 300+ chars before the URL prefix — and Express's entire delivery rides on this. | Render one on a real device at 280 px / level L and scan it outdoors with a mid-range Android. If it fails, D9 changes shape: a short opaque redirect id resolving server-side to the token, which is a data-model change and must be decided before build. |
| Spanish copy for the clamp message, the confirmation strip and the ticket page | Draft in the PR; the admin does not configure these, so no template plumbing. |
| Does the ⚡ belong on the affiliate POS too? | D-level answer is yes (Express is a mode, not a privilege), but no affiliate has asked. Gate on the same eligibility rule; revisit if an affiliate reports the card is cluttered. |
| Should the void window be org-configurable? | A `organizations.express_void_seconds` column, defaulted to 60. Deliberately not shipped — one more knob for a number nobody has yet argued about. |
