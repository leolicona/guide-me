# Feature: Folio generation with signed QR code (HMAC)

## Context

The **Mobile Point of Sale** feature (`docs/pos/pos-controlled-discount.spec.md`) already
creates an immutable **folio** with one **folio line** per service+slot in the cart. What
it deliberately left out — and what this feature adds — is the **access ticket**: a
**signed QR code per folio line** that the client presents at the door and the agent
scans to redeem passes.

This feature owns **only the generation and signing** of those tickets at sale-confirm
time, plus exposing the token on the folio responses and rendering it on the in-app
receipt. It is the minimal, self-contained crypto slice that the *Online QR Scanner* and
*Email delivery* features build on.

**User Stories:**
- **US-AG08** — As an agent, I want to confirm the sale and generate a unique folio
  containing all services in the cart. → *POS created the folio; this feature attaches a
  signed QR ticket to every line so the folio is a usable access document.*
- **US-C02** — As a client, I want to receive a unique QR code for each purchased service
  to present as an access ticket. → *one signed token per folio line (= per service+slot),
  surfaced on the folio response and rendered as a scannable QR on the receipt.*

**Builds on:**
- **Mobile POS** — `folios`, `folio_lines` (the ticket carrier), `folio_line_extras`,
  `confirmSale` (the integration point), the agent-only `/api/pos` router, snapshot
  immutability, and the validate→decrement→compensate persist flow.
- **Auth & roles / Multitenancy** — `c.var.user.organizationId` (the org whose derived key
  signs the ticket), the Enforcement Contract (`docs/multitenancy/multitenancy.spec.md`).
- **SPEC § QR and Access Validation** — the canonical payload and the
  HMAC-SHA256 / `QR_SECRET`-per-organization requirement.

### Scope boundary with adjacent features (read carefully)

The SPEC's *QR and Access Validation* rules span three separate MUST-HAVE lines. This
feature is the **generation** third of that triangle; it stops at issuing a verifiable
ticket and never validates or consumes one.

| Concern | Owner |
|---|---|
| **Sign** one HMAC-SHA256 ticket token per folio line at confirm; store it; expose it; render it on the receipt | **This feature** |
| **Verify + redeem** a scanned token in real-time, decrement the per-ticket redemption count, the scan-result screen ("Pass 2 of 5", expired, fake) | *Online QR Scanner* (US-AG15, AG17, AG19) |
| **Deliver** the receipt + QR to the client by Email (Resend) | *Sending receipt and QR via Email* (US-AG09, US-C01) |
| Offline local signature verification + `POST /api/tickets/sync` | *Offline QR validation* (US-AG16, Phase 2) |

**What this feature provides for those downstream features, deliberately and no more:**
- A shared `src/utils/qr.ts` module exporting `deriveOrgKey`, `signTicket`, **and**
  `verifyTicket`. The scanner is `verifyTicket`'s production consumer; here it is exercised
  by this feature's own roundtrip/tamper/cross-key tests (a signer is only meaningfully
  testable against its verifier). No validation **endpoint** is added.
