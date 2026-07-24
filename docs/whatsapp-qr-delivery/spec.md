# Feature: WhatsApp Ticket Delivery — Agent-Sent Portal Link, Delivery Tracking & Portal-View Acknowledgment ("Visto")

**User stories:** US-AG39 (agent sends tickets via WhatsApp),
US-AG40 (delivery state: Pendiente → Enviado → Visto), US-T06 (portal-view acknowledgment / "Visto"),
US-A65 (admin-edited message templates). Registered in `docs/SPEC.md`. **Phase:** 2 (Core
Enhancements) · **agent + B2C surface.**
**Depends on:** *Client Ticket Delivery* (`docs/email/client-ticket-delivery.spec.md`) — reuses the
portal link + QR echo, and the fire-and-forget dispatch pattern · *Tourist Self-Service Portal*
(`docs/tourist-portal/tourist-self-service-portal.spec.md`) — the portal page the link opens and
its `folio_access_tokens` model · *Booking WhatsApp Recovery* (US-AG07.3) — the `wa.me` deep-link
pattern this generalizes.

> **What & why.** Today a paid sale's tickets reach the customer **only** by an auto-sent email —
> and email at a street POS is unreliable (typos, spam, no address). This feature makes the
> **agent** deliver the tickets over **WhatsApp**, one tap, from the sale they just closed:
> `wa.me/<phone>?text=…` carrying the **portal link** (itinerary + QR + cancellation). Because
> `wa.me` is text-only it can't attach the QR image — the *link* is the deliverable, exactly what
> the email already carries. To make the loop **visible and accountable**, the folio moves along a
> delivery axis — **Pendiente de enviar → Enviado → Visto** — where **Visto** is set when the
> tourist actually **opens their portal** (a bot-proof client-side beacon), giving the dashboard a
> real proof-of-receipt it has never had.

---

## Context

