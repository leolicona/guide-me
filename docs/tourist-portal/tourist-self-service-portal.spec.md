# Feature: Tourist Self-Service Portal — Magic Link, Itinerary, QR, Cancellation Request & Refund PIN

**User stories:** US-T01 (magic link), US-T02 (itinerary), US-T03 (QR tickets),
US-T04 (cancellation request), US-T05 (refund PIN) · **bundles US-A23** (cash refund tracking).
**Phase:** 2 (Core Enhancements) · **B2C surface.**
**Depends on:** Client Ticket Delivery (`docs/email/client-ticket-delivery.spec.md`) for the
Magic Link email; Total Folio Cancellation (`docs/cancellation/total-folio-cancellation.spec.md`)
— the approval funnels into the existing `cancelFolio`. Read both first.

> A **passwordless, tokenized portal** a tourist opens from a **Magic Link** emailed at
> purchase — no account, no password. They see their **itinerary**, download their **QR
> tickets**, and can **request a cancellation**. When an admin approves it, the tourist sees a
> secure **Refund PIN** in the portal which they hand to the agent/admin to **confirm the
> physical cash refund** — closing the cash-refund loop (US-A23). The portal is a **public,
> read-mostly surface served by the Worker itself** (`hono/jsx` SSR), authenticated only by an
> unguessable **folio-scoped token** — never a session JWT.

---

## Context

Today the tourist's entire experience is **one email** at purchase (`docs/email/`): the
receipt + per-service QR images. There is no surface they can return to — to re-show a QR at
the gate, check a meeting time, or start a cancellation they must phone the agency. This
feature gives them a **durable, self-service portal** scoped to their one folio.

Three pieces of infrastructure already exist and are **reused, not rebuilt**:

1. **QR tickets** — one HMAC-signed token per folio line (`folioLines.qrToken`,
   `docs/qr/`), already rendered as images via `api.qrserver.com` in the confirmation email.
   The portal renders the **same** images.
2. **`cancelFolio`** (US-A21) — already does the atomic inventory-release + status flip +
   fires the cancellation email. US-T04's **approval calls it unchanged**.
3. **Magic-link token pattern** — `password_reset_tokens` (a persisted random token + expiry,
   resolved server-side). The portal token follows the same shape, **folio-scoped**.

What is **new**: the public portal surface, the folio-scoped access token, the
tourist-initiated **cancellation request** (a request, not an immediate cancel), and the
**refund state machine + Refund PIN** (US-A23, bundled here because US-T04/T05 are untestable
without it).

### Design decisions (✅ = confirmed with product)

| # | Decision | Choice | Rationale |
|---|---|---|---|
| D1 ✅ | **Portal surface** | **Worker-rendered public pages** (`hono/jsx` via `renderer.tsx`), styled with the existing `style.css`. Server-rendered HTML + form posts; **no required client JS**. | The portal is ~4 low-interactivity, read-mostly pages. The Worker already owns the data, the token validation, and the QR-image rendering. Token is validated **before** a byte renders — no token in a client bundle, no new build/deploy target, no new CORS surface. A B2C portal also *should* have its own identity, not the internal admin/agent MUI chrome. |
| D2 ✅ | **Magic-link auth** | A **persisted, folio-scoped `folio_access_tokens`** row (random token + `expires_at`). **NOT** Agnostic Auth. | Agnostic Auth (`initiateMagicLink`/`verifyToken`) is **identity-based** — it issues a session JWT tied to a `users` record. A tourist is **not a user**: no row, no role, no session. Their link is a **capability token** for one folio, valid through the trip, carrying zero session privileges. Reusing Agnostic Auth would mint phantom identities + real JWTs for non-users — a modeling and security mess. |
| D3 ✅ | **Token lifetime & strength** | Issued at purchase; `expires_at = end-of-day(max slot date) + 7 days`, capped at 90 days. Token = **32 random bytes → base64url** (≥128-bit entropy), not a UUID. | The tourist reopens the link to show QRs *during* the trip, so a 10-minute token (like email verify) is wrong; it must outlive the last service. Because it sits in a URL for weeks on a public surface, it gets **more** entropy than the 1-hour reset token. |
| D4 ✅ | **Cancellation is a request, not a cancel** | A dedicated **`cancellation_requests`** table (one open `pending` row per folio). The tourist-side action **never touches inventory or folio status**; only an admin **approval** runs `cancelFolio`. | US-T04 is explicit: the tourist *initiates a request* the agency reviews. Keeping inventory release behind admin approval preserves the single cancellation path (US-A21) and prevents a tourist from self-releasing seats. A table (vs. folio columns) gives a clean admin queue + audit trail. |
| D5 ✅ | **Refund tracking (US-A23) is owned here** | Refund state machine on the folio: `none → pending → refunded`. On approval of a **paid** folio, `refund_status='pending'` and a **Refund PIN** is generated. Admin confirms with the PIN → `refunded`. | The request → approve → PIN → confirm loop **is** US-T04/T05 and is untestable without the refund backend. US-A23's admin UI is the paired surface. |
| D6 ✅ | **Refund PIN security model** | A **6-digit crypto-random** PIN, **shown only in the portal** (never in any email), server-compared on confirm, with attempt-lockout → admin override. | The PIN's whole purpose is to prove the **tourist was present** to receive the cash. Emailing it would defeat that. Holding it portal-only means an agent who enters it has demonstrably met the customer. |
| D7 | **New-request notification** | **In-app admin queue + nav badge** (like the disputes queue). Email-to-admin is **deferred**. | No admin-facing event-email infra exists; this mirrors the precedent set by Advanced Cash Collection (D1 there). Layerable on Resend later with no model change. |

