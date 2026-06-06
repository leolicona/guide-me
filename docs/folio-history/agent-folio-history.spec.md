# Feature: Agent Folio History (read-only list and details)

## Context

An agent sells all day in the field. Later — a customer calls back, a slot is in dispute, or
they simply want to review what they sold — the agent needs to **look up their own past
folios**. This feature gives the agent a **read-only** history: a list of the folios *they*
created, with status (paid / booking / cancelled), and the ability to open any one of them to
see the services, schedules, amounts, and the customer's QR tickets.

It is deliberately **read-only**. It adds no money movement, no cancellation, no editing — an
agent cannot cancel a folio (that is admin-only, `docs/cancellation/…`) and cannot mutate
anything from here. It is a **window onto already-recorded sales**, scoped strictly to the
caller agent.

**User Stories:**
- **US-AG20** — *As an agent, I want to see a list of my historical sales (folios) with their
  status (paid, booking, cancelled) so I can review my past transactions.*
- **US-AG21** — *As an agent, I want to view the details of a specific folio I created,
  including the services sold and amounts, to answer customer queries.*

**Builds on (almost everything already exists):**
- **POS / folios** (`docs/pos/pos-controlled-discount.spec.md`) — the `folios`, `folio_lines`,
  `folio_line_extras` tables, and the agent-scoped folio **detail read** already shipped as
  `GET /api/pos/folios/:id` (`getFolio` in `pos/handler.ts`, built for US-AG08 receipt). That
  endpoint **already satisfies US-AG21** — it returns lines, extras, totals, customer, and a
  signed-QR echo per line, scoped to the caller agent (`agent_id = caller`). This feature
  **adds no detail endpoint**; it reuses it.
- **QR signing** (`docs/qr/folio-qr-signing.spec.md`) — the detail read already verifies and
  echoes each line's signed ticket (`qr` / `qr_token`), so an agent can re-show a customer's
  QR from history for free.
- **Total folio cancellation** (`docs/cancellation/…`) — adds `status = 'cancelled'` and the
  `cancelled_at` audit column. The history surfaces these (a cancelled folio shows as
  `cancelled`); it does **not** create or perform cancellations.
- **Auth & roles** — `authMiddleware`, `requireRole('agent')` (the POS router is already
  agent-only), the multitenancy Enforcement Contract (`docs/multitenancy/multitenancy.spec.md`).
- **App shell & money helpers** — `AppLayout` nav, `features/catalog/types` `formatMoney`,
  `features/pos/hooks` (`useFolio`), `TicketQr`.

### Scope boundary with adjacent features (read carefully)

| Concern | Owner |
|---|---|
| **Agent lists their OWN folios** (status + lean row) | **This feature** — new `GET /api/pos/folios` |
| **Agent reads ONE of their own folios in full** (US-AG21) | **Already shipped** — `GET /api/pos/folios/:id`; this feature only navigates to it + adds a history-framed detail page |
| **Agent cancels / edits a folio** | **Out of scope** — cancellation is admin-only (`docs/cancellation/…`); this surface is strictly read-only |
| **Resend receipt + QR from history** (US-AG22) | **Deferred to Phase 2** (SPEC) — not built here; a seam only |
| **Admin browse of ALL org folios** | *Total folio cancellation* (`docs/cancellation/…`) — the admin list at `GET /api/folios` is org-wide and supports an `agent_id` filter; it is untouched |
| **Sales totals / per-agent performance dashboards** (US-A16/A18) | *Occupancy dashboard* / *Commission report* (SHOULD HAVE) — this feature ships a per-folio list, not aggregated metrics |
| **Running balance / commission per sale** | *Agent cash balance* (`docs/cash-drops/…`) — the history shows the booked `commission_amount` on a folio; it computes no balance |

**New endpoints:** exactly **one**, on the existing agent-only POS router (mounted at
`/api/pos`, already `authMiddleware` + `requireRole('agent')` on `*`).

| Method & path | Role | Purpose | US |
|---|---|---|---|
| `GET /api/pos/folios?status=&date=` | agent | List the **caller agent's** folios (their history) | AG20 |
| `GET /api/pos/folios/:id` | agent | One of the caller agent's folios in full *(already shipped, US-AG08)* | AG21 |

> The list is **always** scoped to the caller (`agent_id = caller.userId`); there is **no**
> `agent_id` query param (an agent cannot view another agent's history — that distinguishes it
> from the admin org-wide list, which *does* take `agent_id`).

---

## Data Model

**No new tables, no new columns, no migration.** Everything read here already exists on
`folios` / `folio_lines` / `folio_line_extras` (POS + cancellation features). The list reads a
lean projection of `folios`; the detail reuses the existing `readFolio` shape in
`pos/handler.ts`.

