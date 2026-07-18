# Feature: Total Folio Cancellation

## Context

A sale sometimes has to be undone — a no-show, a double charge, a wrong service. When an
admin **cancels an entire folio**, two things must happen together, atomically: the
**spots are released back to inventory** for every service in the folio (so they can be
re-sold), and the **cancellation is recorded** (who cancelled, when, optionally why). The
folio is not deleted — its history is preserved with `status = 'cancelled'`, and it drops
out of every "collected cash" calculation from that moment on.

This is the **last MUST-HAVE** of the MVP. It is deliberately *total*, not partial:
cancelling a folio cancels **all** its lines at once. Per-line / per-service cancellation
is explicitly **WON'T HAVE THIS TIME** in the SPEC ("Partial cancellations… simplifies
inventory logic in MVP").

**User Stories:**
- **US-A21** — *As an admin, I want to cancel an entire folio to automatically release the
  spots for all included services and record the cancellation.*
- **US-A26** — *As an admin, when cancelling a folio, I want to choose whether the
  cancellation triggers a **clawback** (the agent loses the commission booked on that sale)
  or the company absorbs the loss.*

**Builds on:**
- **POS / folios** (`docs/pos/pos-controlled-discount.spec.md`) — `folios.status`
  (`paid`/`booking`/`cancelled`, the `cancelled` value already exists), `folio_lines`
  (`slot_id`, `quantity`), and `slots.booked` are the inventory counters this feature
  reverses.
- **QR scanner** (`docs/scanner/online-qr-scanner.spec.md`) — the scan handler **already**
  rejects a cancelled folio's tickets via its `CANCELLED` gate
  (`tickets/handler.ts`), so cancellation invalidates outstanding QR access **for free**;
  this feature adds no scanner code.
- **Agent cash balance** (`docs/cash-drops/agent-balance-cash-drops.spec.md`) — the agent's
  **running balance** is derived from events and **excludes** `cancelled` folios from
  `cash_collected`, so cancelling a cash sale immediately lowers that agent's collected cash.
  The commission booked on the folio follows the **clawback** choice (US-A26): on a clawback
  the agent's `commission_total` drops too (they forfeit it); when the company absorbs it the
  agent keeps the commission. The balance recomputes automatically — there is no snapshot to
  rewrite. *(This replaces the retired daily cash-drawer / `deriveIncome` model.)*
- **Auth & roles** — `authMiddleware`, `requireRole`, the multitenancy Enforcement
  Contract (`docs/multitenancy/multitenancy.spec.md`).
- **SPEC business rule (Inventory):** *"Upon cancelling a folio, all spots for the involved
  slots are released."*

### Scope boundary with adjacent features (read carefully)

| Concern | Owner |
|---|---|
| **Cancel a whole folio**, release **all** its slots' spots, **record** the cancellation (who/when/why), admin browse-to-find | **This feature** |
| **Per-service / partial cancellation** | **WON'T HAVE THIS TIME** (SPEC) — out of scope |
| **Client email on cancellation** (US-C03) | *Resend ticket delivery* (SHOULD HAVE) — **not built yet**; this feature leaves a single integration seam and a TECH_DEBT note, no email is sent |
| **QR ticket invalidation** | *Scanner* — already enforced by the `CANCELLED` gate; **no new code** |
| **Commission clawback on cancel** (US-A26) | **This feature** sets `cancellation_clawback` from the admin's choice; the *Agent cash balance* derivation reads it to decide whether the agent forfeits or keeps the commission |
| **Excluding cancelled cash / commission from the balance** | *Agent cash balance* (`docs/cash-drops/…`) — its derivation already excludes `cancelled` folios from `cash_collected` and applies the clawback to `commission_total`; this feature only flips the status + flag, it computes no money |
| **Admin sales summary / occupancy dashboard** (US-A14–A16) | *Occupancy dashboard* (SHOULD HAVE) — this feature ships only a **lean folio list** sufficient to find a folio to cancel, not a metrics dashboard |
| **Cash refund tracking & Refund PIN** (US-A23, US-T05) | *Cash refund tracking* + *Tourist Self-Service Portal* (Phase 2) — confirming the **physical cash handed back** (and the tourist-facing **Refund PIN**) is a separate flow that attaches to the cancelled folio. This feature leaves that seam; it moves no money |
| **Tourist-initiated cancellation request** (US-T04) | *Tourist Self-Service Portal* (Phase 2) — the portal creates a **request** an admin reviews; the actual release still runs through this feature's `cancelFolio` |

**New endpoints:** a new `src/routes/folios/` router mounted at `/api/folios`, **admin-only**
(`authMiddleware` + `requireRole('admin')` on `*`). The existing agent receipt read stays
at `GET /api/pos/folios/:id` (agent-scoped) and is untouched.