### Scope boundary

| Concern | Owner |
|---|---|
| Portal token issuance + the public SSR portal (itinerary, QR, request form, refund-PIN display); the `cancellation_requests` model + admin approve/reject; the **refund state machine + Refund PIN + confirm** (US-A23); the admin cancellation-requests queue + refund-confirm UI | **This feature** |
| Atomic inventory release + folio status flip + cancellation email | *Total Folio Cancellation* — **unchanged**; approval calls `cancelFolio` |
| QR minting + signing; the QR image service | *Folio QR Signing* + *Client Ticket Delivery* — **reused as-is** |
| **Partial** cancellation refunds (US-A22/A23-partial) | **Out of scope** — US-A22 is a separate deferred item; refund here tracks **total** cancellations only |
| Actual **electronic** money movement (card/transfer refunds) | **Out of scope** — no payment gateway (Phase-1 pivot). The confirm loop *records* the refund; for cash it is physical, for electronic the admin processes it out-of-band and records confirmation here |
| Tourist account / login / multi-folio dashboard | **Out of scope** — strictly one folio per token (passwordless, no account) |

---

## Data Model

**Three migrations.** Two new tables + refund columns on `folios`. Latest existing migration
is `0026`.

### `folio_access_tokens` — the portal magic-link token (new)