**How delivery works today.** On a **paid** confirm, `confirmSale` (`routes/pos/handler.ts`)
fires `dispatchTicketEmail` (fire-and-forget via `waitUntil`) **iff** `customerEmail` is set and
`RESEND_API_KEY` exists. The email carries the folio lines, QR images (via `api.qrserver.com` from
each line's signed token), and a **portal magic-link** — `${API_BASE_URL}/portal/<token>` — the
tourist self-service portal (itinerary, QR, cancellation, refund PIN; no account). That portal link
is generated **server-side only** (`issuePortalLink`) and is **not returned to the client**.

**Key domain facts that shape this feature:**
- A **QR is a per-slot boarding pass** (`TicketPayload.slot_id` + `passes_total`, `utils/qr.ts`);
  the scanner **redeems one pass** at the departure (`scanTicket`, `routes/tickets/handler.ts`).
- **Lodging has no QR** — a stay is a date-range reservation (`utils/lodging.ts`), access is the
  reservation looked up at check-in. It still gets a **portal link** (shows the reservation), so it
  participates in delivery keyed off **"portal link issued,"** not "QR issued."
- `wa.me` deep links are **text-only** — no image/PDF attach → the payload is the portal link.
- The existing `BookingWhatsAppButton` (US-AG07.3) already does agent-driven
  `window.open('https://wa.me/<phone>?text=…')`, and models a "did the agent act" signal
  (claim + `reminder_status`). This feature generalizes that pattern.
- `folio_access_tokens.last_accessed_at` is already touched on **document** load — but a raw GET is
  hit by **link-preview bots** (`facebookexternalhit`), so it is **not** a valid receipt signal.
  "Visto" needs a **JS beacon** the bots never execute (D6).

### Design decisions (✅ = confirmed with product)

| # | Decision | Choice | Rationale |
|---|---|---|---|
| D1 ✅ | **Delivery mechanic** | Agent-driven **`wa.me` deep link** carrying the **portal link** (text). The agent sends from their **own** WhatsApp. | Meets "provide a way for the agent to send." No WhatsApp Business API (business account, template approval, per-message cost, server media send) — and that would be automated, not "the agent sends it." Reuses the proven `BookingWhatsAppButton` path. |
| D2 ✅ | **Required contact fields** | **All POS sales** (agent/affiliate/admin): **Name required, Phone required, Email optional** (valid if present). | WhatsApp is now the primary channel → phone + a name to address are load-bearing; email drops to an optional CC. Uniform so there is one rule at `/pos/checkout`. |
| D3 ✅ | **Phone normalization** | Strip non-digits; if a bare **10-digit** number, prepend **`52`** (MX default); keep as-is if it already carries a country code. Validate before enabling send. | `wa.me` needs a full international number. Also **fixes the existing recovery flow**, which strips non-digits with **no** country code today (latent misroute bug). |
| D4 ✅ | **Delivery axis** (separate from payment status) | `● Pendiente de enviar → ◐ Enviado → ✓ Visto`. **Pendiente clears the instant the agent sends** (agent's metric, decoupled from tourist inaction). **Enviado** = agent tapped. **Visto** = tourist opened the portal. | Mirrors how `reminder_status` is a separate axis. The agent is accountable for **sending**; they cannot force a customer to open — so *Visto* is **visibility**, never the agent's KPI. |
| D5 ✅ | **Delivery trigger** | The axis applies once a **portal link is issued** (paid/settled folio) — tours **and** lodging. | Lodging has no QR but a real portal link; "QR issued" would wrongly exclude stays. |
| D6 ✅ | **"Visto" signal = JS beacon** | An inline `<script>` in the **server-rendered Hono portal page** POSTs `/portal/:token/seen` after render (`DOMContentLoaded`). Idempotent (first view wins). Bots that fetch HTML for previews never execute it. Optional: also skip known crawler UAs on the document route. | A raw document GET is forged by `facebookexternalhit` the moment the message is delivered → every folio would falsely flip. Requiring executed JS makes *Visto* mean a **human open**. Distinct from the naive `last_accessed_at`. |
| D7 ✅ | **Label is "Visto"** — never "Validado" | UI copy: **Visto** (Viewed). | "Validado / Boleto válido" already means the QR was **scanned/redeemed** at boarding — reusing it collides two unrelated events. |
| D8 ✅ | **Unified across channels** | *Visto* fires from **any** portal open — WhatsApp **or** email link. | One receipt-confirmation signal regardless of how the link reached the tourist. |
| D9 ✅ | **Affiliates → customer-direct** | Drop the affiliate **own-account email** delivery; the tourist (name+phone) is the target; affiliates re-access the sale from their own **`/history`**. | With uniform capture + WhatsApp, the affiliate-as-recipient path is redundant; sellers already have `/history` + `/history/:id` (renders `TicketQr`). |
| D10 ✅ | **Templates** | **Two** admin-edited templates in Settings (read-only for sellers), shipped defaults: **(1) Entrega** — one generic template for tours **and** lodging; **(2) Recordatorio de apartado** — replaces the current hardcoded reminder. `{portal_link}` **enforced on save**. | Admin owns brand voice; a generic delivery template reads fine for both tours and stays (the portal shows the right detail); enforcing `{portal_link}` prevents an undeliverable message. |
| D11 ✅ | **Placeholders** | `{customer_name} {agent_name} {org_name} {folio_ref} {total} {pending_balance} {portal_link}` + **auto-expanding `{itinerary}`** (tours: `name · date · time · pax`; lodging: `name · checkin–checkout · guests`). | Lets the admin build a rich message; `{itinerary}` renders one line per folio line by line type. |
| D12 ✅ | **No-WhatsApp customer** | Folio stays `● Pendiente` (accurate "not delivered via WhatsApp"). No escape hatch. | The pending badge **is** the accountability lever; email (if captured) + the receipt QR cover in-person. |
| D13 ✅ | **Double-send guard** | **Simple idempotent mark** (`tickets_sent_at` last-write-wins) — **no** atomic claim. | Seller sends immediately post-sale; the rare seller+admin race sending twice is acceptable for far less code than the recovery claim. |
| D14 ✅ | **Expired re-send** | **Disable** the send button when the portal token is expired ("enlace vencido"); do **not** regenerate. | The token outlives the trip by 7 days (cap 90); "expired" only exists long after the trip, when re-sending a past-date QR has no value. |
| D15 ✅ | **Surfaces** | Send/re-send + badge on: seller **receipt** (`/pos/folio/:id`), seller **history** (`/history` list badge + `/history/:id`), admin **folios** (`/folios` list badge + `/folios/:id`). | Covers who-must-send (seller) and who-oversees (admin). |

### Scope boundary

| Concern | Owner |
|---|---|
| Checkout field rules (name/phone required, email optional) + shared phone normalizer; expose the portal link to the client; folio delivery-tracking columns + `POST /folios/:id/ticket-delivery`; the `/portal/:token/seen` beacon + `tickets_viewed_at`; the receipt WhatsApp CTA + `TicketWhatsAppButton`; delivery badges on the four surfaces; the 2 admin templates + Settings editor | **This feature** |
| Portal token issuance, the SSR portal page, `folio_access_tokens` | *Tourist Self-Service Portal* — **reused**; this feature adds the beacon endpoint + inline script |
| QR minting/signing, the QR image, the scanner redemption | *Folio QR Signing* + scanner — **unchanged** |
| The auto-sent confirmation **email** | *Client Ticket Delivery* — **reused**; this feature only removes the affiliate own-email branch (D9) |
| The apartado **payment-reminder** WhatsApp (US-AG07.3) | **Reused**, re-pointed at the admin "Recordatorio" template (D10) — mechanics unchanged |
| WhatsApp **Business/Cloud API** (server-sent media, templates) | **Out of scope** (D1) |
| Proof the customer **received/read** the WhatsApp message itself | **Out of scope** — *Visto* proves a **portal open**, the strongest signal available without the Business API |

---

## Data Model

**Two migrations** (next: `0044`, `0045`). No new tables — columns on `folios` and `organizations`.

### `folios` — delivery-tracking columns (new · `0044`)

| Column | Type | Notes |
|---|---|---|
| `tickets_sent_at` | `integer` timestamp (nullable) | set when the agent taps send (D4/D13, idempotent last-write-wins). `NULL` ⇒ `● Pendiente de enviar` |
| `tickets_sent_by` | `text` → `users(id)` (nullable) | who sent (seller or admin) |
| `tickets_viewed_at` | `integer` timestamp (nullable) | first portal open via the beacon (D6). `NOT NULL` ⇒ `✓ Visto` |

**Derived state** (no stored enum): `Visto` if `tickets_viewed_at`; else `Enviado` if
`tickets_sent_at`; else `Pendiente de enviar` — **only** for folios that have a portal link issued
(D5). Folios with no portal link (unpaid apartado, pre-feature sales) are **off-axis**.

### `organizations` — message templates (new · `0045`)

| Column | Type | Notes |
|---|---|---|
| `wa_ticket_template` | `text` (nullable) | D10(1) delivery template; `NULL` ⇒ use the shipped default. Must contain `{portal_link}` (validated on save) |
| `wa_reminder_template` | `text` (nullable) | D10(2) apartado reminder; `NULL` ⇒ shipped default |

Run `pnpm cf-typegen:api` after the migration if bindings/types shift.

---

## Backend

1. **Expose the portal link to the client.** Return `portal_link` (the full `${API_BASE_URL}/portal/<token>` URL) on: the **confirm-sale response**, the seller **`/history/:id`** and admin **`/folios/:id`** detail responses, and enough on the **list** responses to drive the badge (`tickets_sent_at` / `tickets_viewed_at` + whether a portal link exists). Present only once issued (paid/settled).
2. **`POST /folios/:id/ticket-delivery`** — tenant-scoped, role `[agent, affiliate, admin]` scoped to folios they may reach. Sets `tickets_sent_at`/`tickets_sent_by` if unset (idempotent). Returns the new derived state.
3. **`POST /portal/:token/seen`** — **public**, token-scoped (same validation as the portal page). Sets `tickets_viewed_at` if unset (first-view). No auth; rate-limit-friendly and idempotent. Called by the beacon (D6).
4. **Portal beacon.** Add an inline `<script>` to the SSR portal page: on `DOMContentLoaded`, `fetch('/portal/'+token+'/seen', { method:'POST', keepalive:true })`. Same-origin (no CORS). Belt-and-suspenders: early-return the document route for known crawler UAs.
5. **Drop affiliate own-email** in the confirm/settle dispatch — email only when a **customer** email is captured (D9).
6. **Confirm validation schema** (Zod, shared client/server): `customer_name` required (non-empty trimmed), `customer_phone` required (normalizes to a sendable number), `customer_email` optional (valid if present).
7. **Template resolution** util: load org template (or shipped default), substitute placeholders (D11) from folio data, render `{itinerary}` per line type.

> **Tenancy:** the two new tenant-scoped routes MUST ship cross-org isolation tests using
> `seedTwoOrgs` (`test/helpers/tenancy.ts`), per `docs/ARCHITECTURE.md`.

---

## Frontend

- **Shared `phoneNormalize(raw)`** util (D3) — used by the new send button **and** retro-fitted into `BookingWhatsAppButton`.
- **`PosCheckoutPage`** — `Nombre` → required; `Teléfono` → required (+ normalize/validate); `Correo` → optional/valid-if-present. Rewrite the three helper texts and the `canSubmit` gate + bottom hint (remove the email-mandatory gate; add name+phone).
- **`TicketWhatsAppButton`** (new shared component, cousin of `BookingWhatsAppButton`) — builds `wa.me/<normalized>?text=<resolved template incl. {portal_link}>`, `window.open`s it, then calls `POST /folios/:id/ticket-delivery`. Disabled when phone missing or token expired (D14).
- **`FolioReceiptPage`** — lead with a prominent **"Enviar boletos por WhatsApp"** primary CTA + **"⚠ Aún no enviado"** until sent; `TicketQr` stays below for in-person. After send, show `Enviado`, and `✓ Visto` once the beacon fires.
- **Delivery badge** on: `/history` list, `/history/:id`, `/folios` list, `/folios/:id` (D15), with a **Reenviar** action on the detail surfaces.
- **Settings (admin only)** — a template editor for the two templates (D10): placeholder helper, live preview, save blocked unless `{portal_link}` present.
- **Apartado** — the existing reminder WhatsApp now uses `wa_reminder_template`.

Reuse design-system primitives (`StatusChip` for the delivery state — **neutral/amber/green**,
never teal; `SectionCard`; `InfoPopover`). Delivery state is functional, icon-paired color.

---

## Delivery state machine

```
                      agent taps "Enviar por WhatsApp"        tourist opens portal (beacon)
 (portal link issued) ───────────────────────────────▶       ─────────────────────────────▶
 ● Pendiente de enviar            ◐ Enviado  (tickets_sent_at)          ✓ Visto  (tickets_viewed_at)
   amber, on all surfaces           neutral                              green
   (agent's KPI = reach here)       (agent's job done)                   (visibility only, not KPI)
```
- Email-opened link can set **Visto** without an agent WhatsApp tap → the folio is evidently
  delivered, so it is **not** shown as *Pendiente* (Visto implies delivered).
- No-WhatsApp, no-open customer stays `● Pendiente` (D12).

---

## Definition of Done

1. Checkout enforces name+phone, email optional; phone normalizes (incl. `+52` default) and the
   recovery flow uses the same normalizer.
2. A paid sale's receipt sends the portal link over WhatsApp in one tap and flips `● → ◐`.
3. Opening the portal (real browser) flips `◐ → ✓ Visto`; a `facebookexternalhit` fetch does **not**.
4. Lodging sale delivers a reservation-worded portal link and runs the same axis.
5. Affiliate sale is customer-direct (no affiliate own-email); re-send works from `/history/:id`.
6. Admin edits both templates in Settings; save is blocked without `{portal_link}`; `{itinerary}`
   expands per line type.
7. Badges render on all four surfaces; expired-token folios disable send.
8. Cross-org isolation tests (`seedTwoOrgs`) cover `/folios/:id/ticket-delivery`; the public
   `/portal/:token/seen` rejects a foreign/invalid token.

## Open / to-confirm at build time

- **US numbering** — assigned (US-AG39/AG40, US-T06, US-A65) and registered in `docs/SPEC.md`.
- **Default template copy** (Spanish) for `wa_ticket_template` / `wa_reminder_template`.
- **`{itinerary}` lodging line format** — confirm `name · checkin–checkout · N noches · guests`.
- Whether the admin folios badge lets an **admin** send on the seller's behalf, or is view-only
  (D15 currently allows admin send).
