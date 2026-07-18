# Feature: Online QR Scanner

## Context

The *Folio generation with signed QR code* feature (`docs/qr/folio-qr-signing.spec.md`)
mints one **signed access ticket per folio line** — a group ticket granting
`passes_total` (= the line's `quantity`) admissions, signed HMAC-SHA256 under a per-org
derived key. This feature is the **other half**: the agent at the gate scans a client's QR
with their phone, the server **verifies and redeems one pass in real-time**, and the agent
sees a clear ✓/✗ result. It is the production consumer of the `verifyTicket` util shipped
(and tested) by the generation feature.

Per the SPEC's design principle, the MVP scanner is **strictly online**: every scan is
validated against the server, which is the single source of truth for the redemption
count. No internet → a clear "validation requires a connection" error (US-AG19); offline
validation + sync is explicitly **Phase 2** (US-AG16).

**User Stories:**
- **US-AG15** — As an agent, I want to use my phone's camera to scan a client's QR code
  and validate their ticket **in real-time against the server, decrementing one pass**
  from the total spots purchased on that ticket.
- **US-AG17** — As an agent, I want a clear scan-result screen: **✓ Valid** (client name,
  service, schedule, redemption progress e.g. "Pass 2 of 5 used") or **✗ Invalid** (reason:
  all passes used, expired, fake).
- **US-AG19** — As an agent, I want a clear error if I scan **without an internet
  connection**, indicating that validation requires network access.

**Builds on:**
- **Signed QR tickets** — `src/utils/qr.ts` (`deriveOrgKey`, `verifyTicket`,
  `TicketPayload`), `folio_lines.qr_token`, and the payload fields
  (`folio_line_id`, `organization_id`, `passes_total`, `expires_at`, `client_identity`, …).
- **POS / folios** — `folio_lines` is the **ticket carrier**; `quantity` is `passes_total`.
- **Auth & roles / Multitenancy** — `authMiddleware`, `requireRole('agent')`, per-org key
  derivation, the Enforcement Contract.

### Scope boundary with adjacent features (read carefully)

| Concern | Owner |
|---|---|
| Scan → **verify signature + expiry + atomically redeem one pass**, the ✓/✗ result, the `redeemed_count` column, the camera UI, the offline error | **This feature** |
| **Offline** local-signature validation + `localStorage` queue + `POST /api/tickets/sync` | *Offline QR validation* (US-AG16, **Phase 2**) |
| **Folio cancellation** (`status → 'cancelled'`, release spots) | *Total folio cancellation* (US-A21) — this feature only **reads** `status` to refuse a cancelled ticket |
| Bookings (`status = 'booking'`) | *Bookings* (US-AG07) — this feature refuses a non-`paid` folio (forward-safe) |
| A **redemption audit log** (who/when/which pass, as rows) | **Deferred** — `redeemed_count` is the only MVP consumer of redemption state (US-AG17 progress). A `ticket_redemptions` table has no MVP reader, so per the repo's YAGNI discipline it is added by the first feature that reports on it (cash drawer / reports). Noted in `docs/TECH_DEBT.md`. |

**New endpoint (auth-required, `agent` role):** a new `src/routes/tickets/` router.

| Method & path | Purpose | US |
|---|---|---|
| `POST /api/tickets/scan` | Verify a scanned token and redeem **one** pass; return the ✓/✗ result | AG15, AG17 |

> **Why a new `/api/tickets` router (not `/api/pos`).** Redemption is a distinct agent
> capability from selling, and the SPEC's Phase-2 sync path is `POST /api/tickets/sync` —
> a `tickets` router (agent-only, like POS) is the natural home and leaves room for that
> sibling without disturbing the POS surface.

---

## Data model

One **additive** column on the existing `folio_lines` table — no new table.

### `folio_lines.redeemed_count` (new column)

| Column | Type | Notes |
|---|---|---|
| `redeemed_count` | `integer NOT NULL DEFAULT 0` | passes redeemed so far; `0 <= redeemed_count <= quantity` |

- **`NOT NULL DEFAULT 0` is populated-table-safe** in SQLite (constant default), so existing
  tickets backfill to `0` (none redeemed yet) — correct.
- `quantity` **is** `passes_total`; the invariant `redeemed_count <= quantity` is enforced
  by the conditional UPDATE guard (below), mirroring `slots.booked <= capacity`.
- No new index: redemption looks up the line by **PK** (`folio_line_id` from the verified
  payload), already the fastest path.

> Migration `0014_add_redeemed_count_to_folio_lines.sql` —
> `ALTER TABLE folio_lines ADD COLUMN redeemed_count integer DEFAULT 0 NOT NULL;`
> (matches the `0013_add_qr_token` additive style). Drizzle:
> `redeemedCount: integer('redeemed_count').notNull().default(0)`.

---

## Business rules (enforced server-side)

1. **The server is the single source of truth (strictly online).** Every scan is a server
   round-trip; the client never decides validity. Offline handling is a client concern
   (US-AG19) — the server is never reached.
2. **Verify before trust.** The token is checked with `verifyTicket(token, orgKey)` where
   `orgKey = deriveOrgKey(QR_SECRET, callerOrg)`. A bad/forged/tampered signature → **invalid
   (fake)**; the payload is never read. Because the key is derived from the **caller's**
   org, a ticket minted for another org **cannot verify** → it reads as "fake" with no
   information leak (multitenancy in the signature).
3. **One scan redeems exactly one pass.** A successful scan **atomically** increments
   `redeemed_count` by 1, guarded by `redeemed_count < quantity`. The new count is the
   "pass N of M used" shown to the agent (US-AG17).
4. **No over-redemption (race protection).** Two agents scanning the *last* pass at the
   same instant: the conditional UPDATE means only one can match
   (`redeemed_count < quantity`); the other gets **invalid (all passes consumed)**. (Same
   D1-no-interactive-transactions reality as POS; here a single atomic UPDATE suffices — no
   compensation, no batch.)
5. **Expiry is enforced from the signed payload.** `now > expires_at` → **invalid
   (expired)**; no pass is redeemed.
6. **Only a `paid`, non-cancelled folio admits.** A `cancelled` folio → invalid (cancelled);
   any non-`paid` status (e.g. a future `booking`) → invalid (not paid). Forward-safe — only
   `paid` exists today.
7. **Everything is org-scoped.** The redemption read/UPDATE filter by
   `organization_id = callerOrg` (Rules 2 & 4); the org/agent are taken from context, never
   the body (Rules 1 & 3). The scan body carries **only** the token.
8. **A scan is a write, and is not idempotent.** Each successful call consumes a pass. A
   lost response → a possible double-redeem if the agent rescans; the client mitigates by
   **re-arming** between scans (debounce). Accepted MVP trade-off (no idempotency key);
   noted in `docs/TECH_DEBT.md`.

---

## Endpoint

**Auth required, `agent` role** (`authMiddleware` + `requireRole('agent')` on `*`). A
suspended caller is stopped by `authMiddleware` (`403 ACCOUNT_SUSPENDED`).

### `POST /api/tickets/scan` — Verify & redeem one pass (US-AG15, US-AG17)

A scan is **always a 200** when the request itself is well-formed and authorized — the
✓/✗ outcome is data, not an HTTP error (the scanner renders a result screen either way).
HTTP errors are reserved for request-level problems (missing token, auth, role).

#### Request body

```json
{ "token": "eyJ2IjoxLCJmb2xpb19pZCI6...Zm9s.Pk9aZ1f3..." }
```

| Field | Rule |
|---|---|
| `token` | required, non-empty string — the raw QR contents (`payload.signature`) |

No `organization_id` / `agent_id` (Rules 1 & 3; Zod strips unknowns).

#### Response — 200 OK (valid)

```json
{
  "result": "valid",
  "ticket": {
    "client_identity": "Jane Tourist",
    "service_name": "Canyon Sunrise Tour",
    "slot_date": "2026-06-15",
    "slot_start_time": "06:00",
    "passes_total": 5,
    "redeemed_count": 2,
    "pass_number": 2
  }
}
```

`redeemed_count` / `pass_number` are the values **after** this redemption — "Pass 2 of 5
used."

#### Response — 200 OK (invalid)

```json
{
  "result": "invalid",
  "reason": "ALREADY_CONSUMED",
  "ticket": {
    "client_identity": "Jane Tourist",
    "service_name": "Canyon Sunrise Tour",
    "slot_date": "2026-06-15",
    "slot_start_time": "06:00",
    "passes_total": 5,
    "redeemed_count": 5
  }
}
```

`reason` is one of (a body enum — **not** an `ErrorCode`):

| `reason` | Meaning | `ticket` present? |
|---|---|---|
| `INVALID_SIGNATURE` | bad/forged/tampered token, or a token from another org ("fake") | no (untrusted) |
| `EXPIRED` | `now > expires_at` | yes |
| `ALREADY_CONSUMED` | all passes used (`redeemed_count == quantity`) | yes |
| `CANCELLED` | the folio was cancelled | yes |
| `NOT_PAID` | the folio is not `paid` (forward-safe: bookings) | yes |
| `NOT_FOUND` | signature valid but the folio line no longer exists in the org | minimal (client identity only) |

> **No new `ErrorCode`.** `result`/`reason` live in the 200 body. Request-level failures
> reuse existing codes (below).

#### Validation order (deterministic)

```
1. verifyTicket(token, orgKey)          → null      → invalid INVALID_SIGNATURE
2. load folio_line ⋈ folio by (folio_line_id, org)
                                         → none      → invalid NOT_FOUND
3. folio.status === 'cancelled'          → invalid CANCELLED
   folio.status !== 'paid'               → invalid NOT_PAID
4. now > payload.expires_at              → invalid EXPIRED
5. UPDATE folio_lines
     SET redeemed_count = redeemed_count + 1
     WHERE id = :id AND organization_id = :org AND redeemed_count < quantity
     RETURNING redeemed_count
                                         → 0 rows    → invalid ALREADY_CONSUMED
                                         → newCount  → valid (pass_number = newCount)
```

Steps 1–4 are reads; step 5 is the single atomic write and the race backstop.

---

## Error responses (request-level only)

| Status | Code | Condition |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Body fails Zod: missing / empty / non-string `token` |
| 401 | `UNAUTHORIZED` | No / unrefreshable session |
| 403 | `FORBIDDEN` | Authenticated as `admin`, not `agent` |
| 403 | `ACCOUNT_SUSPENDED` | Caller's account is suspended (from `authMiddleware`) |

A successful, authorized request **never** 4xx/5xx for a bad ticket — that is a `200`
`{ result: "invalid", ... }`.

---

## Scenarios

### US-AG15 / US-AG17 — scan, redeem, result

#### Scenario 1 — Valid scan redeems one pass
**Given** an `agent` of `org_a` and a `paid` folio line with `quantity = 5`,
`redeemed_count = 0`, an unexpired ticket
**When** `POST /api/tickets/scan` with its `token`
**Then** Status `200`, `result = "valid"`, `pass_number = 1`, `redeemed_count = 1`,
`passes_total = 5`, plus `client_identity` / `service_name` / `slot_date` /
`slot_start_time`; the stored `folio_lines.redeemed_count` is now `1`.

#### Scenario 2 — Repeated scans advance the progress
**Given** the ticket from Scenario 1
**When** scanned three more times
**Then** each is `valid` with `pass_number` `2`, `3`, `4`; stored `redeemed_count = 4`.

#### Scenario 3 — Scanning past the last pass → all consumed
**Given** a `quantity = 2` ticket already at `redeemed_count = 2`
**When** scanned again
**Then** `200`, `result = "invalid"`, `reason = "ALREADY_CONSUMED"`,
`redeemed_count = 2` (unchanged); no extra redemption is recorded.

#### Scenario 4 — Expired ticket
**Given** a ticket whose `expires_at` is in the past (seed a past-dated slot, or a folio
line whose token encodes a past expiry)
**When** scanned
**Then** `200`, `invalid`, `reason = "EXPIRED"`; `redeemed_count` unchanged.

#### Scenario 5 — Forged / tampered token → fake
**Given** a token with a flipped byte (or an arbitrary string)
**When** scanned
**Then** `200`, `invalid`, `reason = "INVALID_SIGNATURE"`, no `ticket`; nothing redeemed.

#### Scenario 6 — Cross-org ticket reads as fake (no leak)
**Given** a valid ticket minted for `org_b`
**When** an `org_a` agent scans it
**Then** `200`, `invalid`, `reason = "INVALID_SIGNATURE"` (verifies only under `org_b`'s
derived key); `org_b`'s `redeemed_count` is untouched and no `org_b` data is revealed.

#### Scenario 7 — Cancelled folio refuses admission
**Given** a folio with `status = 'cancelled'` and a line with an unexpired ticket
**When** scanned
**Then** `200`, `invalid`, `reason = "CANCELLED"`; `redeemed_count` unchanged.

#### Scenario 8 — Valid signature, missing line → not found
**Given** a well-signed token whose `folio_line_id` does not exist in the caller's org
**When** scanned
**Then** `200`, `invalid`, `reason = "NOT_FOUND"`; nothing redeemed.

#### Scenario 9 — Last-pass race: only one redemption wins
**Given** a `quantity = 1` ticket at `redeemed_count = 0`
**When** two scans are issued (sequentially in the test)
**Then** the first is `valid` (`pass_number = 1`); the second is `invalid
ALREADY_CONSUMED`; stored `redeemed_count = 1` — the `redeemed_count < quantity` guard
prevents over-redemption.

#### Scenario 10 — Missing / empty token → 400
**When** `POST /api/tickets/scan` with `{}` or `{ "token": "" }`
**Then** Status `400 VALIDATION_ERROR`; nothing redeemed.

#### Scenario 11 — Admin is forbidden
**Given** a user with `role = 'admin'`
**When** `POST /api/tickets/scan`
**Then** Status `403 FORBIDDEN`.

### Multitenancy isolation (required — `seedTwoOrgs`)

#### Scenario 12 — B3/B4: redemption is org-scoped end to end
**Given** a `paid` folio line in `org_b`
**When** an `org_a` agent scans its token (Scenario 6) **and**, defensively, when the
redemption UPDATE is attempted, the `organization_id = org_a` filter matches no row
**Then** `org_b`'s `redeemed_count` is never mutated by an `org_a` caller; the per-org key
plus the org-filtered query are independent backstops.

---

## Definition of Done

- [ ] Migration `0014_add_redeemed_count_to_folio_lines.sql` adds
      `redeemed_count integer NOT NULL DEFAULT 0`; Drizzle `folioLines.redeemedCount` added
- [ ] New `src/routes/tickets/` (`index.ts`, `handler.ts`, `schema.ts`) mounted at
      `/api/tickets` with `authMiddleware` + `requireRole('agent')` on `*`
- [ ] `scanTicketSchema` validates a non-empty `token` string (no org/agent fields)
- [ ] `scanTicket` handler follows the deterministic order (verify → load → status →
      expiry → atomic conditional redeem), org-scoped throughout, returning the
      `{ result, reason?, ticket? }` 200 shape; **no new `ErrorCode`**
- [ ] Atomic single-pass redeem via `UPDATE … SET redeemed_count = redeemed_count + 1
      WHERE id = ? AND organization_id = ? AND redeemed_count < quantity RETURNING …`;
      over-redemption impossible
- [ ] `verifyTicket` keyed by `deriveOrgKey(env.QR_SECRET, callerOrg)`; cross-org tokens
      read as `INVALID_SIGNATURE` with no leak
- [ ] `test/tickets/online-qr-scanner.test.ts` covers Scenarios 1–11
- [ ] Multitenancy Scenario 12 via `seedTwoOrgs`
- [ ] Frontend: a QR camera scanner (`@yudiel/react-qr-scanner`), `ticketsService.scan`,
      `useScanTicket`, a `ScannerPage` (route `/scan`), a `ScanResult` ✓/✗ screen
      (client/service/schedule + "Pass N of M"), **re-arm between scans** (debounce), an
      **offline** guard (US-AG19: `navigator.onLine` / network-error → "validation requires
      a connection"), and an agent-only **Scan** nav destination
- [ ] `docs/TECH_DEBT.md`: notes for (a) redemption **audit table deferred** (no MVP
      consumer); (b) scan **not idempotent** (client re-arm; revisit with an idempotency
      key); (c) the strictly-online MVP / Phase-2 offline-sync boundary
- [ ] `pnpm --filter api-turistear test` green; `pnpm build:app` clean
- [ ] `docs/SPEC.md` MUST-HAVE item **Online QR Scanner** *(US-AG15, US-AG17, US-AG19)* ticked