| Column | Type | Notes |
|---|---|---|
| `id` | `text` PK | uuid |
| `organization_id` | `text` NOT NULL → `organizations(id)` | tenant scope (denormalized for direct filtering; always == the folio's org) |
| `folio_id` | `text` NOT NULL → `folios(id)` | the one folio this token unlocks |
| `token` | `text` NOT NULL UNIQUE | 32 random bytes → base64url (D3); the URL secret |
| `expires_at` | `integer` timestamp NOT NULL | D3 lifetime |
| `last_accessed_at` | `integer` timestamp (nullable) | touched on each successful portal load (light audit; optional to read) |
| `created_at` | `integer` timestamp NOT NULL default `unixepoch()` | |

```sql
-- 0027_create_folio_access_tokens.sql
CREATE TABLE `folio_access_tokens` (
  `id` text PRIMARY KEY NOT NULL,
  `organization_id` text NOT NULL REFERENCES `organizations`(`id`),
  `folio_id` text NOT NULL REFERENCES `folios`(`id`),
  `token` text NOT NULL UNIQUE,
  `expires_at` integer NOT NULL,
  `last_accessed_at` integer,
  `created_at` integer NOT NULL DEFAULT (unixepoch())
);
--> statement-breakpoint
CREATE INDEX `idx_folio_access_tokens_folio` ON `folio_access_tokens` (`folio_id`);
```

### `cancellation_requests` — tourist-initiated cancellation (new)

| Column | Type | Notes |
|---|---|---|
| `id` | `text` PK | uuid |
| `organization_id` | `text` NOT NULL → `organizations(id)` | tenant scope |
| `folio_id` | `text` NOT NULL → `folios(id)` | subject folio |
| `status` | `text` NOT NULL default `'pending'` | enum `['pending','approved','rejected']` |
| `reason` | `text` (nullable) | the tourist's stated reason (optional) |
| `resolution_note` | `text` (nullable) | the admin's note — **required on reject** |
| `resolved_by` | `text` → `users(id)` (nullable) | admin who approved/rejected |
| `resolved_at` | `integer` timestamp (nullable) | |
| `created_at` / `updated_at` | `integer` timestamps | |

```sql
-- 0028_create_cancellation_requests.sql
CREATE TABLE `cancellation_requests` (
  `id` text PRIMARY KEY NOT NULL,
  `organization_id` text NOT NULL REFERENCES `organizations`(`id`),
  `folio_id` text NOT NULL REFERENCES `folios`(`id`),
  `status` text NOT NULL DEFAULT 'pending',
  `reason` text,
  `resolution_note` text,
  `resolved_by` text REFERENCES `users`(`id`),
  `resolved_at` integer,
  `created_at` integer NOT NULL DEFAULT (unixepoch()),
  `updated_at` integer NOT NULL DEFAULT (unixepoch())
);
--> statement-breakpoint
CREATE INDEX `idx_cancellation_requests_folio` ON `cancellation_requests` (`folio_id`);
--> statement-breakpoint
-- At most ONE open request per folio (Rule 4 / S6). Partial unique index on the open state.
CREATE UNIQUE INDEX `uq_cancellation_requests_open`
  ON `cancellation_requests` (`folio_id`) WHERE `status` = 'pending';
```

### `folios` — refund tracking columns (US-A23, new)

| Column | Type | Notes |
|---|---|---|
| `refund_status` | `text` NOT NULL default `'none'` | enum `['none','pending','refunded']`. `pending` set when a **paid** folio is cancelled; `refunded` after confirm. |
| `refund_amount` | `integer` (nullable) | snapshot of `amount_paid` owed back at cancellation (audit clarity) |
| `refund_pin` | `text` (nullable) | 6-digit crypto-random; portal-only (D6); cleared/retained after confirm (kept for audit) |
| `refund_pin_attempts` | `integer` NOT NULL default `0` | failed confirm attempts; lockout backstop (Rule 8) |
| `refund_note` | `text` (nullable) | the admin's audit note when confirming **without** the PIN (override path, Rule 8) |
| `refunded_at` | `integer` timestamp (nullable) | |
| `refunded_by` | `text` → `users(id)` (nullable) | admin who confirmed |

```sql
-- 0029_add_refund_tracking_to_folios.sql
ALTER TABLE `folios` ADD COLUMN `refund_status` text DEFAULT 'none' NOT NULL;
--> statement-breakpoint
ALTER TABLE `folios` ADD COLUMN `refund_amount` integer;
--> statement-breakpoint
ALTER TABLE `folios` ADD COLUMN `refund_pin` text;
--> statement-breakpoint
ALTER TABLE `folios` ADD COLUMN `refund_pin_attempts` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `folios` ADD COLUMN `refund_note` text;
--> statement-breakpoint
ALTER TABLE `folios` ADD COLUMN `refunded_at` integer;
--> statement-breakpoint
ALTER TABLE `folios` ADD COLUMN `refunded_by` text REFERENCES `users`(`id`);
```

Backfill is implicit: existing folios become `refund_status='none'` (the historical truth — no
refund obligation predates this feature). **Run `pnpm cf-typegen:api` is not needed**, but the
Drizzle schema (`src/db/schema.ts`) must add the two tables + six columns and export their types.

### Refund state machine

```
   none ──(approve cancellation of a PAID folio; PIN generated)──► pending ──(admin confirms w/ PIN
                                                                    │          or override+note)──► refunded
   none ──(cancel an UNPAID folio: amount_paid == 0)──► none (no obligation)
```

### Cancellation-request lifecycle

```
   (tourist submits)──► pending ──(admin approves → cancelFolio)──► approved
                          │
                          └────────(admin rejects + note)─────────► rejected   (folio unchanged)
```

---

## Business Rules (enforced server-side)

1. **Token issuance at sale (US-T01).** On POS confirm (`pos/handler.ts`, after the folio +
   tickets are committed), generate one `folio_access_tokens` row: `token` = 32 random bytes
   base64url, `expires_at` per D3. The **portal link** (`${PORTAL_BASE_URL}/portal/${token}`)
   is added to the existing ticket-confirmation email. Issuance is best-effort and **must never
   fail a committed sale** (same `waitUntil` discipline as the email). `PORTAL_BASE_URL`
   defaults to the Worker origin (`API_BASE_URL`) — see Bindings.
2. **Token resolution (US-T02/T03).** `GET /portal/:token` resolves the token server-side:
   unknown → **404 page**; `expires_at <= now` → **410 page**; both with generic copy (no
   enumeration). On success, render the folio's itinerary + QR images and touch
   `last_accessed_at`. The token grants access to **exactly one folio** — never a list.
3. **Itinerary + tickets (US-T02/T03).** Render every folio line (service name, slot date,
   slot time, quantity, and `description` as the meeting-point/instructions blurb) and each
   line's **QR image** (reusing the email's `api.qrserver.com` URL from `qrToken`). A
   **cancelled** folio renders a clear cancelled banner and suppresses any "valid ticket"
   framing (the scanner already rejects cancelled tickets — the portal must not imply validity).