Columns surfaced by the **list** (lean row): `id`, `customer_name`, `status`
(`paid`/`booking`/`cancelled`), `total`, `amount_paid`, `created_at`, `cancelled_at`.
The detail adds lines/extras/totals/customer + the per-line signed-QR echo (existing).

---

## Business Rules (enforced server-side)

1. **Read-only.** This feature performs **no** writes. It lists and reads folios; it never
   cancels, edits, or moves money.
2. **Caller-scoped (the core isolation rule).** The list returns **only** folios where
   `agent_id = caller.userId` **and** `organization_id = caller.organizationId`. There is no
   `agent_id` query parameter — an agent can never see another agent's folios. The detail read
   (`GET /api/pos/folios/:id`) is already guarded the same way; a folio belonging to another
   agent (even in the same org) → `404 NOT_FOUND` (no existence leak).
3. **Newest first.** The list is ordered `created_at DESC` (most recent sales on top).
4. **Optional filters.** `status` (`paid` | `booking` | `cancelled`; any other value is
   ignored) and `date` (a `created_at` UTC calendar day, `strftime('%Y-%m-%d', created_at,
   'unixepoch') = date`). Both come from the query string; neither widens the caller scope.
5. **Status is shown, never changed.** A `cancelled` folio appears in the history with
   `status = 'cancelled'` and its `cancelled_at`; the agent cannot act on it.
6. **Multitenancy & role.** Agent-only (the POS router enforces `requireRole('agent')`; an
   admin → `403 FORBIDDEN`). Every query filters `organization_id` **and** `agent_id` from
   context (Rules 2 & 4 of the Enforcement Contract); neither is ever read from the request.
7. **No new `ErrorCode`.** Reuse `404 NOT_FOUND` (unknown / other-agent / cross-org detail),
   `403 FORBIDDEN` (non-agent), `401 UNAUTHORIZED` (no session).
8. **No email, no resend (yet).** Re-sending the receipt/QR (US-AG22) is **Phase 2**; this
   feature leaves the seam and sends nothing.

---

## Endpoints

All endpoints **auth-required + agent** (the POS router). A non-agent → `403 FORBIDDEN`; a
suspended caller is stopped by `authMiddleware` (`403 ACCOUNT_SUSPENDED`).

### `GET /api/pos/folios?status=&date=` — agent folio history list (US-AG20)

The caller agent's own folios, newest first; optional `status` / `date` filters. A **lean**
row shape — enough to scan a transaction history and tap into one, **not** a metrics
dashboard.