| Method & path | Role | Purpose | US |
|---|---|---|---|
| `GET  /api/folios?date=&agent_id=&status=` | admin | List folios in the org (find one to cancel) | A21 |
| `GET  /api/folios/:id` | admin | One folio's detail (confirm before cancelling) | A21 |
| `POST /api/folios/:id/cancel` | admin | Cancel the whole folio: release spots + record | A21 |

---

## Data Model

**No new tables.** Three **additive, nullable** audit columns on the existing `folios`
table record the cancellation. Additive nullable columns are safe on a populated table
(no backfill), mirroring `0013`'s `qr_token`.

### `folios` — new columns

| Column | Type | Notes |
|---|---|---|
| `cancelled_at` | `integer` timestamp (nullable) | set when cancelled |
| `cancelled_by` | `text` → `users(id)` (nullable) | the **admin** who cancelled (from context) |
| `cancellation_reason` | `text` (nullable) | optional admin note |
| `cancellation_clawback` | `integer` boolean, default `0` | **US-A26** — `1` = claw back the agent's commission (they forfeit it); `0` (default) = the company absorbs it. Written by `cancelFolio`, **read** by the Agent-cash-balance derivation. |

> The `status` enum already includes `cancelled` — no enum migration. Cancellation is the
> only writer of the three audit columns; they stay `null` for every active folio.
> `cancellation_clawback` defaults to `0` for every active folio.

> Migrations: `0017_add_cancellation_to_folios.sql` (the three audit columns, matching the
> `0001`–`0016` style) and `0022_add_commission_to_folios.sql` (adds `cancellation_clawback`
> alongside the POS `payment_method` / `commission_amount` columns — shipped with the
> Agent-cash-balance feature, consumed here for US-A26).

---

## Business Rules (enforced server-side)

1. **Total only.** Cancelling a folio sets `folios.status = 'cancelled'` for the **whole**
   folio and releases **every** line's spots. There is no partial path.
2. **Release inventory.** For each `folio_line`, `slots.booked` is decremented by that
   line's `quantity` (org-scoped), clamped at zero defensively
   (`booked = MAX(0, booked − quantity)`) so a manually-edited slot can never go negative.
   The released spots are immediately re-sellable (POS reads `capacity − booked`).
3. **Atomicity.** The folio `UPDATE` and **all** slot decrements happen in **one D1 batch**
   (rolls back as a unit). Either the folio is cancelled *and* every slot released, or
   nothing changes.
4. **Idempotency / double-cancel guard.** Cancelling an **already-cancelled** folio →
   `409 CONFLICT` (spots are never released twice). The folio `UPDATE` is additionally
   guarded `WHERE status != 'cancelled'` as a race backstop.
5. **Eligible states.** A `paid` **or** `booking` folio may be cancelled (a reserved
   booking still holds spots that must be freed). Only `cancelled` is terminal.
6. **Record the cancellation** (US-A21). Set `cancelled_at = now`,
   `cancelled_by = caller admin` (from context, **never** the body), and
   `cancellation_reason = body.reason ?? null`.
7. **Tickets follow status — no extra work.** Outstanding QR tickets of a cancelled folio
   are rejected by the scanner's existing `CANCELLED` gate. Already-redeemed passes are
   **not** "un-redeemed"; `redeemed_count` is left as-is (historical record).
8. **Running-balance & commission interaction (US-A26).** The cancel request carries an
   optional `clawback` boolean; cancelling sets `cancellation_clawback` from it (default
   `false`). The agent's **running balance** (`docs/cash-drops/…`) is event-derived, so the
   cancelled folio immediately leaves `cash_collected`. The folio's snapshot
   `commission_amount` is left **as-is** (historical record), and the derivation applies the
   clawback: `clawback = true` → the agent **forfeits** that commission (it leaves
   `commission_total`); `clawback = false` → the company absorbs the loss and the agent
   **keeps** the commission. This feature writes only the status + flag; it computes no money.
9. **Refund is a separate flow (US-A23 / US-T05).** Cancellation is an inventory + record
   action and moves no cash. Tracking that the **physical cash was returned** to the customer
   (and the tourist-facing **Refund PIN**) is a future flow that will attach to the cancelled
   folio. This feature leaves the seam and changes no money.
10. **Multitenancy & role.** Admin-only. Every query filters `organization_id` from context
    (Rules 2 & 4). A cross-org or unknown folio id → `404 NOT_FOUND` (no existence leak).
    `organization_id` / `status` / `cancelled_by` are **never** read from a body (Rules 1 & 3);
    only `reason` and the `clawback` flag are client-supplied.
11. **No new `ErrorCode`.** Reuse `409 CONFLICT` (already cancelled), `404 NOT_FOUND`
    (unknown/cross-org), `400 VALIDATION_ERROR` (bad body).

---

## Endpoints