4. **Cancellation request (US-T04).** `POST /portal/:token/cancellation-request`
   `{ reason? }` inserts a `cancellation_requests` row (`status='pending'`). It **does not**
   touch inventory or folio status. **409** if the folio is already `cancelled` **or** a
   `pending` request already exists (the partial unique index is the backstop). It surfaces in
   the admin queue (Rule 9, D7). Reason is optional, trimmed, length-capped.
5. **Admin approves (US-T04 → US-A21).** `POST /api/folios/cancellation-requests/:requestId/approve`
   (admin): re-checks the request is `pending`, calls the **existing `cancelFolio`** path
   (atomic inventory release + status flip + cancellation email — unchanged), marks the request
   `approved` (`resolved_by`/`resolved_at`), and **if `amount_paid > 0`** sets
   `refund_status='pending'`, `refund_amount = amount_paid`, and generates `refund_pin`. **404**
   unknown/cross-org; **409** if not `pending` or the folio is already cancelled.
6. **Admin rejects (US-T04).** `POST /api/folios/cancellation-requests/:requestId/reject`
   `{ note }` (note **required**) flips `pending → rejected`, stores `resolution_note`, sets
   `resolved_by`/`resolved_at`. Folio **unchanged**. **400** empty note; **404**
   unknown/cross-org; **409** if not `pending`. *(Optional: email the tourist that the request
   was declined — see Open Questions.)*
7. **Refund PIN visibility (US-T05).** The portal shows the PIN **only** while
   `refund_status='pending'`, with copy instructing the tourist to give it to the agent/admin to
   receive their refund. The PIN is **never** placed in any email (D6). Before approval there is
   no PIN to show.
8. **Refund confirmation (US-A23/US-T05).** `POST /api/folios/:id/refund/confirm` (admin), two
   mutually-exclusive bodies:
   - **`{ pin }`** — the primary path. Must equal `refund_pin` → `refund_status='refunded'`,
     `refunded_at`/`refunded_by` set. A mismatch increments `refund_pin_attempts` and returns
     **422 `VALIDATION_ERROR`**; after **5** failures the PIN path is **locked** (further
     `{ pin }` → **423/409 `CONFLICT`**) and only the override path remains.
   - **`{ override_note }`** — admin records the refund **without** a PIN (lost-link edge case);
     note **required**; same terminal `refunded` state, audited via `override_note`.
   **409** if `refund_status != 'pending'` (idempotency / nothing to confirm). **400** if neither
   `pin` nor `override_note` is present.
9. **New-request notification (D7).** `GET /api/folios/cancellation-requests?status=pending`
   (admin) backs an in-app queue + a nav badge (count of `pending`). No email is sent to the
   admin in this version.