- `passes_total` is carried in the payload (= the line's `quantity`); the SPEC notes "the
  server knows the total purchased spots based on the folio."
- **`redeemed_count` is NOT added here.** Redemption state has no consumer until the
  scanner exists, so per the repo's YAGNI discipline (see `docs/TECH_DEBT.md` §1) the
  scanner feature adds that column when it needs it. `folio_lines.qr_token` is the only new
  column.

---

## Crypto design

### `QR_SECRET` per organization — by key derivation, not stored secrets

The SPEC requires the QR "signed with HMAC-SHA256 using a `QR_SECRET` per organization."
Rather than storing a distinct secret column on every `organizations` row (which would
need generation-on-create plus a backfill for existing orgs), this feature keeps **one**
high-entropy app secret `QR_SECRET` (a Cloudflare Worker **secret**, never committed) and
**derives a per-organization signing key** from it:

```
orgKey = HMAC-SHA256( QR_SECRET, "guideme:qr:v1:" + organizationId )
```

This satisfies "per organization" — every org signs under a distinct key — while:
- requiring **no schema change** to `organizations` and **no backfill**;
- making cross-org forgery a crypto-layer failure: a ticket minted for `org_a` will not
  verify under `org_b`'s derived key, so the scanner (which derives the key from the
  **scanning agent's** org, never from the token) structurally cannot validate a foreign
  org's ticket — multitenancy enforced in the signature itself.

`QR_SECRET` rotation is out of scope (no `kid` yet); the `"…:v1:"` label and the payload's
`v: 1` reserve room for a versioned rotation scheme later without reissuing tickets.

### Token format

A compact, URL-safe, offline-verifiable string (JWS-compact-like, no separate header):

```
<payload_b64url> "." <signature_b64url>
```

- `payload_b64url = base64url(utf8(JSON.stringify(payload)))`
- `signature_b64url = base64url( HMAC-SHA256(orgKey, payload_b64url) )`

Verification re-derives `orgKey` from the caller's org, recomputes the HMAC over
`payload_b64url`, and compares in **constant time**; only then is the JSON parsed. This is
exactly the structure the SPEC says "guarantees that Phase 2 offline validation can be
implemented securely without changing the issued tickets." Implemented with the Workers
**WebCrypto** `crypto.subtle` API — no new dependency.

### Payload

The SPEC requires `folio_id`, `service_id`, `slot_id`, `client_identity`, `expires_at`.
This feature carries those plus the minimum needed for O(1) redemption and display:

```json
{
  "v": 1,
  "folio_id": "fol_xyz",
  "folio_line_id": "fl_1",
  "organization_id": "org_a",
  "service_id": "svc_abc",
  "slot_id": "slot_1",
  "client_identity": "Jane Tourist",
  "passes_total": 5,
  "issued_at": 1750000000,
  "expires_at": 1750172800
}
```

| Field | Meaning |
|---|---|
| `v` | payload version (`1`); reserved for future rotation |
| `folio_id` | parent folio (SPEC) |
| `folio_line_id` | the ticket's identity — the scanner looks up redemption by this (O(1)) |
| `organization_id` | bound into the signed payload; the verifier re-derives the key from the **caller's** org, so a tampered org breaks the signature |
| `service_id`, `slot_id` | SPEC fields; the access this ticket grants |
| `client_identity` | display/audit string: `customer_name ?? customer_email ?? "folio:" + folio_id` |
| `passes_total` | total passes this ticket grants = the folio line's `quantity` (group ticket; SPEC partial-redemption) |
| `issued_at` | sign time (unix seconds) |
| `expires_at` | unix seconds; see below |

**`expires_at` (MVP, single-timezone).** Mirrors the schedules/POS naive-calendar
assumption: `expires_at = unixtime(slot_date @ 00:00 UTC) + 48h` — valid through the end
of the day **after** the tour, a deliberate grace so a late-evening slot and next-morning
stragglers still scan. This feature only **stamps** it; the scanner enforces it. The
timezone simplification is recorded in `docs/TECH_DEBT.md`.

---

## Data model

One **additive, nullable** column on the existing `folio_lines` table — no new table.

### `folio_lines.qr_token` (new column)

| Column | Type | Notes |
|---|---|---|
| `qr_token` | `text` (nullable) | the signed compact token for this line's access ticket |

- **Nullable on purpose.** `folio_lines` may already hold rows sold by the POS feature
  before this one shipped; SQLite cannot add a `NOT NULL` column to a populated table
  without a default, and a fake default would be a forged ticket. New rows **always**
  populate `qr_token` at confirm time; pre-existing folios simply have no QR (documented).
- No index needed: tickets are read via the folio (already indexed by
  `folio_lines_org_folio_idx`); the scanner will look up by `folio_line_id` (PK) carried in
  the verified payload, not by `qr_token`.

> Migration `0013_add_qr_token_to_folio_lines.sql` —
> `ALTER TABLE folio_lines ADD COLUMN qr_token text;` (matches the `0005_add_…` additive
> style). Drizzle: add `qrToken: text('qr_token')` to `folioLines`.

---

## Business rules (enforced server-side)

1. **One ticket per folio line.** At confirm, every persisted `folio_lines` row gets
   exactly one `qr_token`, signed under the **folio's organization** derived key. A folio
   line = one service at one slot (distinct-slot rule from POS), so "one QR per service in
   a folio" (SPEC) holds.
2. **Signed once, immutable, stored.** The token is computed during `confirmSale` and
   written in the same atomic `db.batch` as the line. Reads return the **stored** token
   verbatim — never re-signed (`issued_at` and the signature stay stable). Folios remain
   immutable; nothing in this feature updates a token.
3. **Server is the source of every payload field.** `passes_total = quantity`,
   `client_identity` derived from the captured customer fields, ids from the just-written
   rows, `organization_id` from `c.var.user` (Rule 3) — **never** from the request body.
   The client cannot influence what a ticket grants.
4. **The key never leaves the server, and is per org.** `QR_SECRET` is a Worker secret;
   only the derived `orgKey` signs. The raw secret and the derived key never appear in any
   response or token.
5. **Tickets are exposed only to the owning agent.** `qr_token` rides on the existing
   `POST /api/pos/folios` and `GET /api/pos/folios/:id` responses, both already scoped to
   the caller agent + org. There is **no** public/unauthenticated ticket endpoint
   (client-facing delivery is the Email feature's job; the scanner reads the token off the
   scanned image, not from an API).

---

## Endpoints

**No new routes.** This feature augments the two POS folio responses with the per-line
ticket and (for convenience on the client) its decoded payload. Auth/role/tenancy are
unchanged (agent-only `/api/pos`, caller-scoped).

### `POST /api/pos/folios` — Confirm sale (augmented)

Behaviour is identical to the POS spec **plus**: after the validate→decrement step and as
part of the persist batch, each prepared line is signed and its `qr_token` stored and
returned. Each `lines[]` entry in the 201 response gains:

```json
{
  "id": "fl_1",
  "...": "... existing line fields ...",
  "qr_token": "eyJ2IjoxLCJmb2xpb19pZCI6...Zm9s.Pk9aZ1f3...",
  "qr": {
    "folio_id": "fol_xyz",
    "folio_line_id": "fl_1",
    "service_id": "svc_abc",
    "slot_id": "slot_1",
    "client_identity": "Jane Tourist",
    "passes_total": 2,
    "expires_at": 1750172800
  }
}
```

`qr_token` is the scannable string (the frontend renders it as a QR). `qr` is the decoded
payload echoed for display convenience (no signature) so the client need not base64-decode
in the UI. (`v`/`issued_at`/`organization_id` are omitted from the echoed `qr` — internal.)

### `GET /api/pos/folios/:id` — Folio read-back (augmented)

Same shape as confirm; each line returns the **stored** `qr_token` (+ decoded `qr`).
Pre-existing folios sold before this feature return `qr_token: null` and `qr: null`.

---

## Error responses

No new `ErrorCode`s. Signing happens entirely from server-owned data after validation
succeeds, so it introduces no new client-facing failure mode. A signing failure (e.g.
`QR_SECRET` unset/misconfigured) is an **invariant violation** → the existing
`500 INTERNAL_ERROR` via the global handler. All POS errors
(`VALIDATION_ERROR`, `PRICE_BELOW_MINIMUM`, `NOT_FOUND`, `SLOT_UNAVAILABLE`, `FORBIDDEN`,
`ACCOUNT_SUSPENDED`) are inherited unchanged.

> **Operational prerequisite:** `QR_SECRET` MUST be present in every environment
> (`wrangler secret put QR_SECRET` in prod; `.dev.vars` locally; miniflare bindings in
> tests). A startup without it will 500 on the first confirm — surfaced by the tests.

---

## Scenarios

### US-AG08 / US-C02 — Ticket generation

#### Scenario 1 — Confirm sale stamps a QR token on every line
**Given** an authenticated `agent` of `org_a` and a valid single-line cart
**When** `POST /api/pos/folios`
**Then** Status `201`; the line's `qr_token` is a non-empty `payload.signature` string;
the stored `folio_lines.qr_token` equals the returned token.

#### Scenario 2 — Token payload roundtrips and verifies under the org key
**Given** the token from Scenario 1
**When** it is split, the payload base64url-decoded, and `verifyTicket` run with
`deriveOrgKey(QR_SECRET, "org_a")`
**Then** verification succeeds; the payload's `folio_id` / `folio_line_id` / `service_id`
/ `slot_id` / `organization_id` match the created rows; `passes_total === quantity`;
`expires_at` equals `unixtime(slot_date@00:00Z) + 48h`.

#### Scenario 3 — Tampering breaks verification
**Given** a valid token
**When** a byte of the payload segment (or of the signature segment) is altered
**Then** `verifyTicket` returns `null` (signature mismatch); the payload is not trusted.

#### Scenario 4 — Cross-org key cannot verify another org's ticket
**Given** a token signed for `org_a`
**When** `verifyTicket` is run with `deriveOrgKey(QR_SECRET, "org_b")`
**Then** it returns `null` — the per-org derived keys differ; tickets do not cross orgs.

#### Scenario 5 — `client_identity` fallback chain
**Given** three confirms: one with `customer_name`, one with only `customer_email`, one
with neither
**Then** the payload `client_identity` is the name, then the email, then `"folio:" + id`,
respectively.

#### Scenario 6 — Multi-line folio yields one distinct token per line
**Given** a two-line cart (`slot_1`, `slot_2`)
**When** confirmed
**Then** two lines, two **different** `qr_token`s (distinct `folio_line_id`/`slot_id` →
distinct payloads and signatures); each verifies and decodes to its own line.

#### Scenario 7 — `passes_total` equals the line quantity (group ticket)
**Given** a line with `quantity = 5`
**Then** that line's token payload has `passes_total === 5` (the SPEC group ticket).

#### Scenario 8 — Tokens are stored once, not re-signed on read
**Given** a confirmed folio
**When** `GET /api/pos/folios/:id` is called twice
**Then** the `qr_token` is byte-identical across the confirm response and both reads
(`issued_at`/signature stable) — proof it is persisted, not recomputed.

#### Scenario 9 — `qr.ts` unit roundtrip and determinism
**Given** a fixed payload and `deriveOrgKey(secret, org)`
**When** `signTicket` then `verifyTicket`
**Then** verify returns the exact payload; signing the same payload+key twice yields the
**same** token (HMAC is deterministic).

### Multitenancy isolation (required — `seedTwoOrgs`)

#### Scenario 10 — B3: foreign folio read still 404, no token leak
**Given** `fol_b` belongs to `org_b`
**When** the `org_a` agent `GET /api/pos/folios/fol_b`
**Then** Status `404 NOT_FOUND`; no token (or any field) of `org_b` is revealed.
*(Inherited from POS; re-asserted because tokens are now on the response.)*

#### Scenario 11 — B1: org in the signed payload is the caller's, not the body's
**Given** an `org_a` agent confirms a sale with an injected `"organizationId": "org_b"`
**When** the response tokens are decoded
**Then** every payload's `organization_id === "org_a"`, and the tokens verify under
`org_a`'s derived key only — the injected org is ignored (Rule 3).

---

## Definition of Done

- [ ] Migration `0013_add_qr_token_to_folio_lines.sql` adds the nullable `qr_token` column
      (additive, populated-table-safe); Drizzle `folioLines.qrToken` added
- [ ] `QR_SECRET` added to `CloudflareBindings` (`src/bindings.d.ts`) and
      `worker-configuration.d.ts`; present in `.dev.vars`, in the vitest miniflare
      `bindings`, and documented as a prod `wrangler secret`
- [ ] `src/utils/qr.ts`: `deriveOrgKey` (HMAC key derivation), `signTicket`,
      `verifyTicket` (constant-time compare, returns `null` on any failure), base64url
      helpers — all via WebCrypto, no new dependency
- [ ] `confirmSale` (`src/routes/pos/handler.ts`) signs one token per prepared line from
      **server-owned** payload data (org from context, `passes_total = quantity`,
      `client_identity` fallback, `expires_at` from `slot_date`), stores it in the
      `folio_lines` insert within the existing atomic batch, and returns `qr_token` + the
      decoded `qr` on each line
- [ ] `GET /api/pos/folios/:id` returns the stored `qr_token` (+ decoded `qr`) per line;
      pre-existing tokenless lines return `null`
- [ ] No new `ErrorCode`; signing failure → existing `500 INTERNAL_ERROR`
- [ ] `test/qr/folio-qr-signing.test.ts` (or a `qr` block under the POS suite) covers
      Scenarios 1–9; `test/qr/qr.unit.test.ts` covers the `qr.ts` roundtrip/tamper/cross-key
- [ ] Multitenancy Scenarios 10–11 via `seedTwoOrgs`
- [ ] Frontend: `qrcode.react` added; `Folio`/`FolioLine` types gain `qr_token`/`qr`;
      a `TicketQr` component; `FolioReceiptPage` renders one scannable QR per line with
      service/slot/"N passes" caption (replacing the "QR in a later step" placeholder)
- [ ] `docs/TECH_DEBT.md`: note (a) per-org QR signing via `QR_SECRET` **key derivation**
      (no per-org stored secret; rotation/`kid` deferred); (b) `expires_at` single-timezone
      naive-date simplification; (c) `verifyTicket` shipped here, consumed in production by
      the *Online QR Scanner* feature
- [ ] `pnpm --filter api-turistear test` green; `pnpm build:app` clean
- [ ] `docs/SPEC.md` MUST-HAVE item **Folio generation with signed QR code (HMAC)**
      *(US-AG08, US-C02)* ticked