All endpoints **auth-required + admin**. A non-admin → `403 FORBIDDEN`; a suspended caller
is stopped by `authMiddleware` (`403 ACCOUNT_SUSPENDED`). Cross-org / unknown id →
`404 NOT_FOUND`.

### `GET /api/folios?date=&agent_id=&status=` — admin folio list (US-A21)

Folios in the caller's org, newest first; optional filters (`date` = `created_at` UTC
calendar day, `agent_id`, `status`). A lean row shape — enough to find a folio to cancel,
**not** a sales dashboard.

#### 200 OK
```json
{
  "folios": [
    {
      "id": "fol_abc",
      "agent": { "id": "usr_1", "name": "Ana" },
      "customer_name": "John Diver",
      "status": "paid",
      "total": 845000,
      "amount_paid": 845000,
      "created_at": 1750000000,
      "cancelled_at": null
    }
  ]
}
```

### `GET /api/folios/:id` — admin folio detail (US-A21)

One folio in the caller's org with its lines, extras, totals, customer, agent, and
cancellation audit (`cancelled_at`, `cancelled_by`, `cancellation_reason`). → `200
{ "folio": { … } }`. `404` cross-org/unknown.

### `POST /api/folios/:id/cancel` — cancel the whole folio (US-A21, US-A26)

```json
{ "reason": "Customer no-show", "clawback": true }
```
Both fields optional (`reason` → `null`, `clawback` → `false`). Releases every line's spots,
sets `status = 'cancelled'`, and records the audit fields + the clawback flag. → `200
{ "folio": { …, "status": "cancelled", "cancelled_at", "cancelled_by", "cancellation_reason",
"cancellation_clawback" } }`.

- `404` if unknown / cross-org.
- `409 CONFLICT` if the folio is **already cancelled**.

---

## Error responses

| Status | Code | Condition |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Malformed body (e.g. non-string `reason`) |
| 401 | `UNAUTHORIZED` | No / unrefreshable session |
| 403 | `FORBIDDEN` | Caller is not an admin |
| 403 | `ACCOUNT_SUSPENDED` | Caller's account suspended (from `authMiddleware`) |
| 404 | `NOT_FOUND` | Folio unknown or in another org |
| 409 | `CONFLICT` | Folio is already cancelled |

---

## Scenarios

### US-A21 — Cancel a folio, release spots, record it

#### Scenario 1 — Cancelling releases every line's spots
**Given** an `org_a` admin and a `paid` folio with two lines — line A on slot S1
(`quantity = 3`) and line B on slot S2 (`quantity = 2`) — where `S1.booked = 3` and
`S2.booked = 2`
**When** `POST /api/folios/:id/cancel`
**Then** Status `200`; `folio.status = "cancelled"`; `S1.booked = 0` and `S2.booked = 0`
(both fully released); the freed spots are re-sellable.

#### Scenario 2 — Cancellation is recorded
**Given** an `org_a` admin cancelling a folio with `{ "reason": "Customer no-show" }`
**When** the request succeeds
**Then** `cancelled_at` is set (≈ now), `cancelled_by = <the admin's user id>`,
`cancellation_reason = "Customer no-show"`. With no body / no `reason`, the folio is still
cancelled and `cancellation_reason = null`.

#### Scenario 3 — A booking folio can be cancelled
**Given** a folio with `status = "booking"` holding spots on a slot
**When** the admin cancels it
**Then** Status `200`; `status = "cancelled"`; the held spots are released.

#### Scenario 4 — Double cancellation → 409
**Given** a folio already `cancelled`
**When** the admin cancels it again
**Then** Status `409 CONFLICT`; `slots.booked` is **unchanged** (spots are never
double-released); the audit fields keep their original values.

#### Scenario 5 — Atomic: partial failure releases nothing
**Given** a multi-line folio
**When** the cancellation batch cannot complete (simulated failure)
**Then** the folio remains `paid` **and** no slot's `booked` changes (all-or-nothing).

#### Scenario 6 — Cancelling lowers the agent's running balance
**Given** an `agent` holding a `paid` **cash** folio of 300000 that is part of their running
balance (`GET /api/cash/me`)
**When** the admin cancels that folio
**Then** the agent's derived `cash_collected` **excludes** the 300000 and the running
`balance` drops accordingly.

#### Scenario 6b — Clawback choice is recorded and applied (US-A26)
**Given** a `paid` folio carrying a booked `commission_amount`
**When** the admin cancels it with `{ "clawback": true }`
**Then** `cancellation_clawback = true` on the folio and the agent's derived
`commission_total` **no longer includes** that folio's commission (they forfeit it).
Cancelling another folio with `{ "clawback": false }` (or no flag) records
`cancellation_clawback = false` and the agent **keeps** that commission.