10. **Multitenancy & ownership.** `folio_access_tokens` and `cancellation_requests` carry
    `organization_id`; every admin query filters it from context. A token resolves to its own
    folio only. Approve/reject/confirm are **404** for a cross-org `requestId`/folio (no
    existence leak). Portal routes are **public** (token *is* the credential) and are
    unreachable for any other org's folio because the token maps 1:1.
11. **No injected server-owned fields.** Zod strips/ignores `organization_id`, `status`,
    `refund_status`, `refund_pin`, `resolved_by`, etc. from any request body; all come from
    context/derivation.
12. **No new `ErrorCode`.** Reuse `VALIDATION_ERROR` (400/422), `NOT_FOUND` (404),
    `CONFLICT` (409/locked), `FORBIDDEN` (403). Portal HTML errors render **404/410 pages**.

---

## Endpoints

### Public portal (Worker SSR — no auth; the token is the credential)

| Method & path | Surface | Purpose | US |
|---|---|---|---|
| `GET /portal/:token` | HTML page | Itinerary + QR tickets + cancellation status + Refund PIN (when pending) | T02/T03/T05 |
| `POST /portal/:token/cancellation-request` | HTML form post → redirect | Submit a cancellation request | T04 |

> Mounted on the main app **outside** the `/api/*` CORS block and **without** `authMiddleware`.
> The POST is a classic form submit (`application/x-www-form-urlencoded`) → 303 redirect back to
> `GET /portal/:token`, so the portal needs **no client JS**.

### Admin (JSON, `/api/folios/*` — auth-required, **admin** role)

| Method & path | Purpose | US |
|---|---|---|
| `GET /api/folios/cancellation-requests?status=pending` | The review queue (+ badge count) | T04 |
| `POST /api/folios/cancellation-requests/:requestId/approve` | Approve → `cancelFolio` + issue refund PIN if paid | T04/A21 |
| `POST /api/folios/cancellation-requests/:requestId/reject` | Reject with a required note | T04 |
| `POST /api/folios/:id/refund/confirm` | Confirm refund via PIN (or override+note) | A23/T05 |

> **Routing order:** register the literal `cancellation-requests` routes **before** the
> existing `/api/folios/:id` routes so `:id` can't capture `cancellation-requests` (same
> discipline the cash router uses for `/me` before `/:id`).

### `GET /portal/:token` — rendered view model

```
{
  org_name, folio: { short_id, status, created_at, payment_method, total, amount_paid },
  lines: [{ service_name, slot_date, slot_start_time, quantity, description, qr_image_url }],
  cancellation: { state: 'none'|'requested'|'cancelled', request_status?, resolution_note? },
  refund: { status: 'none'|'pending'|'refunded', pin?: '••••' (only when pending), amount? }
}
```

### `POST /api/folios/:id/refund/confirm`

Request (one of): `{ "pin": "048213" }` **or** `{ "override_note": "Reembolsado en efectivo; el cliente perdió el enlace" }`
`200` → `{ folio: { id, refund_status: 'refunded', refunded_at, refunded_by } }`
`422` PIN mismatch · `409` locked / not pending · `400` empty body.

---

## Frontend

### A. Tourist portal — Worker SSR (`hono/jsx`)

Layered as a small page set under the Worker (e.g. `src/routes/portal/`), rendered through
`renderer.tsx` + `style.css`. **Mobile-first, elegant-minimalist** (its own B2C identity — not
the MUI admin chrome). No client JS required.

- **`PortalView`** — the page: org header, folio reference + status, an **itinerary** list
  (each line: service, date·time, party size, the description/meeting blurb), and per-line **QR
  card** (the `api.qrserver.com` image, "Presenta este código al llegar"). A **cancelled**
  folio shows a quiet cancelled banner and drops the "valid ticket" copy.
- **Cancellation block** — state-driven:
  - *none* → a "Solicitar cancelación" disclosure with an optional reason `<textarea>` →
    form `POST`.
  - *requested* → "Tu solicitud está en revisión" (timestamp).
  - *cancelled* → cancelled banner; if **refund pending**, a prominent **Refund-PIN card**:
    the 6-digit code + "Da este código al agente para recibir tu reembolso." If **refunded**,
    a "Reembolso confirmado" note.