#### 200 OK
```json
{
  "folios": [
    {
      "id": "fol_abc",
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

> No `agent` block (every row is the caller's own) and no `agent_id` filter — that is what
> distinguishes this from the admin org-wide list (`GET /api/folios`).

### `GET /api/pos/folios/:id` — agent folio detail (US-AG21) — *already shipped*

One of the caller agent's folios in full: lines (service, slot date/time, quantity, unit
price, line total) + extras, totals (subtotal, discount, total, amount paid), customer, the
booked `commission_amount`, and the per-line signed-QR echo (`qr` / `qr_token`). →
`200 { "folio": { … } }`. Unknown / **another agent's** / cross-org id → `404 NOT_FOUND`.

> This endpoint already exists (`getFolio`, built for the US-AG08 receipt). This feature adds
> **no backend code** for it — it only links the history list to it and adds a
> history-framed detail page on the frontend.

---

## Error responses

| Status | Code | Condition |
|---|---|---|
| 401 | `UNAUTHORIZED` | No / unrefreshable session |
| 403 | `FORBIDDEN` | Caller is not an agent (e.g. an admin) |
| 403 | `ACCOUNT_SUSPENDED` | Caller's account suspended (from `authMiddleware`) |
| 404 | `NOT_FOUND` | Folio unknown, in another org, or belongs to another agent (detail) |

---

## Scenarios

### US-AG20 — Agent lists their own folios

#### Scenario 1 — History lists only the caller's folios, newest first
**Given** an agent with three of their own folios (created at t1 < t2 < t3) and another
agent's folio in the **same org**
**When** the agent `GET /api/pos/folios`
**Then** Status `200`; exactly the agent's **three** folios are returned, ordered
`created_at DESC` (t3, t2, t1); the other agent's folio is **absent**.

#### Scenario 2 — Each row carries its status
**Given** the caller agent has one `paid`, one `booking`, and one `cancelled` folio
**When** they list their history
**Then** each row's `status` reflects the folio (`paid` / `booking` / `cancelled`); the
`cancelled` row carries a non-null `cancelled_at`.

#### Scenario 3 — Status filter
**Given** the caller's history contains mixed statuses
**When** `GET /api/pos/folios?status=cancelled`
**Then** only the caller's `cancelled` folios are returned; an unrecognized `status` value is
ignored (returns the unfiltered caller-scoped list).

#### Scenario 4 — Date filter (created_at UTC day)
**Given** the caller has folios created on `2026-06-05` and `2026-06-06`
**When** `GET /api/pos/folios?date=2026-06-06`
**Then** only the caller's folios created on that UTC calendar day are returned.

#### Scenario 5 — Empty history
**Given** an agent who has created no folios
**When** they list their history
**Then** Status `200` with `{ "folios": [] }`.

### US-AG21 — Agent reads one of their own folios

#### Scenario 6 — Detail of the caller's own folio
**Given** the caller agent owns folio `fol_x` with two lines and an extra
**When** `GET /api/pos/folios/fol_x`
**Then** Status `200`; the detail returns the lines (service, slot date/time, quantity, unit
price, line total) + extras, totals, customer, and a per-line `qr` echo (existing behavior).

#### Scenario 7 — Another agent's folio is unreachable
**Given** folio `fol_y` created by a **different** agent in the **same org**
**When** the caller agent `GET /api/pos/folios/fol_y`
**Then** Status `404 NOT_FOUND` (the history detail leaks no other-agent folio).

#### Scenario 8 — A cancelled folio is visible read-only
**Given** one of the caller's folios was later cancelled by an admin (`status = 'cancelled'`)
**When** the agent opens it from history
**Then** Status `200`; `status = "cancelled"`; the agent sees it as cancelled and has **no**
action to change it (read-only).

### Roles

#### Scenario 9 — Non-agent → 403
**Given** an `admin` (or any non-agent) calling `GET /api/pos/folios`
**Then** Status `403 FORBIDDEN` (the POS router is agent-only).

### Multitenancy isolation (required — `seedTwoOrgs`)

#### Scenario 10 — B3: cross-org folio is unreachable
**Given** a folio in `org_b`
**When** an `org_a` agent `GET /api/pos/folios/:id` it by id
**Then** Status `404 NOT_FOUND`.

#### Scenario 11 — B4: list is org- and caller-scoped
**Given** folios in both `org_a` and `org_b` (and multiple agents in `org_a`)
**When** an `org_a` agent lists their history
**Then** only **their own** `org_a` folios are returned — never another org's, never another
agent's; no query parameter can widen the scope.

---

## Definition of Done

### Backend (US-AG20)
- [x] `listAgentFolios` added to `src/routes/pos/handler.ts`: caller-scoped
      (`organization_id` + `agent_id` from context), `created_at DESC`, optional `status` /
      `date` filters, lean row shape (`id`, `customer_name`, `status`, `total`, `amount_paid`,
      `created_at`, `cancelled_at`)
- [x] Route `GET /api/pos/folios` wired in `src/routes/pos/index.ts` (agent-only, already
      enforced by the router's `requireRole('agent')`)
- [x] **No** `agent_id` query param (an agent can never widen scope); no new table / column /
      migration; **no new `ErrorCode`**
- [x] The detail read (`GET /api/pos/folios/:id`, US-AG21) is **reused unchanged** (only an
      additive `cancelled_at` field added to its response, for the cancelled banner)
- [x] `test/pos/agent-folio-history.test.ts` covers Scenarios 1–11: caller-scoped list,
      ordering, status + date filters, empty history, own-detail, other-agent `404`, cancelled
      visible read-only, non-agent `403`, and multitenancy B3/B4 (`seedTwoOrgs`)

### Frontend (US-AG20 + US-AG21)
- [x] `posService.listMyFolios({ status?, date? })` → `GET /api/pos/folios`
- [x] `FolioHistoryItem` type + `useMyFolios(filters)` hook in `features/pos`
- [x] Agent **Historial** list page (status chips, customer, date, total; row → detail) with a
      status filter; empty state
- [x] Agent folio **detail** page (reuses the existing `useFolio` → `GET /api/pos/folios/:id`):
      status-aware framing (a `cancelled` banner when applicable), lines/extras/totals,
      customer, per-line QR (`TicketQr`) — **no** cancel/edit affordance
- [x] Agent-only **Historial** nav entry + routes (distinct from the admin **Folios** route
      and the post-sale receipt route)

### Docs
- [x] `docs/SPEC.md` SHOULD-HAVE item **Agent folio history (US-AG20, US-AG21)** ticked with a
      link to this spec

### Remaining (future, not this feature)
- [ ] **Resend receipt + QR from history** (US-AG22) — **Phase 2**; the history detail page is
      the seam where the resend action will hook in once it lands.