#### Scenario 7 — Cancelled folio's tickets are rejected by the scanner
**Given** a folio that has been cancelled
**When** an agent scans one of its QR tickets (`POST /api/tickets/scan`)
**Then** the scan result is `{ result: "invalid", reason: "CANCELLED" }`; `redeemed_count`
is not incremented. *(No new code — the existing scanner gate covers this; asserted here as
an integration guarantee.)*

#### Scenario 8 — Admin lists and reads folios
**Given** several folios in `org_a` (some `paid`, one `cancelled`)
**When** the admin `GET /api/folios` and `GET /api/folios/:id`
**Then** Status `200`; the list returns the org's folios newest-first with their agent,
status and totals; the detail returns lines/extras/totals + cancellation audit.

### Roles

#### Scenario 9 — Non-admin → 403
**Given** an `agent` (or any non-admin) calling `GET /api/folios`, `GET /api/folios/:id`, or
`POST /api/folios/:id/cancel`
**Then** Status `403 FORBIDDEN`; nothing changes.

### Multitenancy isolation (required — `seedTwoOrgs`)

#### Scenario 10 — B3: cross-org folio is unreachable
**Given** a folio in `org_b`
**When** the `org_a` admin `GET /api/folios/:id` or `POST /api/folios/:id/cancel` it by id
**Then** Status `404 NOT_FOUND`; the `org_b` folio is untouched (still `paid`, spots held).

#### Scenario 11 — B4 / B1: list is org-scoped; injected org/actor ignored
**Given** folios in both `org_a` and `org_b`, and an `org_a` admin who cancels with a body
that also includes `"organizationId": "org_b"` and `"cancelled_by": "someone-else"`
**When** the requests are processed
**Then** `GET /api/folios` returns **only** `org_a` folios; the injected fields are
ignored — the cancelled folio's `organization_id` stays `org_a` and `cancelled_by` is the
**real caller admin**.

---

## Definition of Done

### Shipped (US-A21 + US-A26)
- [x] Migration `0017_add_cancellation_to_folios.sql` adds nullable `cancelled_at`,
      `cancelled_by` (→ `users.id`), `cancellation_reason` to `folios`
- [x] Migration `0022_add_commission_to_folios.sql` adds `cancellation_clawback` (boolean,
      default `0`) — shipped with the Agent-cash-balance feature, written here for US-A26
- [x] Drizzle schema: the cancellation columns + types infer
- [x] New `src/routes/folios/` (`index.ts`, `handler.ts`, `schema.ts`) mounted at
      `/api/folios` with `authMiddleware` + `requireRole('admin')` on `*`
- [x] `cancelFolio` releases **all** lines' spots (`booked = MAX(0, booked − quantity)`)
      and flips status in **one D1 batch**; already-cancelled → `409`; unknown/cross-org →
      `404`; records `cancelled_at`/`cancelled_by`(context)/`cancellation_reason` and
      `cancellation_clawback` from the request's `clawback` flag
- [x] `listFolios` + `getFolioDetail` admin-only, org-scoped; lean list shape
- [x] Org filter on every query; `organization_id`/`status`/`cancelled_by` never from body
      (Rules 1 & 3); only `reason` + `clawback` are client-supplied; **no new `ErrorCode`**
- [x] Scenarios 1–11 (+ 6b) covered by `test/folios/folio-cancellation.test.ts` — spots,
      audit, atomicity, the collected-cash exclusion, the **clawback-flag persistence** (6b),
      scanner `CANCELLED`, roles, multitenancy
- [x] The clawback's effect on the commission (US-A26) is covered in
      `test/cash/agent-balance-cash-drops.test.ts` (Scenario 20 drives the real `cancelFolio`
      API with `clawback:true` and asserts the commission leaves `commission_total`)
- [x] Frontend: `foliosService`, `features/folios/` (types/hooks), an admin **Folios** list
      page + **Folio detail** page with a guarded **Cancel folio** action (confirm dialog +
      optional reason + a **clawback** switch, US-A26, that threads `clawback` through
      `foliosService.cancelFolio` / `useCancelFolio`; the cancelled-folio alert states
      whether the commission was clawed back or absorbed); admin-only **Folios** nav + routes
- [x] `pnpm --filter api-turistear test` green; `pnpm build:app` clean
- [x] `docs/SPEC.md` MUST-HAVE item **Total folio cancellation (US-A21)** ticked

### Remaining (future features, not this one)
- [ ] **Client cancellation email** (US-C03) — the `cancelFolio` handler is the single seam;
      fires once the Email feature lands (`docs/TECH_DEBT.md`).
- [ ] **Cash-refund tracking + Refund PIN** (US-A23 / US-T05) — a future flow attaches to the
      cancelled folio to confirm the physical refund; the Tourist Portal (US-T04) creates the
      cancellation request that funnels into `cancelFolio`.