- **Error pages** — `404` (invalid link) and `410` (expired link) with calm copy and a "contact
  the agency" hint; never reveal whether a folio exists.

### B. Admin — `app-turistear` (React + MUI)

- **Cancellation-requests queue** — a new tab in the existing Cash/Folios area (mirrors the
  drops/disputes queue): each row shows folio ref, customer, the tourist's reason, and
  **Aprobar / Rechazar** actions. Approve opens a confirm dialog spelling out that it cancels
  the folio, **releases the seats**, emails the customer, and **issues a refund PIN** if paid.
  Reject opens a required-note dialog.
- **Nav badge** — pending-request count on the relevant destination (reuse the
  `usePendingAckCount`-style pattern).
- **Folio detail** — a **refund status chip** (`Sin reembolso` / `Reembolso pendiente` /
  `Reembolsado`) and, while pending, a **"Confirmar reembolso"** dialog: a PIN input (primary)
  plus an "registrar sin PIN" override that requires a note. Copy clarifies the PIN proves the
  customer received the cash; the override is for lost-link cases.
- **Types / service / hooks** — extend `features/cash` or a new `features/cancellations`:
  `listCancellationRequests`, `approveCancellationRequest`, `rejectCancellationRequest`,
  `confirmRefund`; hooks invalidate `['folios']` / the queue key.

---

## Bindings

Add (optional) **`PORTAL_BASE_URL`** to `CloudflareBindings` + `wrangler.jsonc`, defaulting to
the Worker's own public origin (today reused from `API_BASE_URL`). The portal link in the
confirmation email is `${PORTAL_BASE_URL}/portal/${token}`. Run `pnpm cf-typegen:api` after the
`wrangler.jsonc` change. *(If a custom tourist-facing domain isn't wanted now, skip the binding
and use `API_BASE_URL` directly.)*

---

## Error responses

| Case | Status | Code / surface |
|---|---|---|
| Portal: unknown token | `404` | HTML 404 page |
| Portal: expired token | `410` | HTML 410 page |
| Cancellation request on cancelled folio / duplicate open request | `409` | `CONFLICT` |
| Reject with empty note | `400` | `VALIDATION_ERROR` |
| Approve/reject a non-`pending` request | `409` | `CONFLICT` |
| Refund confirm: PIN mismatch | `422` | `VALIDATION_ERROR` |
| Refund confirm: locked (≥5 fails) / not `pending` | `409` | `CONFLICT` |
| Refund confirm: empty body (no pin, no override) | `400` | `VALIDATION_ERROR` |
| Cross-org approve/reject/confirm | `404` | `NOT_FOUND` |
| Wrong role on admin routes (agent/non-admin) | `403` | `FORBIDDEN` |

---

## Scenarios

### US-T01 — Magic link
- **S1** — A confirmed sale writes one `folio_access_tokens` row and the confirmation email
  contains `${PORTAL_BASE_URL}/portal/${token}`; the token resolves to that folio.
- **S2** — Token issuance failure (e.g. Resend down) **never** rolls back the committed sale.

### US-T02 / US-T03 — Itinerary & QR
- **S3** — `GET /portal/:token` renders every line with its date/time/qty + QR image for a
  valid token; `last_accessed_at` is touched.
- **S4** — Unknown token → 404 page; expired token → 410 page (generic copy, no enumeration).
- **S5** — A cancelled folio renders the cancelled banner and omits "valid ticket" framing.

### US-T04 — Cancellation request
- **S6** — Tourist submits a request → a `pending` row; folio status + slot `booked` **unchanged**;
  it appears in the admin queue.
- **S7** — A second request, or a request on an already-cancelled folio → `409`; the partial
  unique index prevents two open rows.
- **S8** — Admin **approves** → `cancelFolio` runs (seats released, status `cancelled`,
  cancellation email sent), request `approved`; a **paid** folio gets `refund_status='pending'`
  + a PIN + `refund_amount = amount_paid`.
- **S9** — Approving an **unpaid** folio (`amount_paid == 0`) cancels it but leaves
  `refund_status='none'` (no obligation, no PIN).
- **S10** — Admin **rejects** with a note → `rejected`, folio untouched; empty note → `400`.

### US-T05 / US-A23 — Refund PIN & confirmation
- **S11** — The portal shows the PIN only while `refund_status='pending'`; it is **absent**
  before approval and **never** present in any email.
- **S12** — Admin confirms with the **correct** PIN → `refunded`, `refunded_at`/`refunded_by`
  set; the portal flips to "Reembolso confirmado."
- **S13** — Wrong PIN → `422` and `refund_pin_attempts++`; after 5 fails the PIN path is locked
  (`409`) and only override remains.
- **S14** — Override (`{ override_note }`, no PIN) → `refunded` with the audit note; empty body → `400`.
- **S15** — Confirm when `refund_status != 'pending'` → `409` (idempotent / nothing to confirm).
- **S16** — Injected `refund_status`/`refund_pin`/`organization_id`/`status` in any body are ignored.

### Roles & Multitenancy
- **S17** — Non-admin on approve/reject/confirm → `403`. Portal GET/POST need **no** auth.
- **S18** — **`seedTwoOrgs` isolation (required).** An Org-A folio token never exposes Org-B
  data; an Org-B admin cannot list/approve/reject Org-A's requests or confirm Org-A's refund
  (`404`); Org-A's pending requests are invisible to Org-B's queue.
- **S19** — Token entropy ≥128-bit and unique; PIN is 6-digit crypto-random (not sequential).

---

## Definition of Done

**Backend**
- [x] Migrations `0027_create_folio_access_tokens` + `0028_create_cancellation_requests`
      (incl. the partial unique index) + `0029_add_refund_tracking_to_folios`; Drizzle schema +
      exported types.
- [x] POS confirm issues a `folio_access_tokens` row + portal link in the confirmation email
      (best-effort, never fails the sale).
- [x] `GET /portal/:token` (SSR) — validate + expiry (404/410), render itinerary + QR + state,
      touch `last_accessed_at`.
- [x] `POST /portal/:token/cancellation-request` (form post → 303) — create `pending`,
      inventory-safe, 409 guards.
- [x] `GET /api/folios/cancellation-requests` (admin queue) + approve/reject (approve →
      `cancelFolio` + PIN issuance; reject → required note).
- [x] `POST /api/folios/:id/refund/confirm` — PIN path (mismatch 422, lockout) + override path;
      409 when not pending; routing ordered before `/:id`.
- [x] Refund state machine (`none → pending → refunded`); PIN portal-only, never emailed.
- [x] Schemas strip server-owned fields; multitenancy filters everywhere.
- [x] Tests: S1–S19, incl. **`seedTwoOrgs`** isolation and refund/PIN paths.

**Frontend**
- [x] Tourist portal SSR pages (itinerary, QR cards, cancellation block, refund-PIN card,
      404/410) — mobile-first, no required client JS.
- [x] Admin cancellation-requests queue + nav badge; approve/reject dialogs.
- [x] Folio-detail refund chip + "Confirmar reembolso" dialog (PIN + override).
- [x] Types + service + hooks; `pnpm lint:app`, `tsc`, `pnpm build:app` clean.

**Docs**
- [x] `docs/SPEC.md` Phase-2 line linked to this spec (checked off when shipped); US-A23 line
      noted as delivered-with-this-feature. `TECH_DEBT.md` notes the deferred admin email (D7)
      and electronic-refund money movement (no gateway).

---

## Open questions — resolved at implementation (defaults taken)

1. **Meeting point (US-T02).** ✅ No new catalog column — the itinerary card renders the
   service's **current** `description` (joined live, not a sale snapshot) as the
   meeting-point/instructions blurb, so an updated meeting point reaches the tourist.
2. **Reject → tourist email (Rule 6).** ✅ Portal-only: the rejection note renders in the
   portal's cancellation block ("Tu solicitud anterior fue rechazada: …"), consistent with
   D7's no-event-email stance.
3. **Electronic refunds.** ✅ One uniform `pending → refunded` path with cash-first copy.
   For non-cash folios the admin processes the return out-of-band and records it here
   (typically via the override-note path) — see `TECH_DEBT.md` §16.
