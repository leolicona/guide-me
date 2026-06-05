# Feature: Agent's Daily Cash Drawer with Operating Expenses

## Context

At the end of a field day, an agent reconciles the cash they hold: the **cash they
collected** from sales, minus the **operating expenses** they paid out (gasoline,
supplies), gives the **net balance** they should hand in. This is the *corte de caja*
(cash closure). The agent registers expenses through the day, sees a live summary, then
**submits the closure** to their admin, who **reviews and validates** it.

Income is never hand-entered: like POS totals, the server **derives** it from the agent's
own folios for that calendar day. The agent only enters expenses. A submitted closure is
an **immutable snapshot** (same philosophy as a folio), so the admin reviews a stable
record even if the agent keeps selling afterward.

**User Stories:** US-AG12 (daily sales summary), US-AG13 (register operating expenses),
US-AG14 (generate/submit the daily closure), US-A19 (admin reviews & validates closures).

**Builds on:**
- **POS / folios** (`docs/pos/pos-controlled-discount.spec.md`) — `folios.agent_id`,
  `status` (`paid`/`booking`/`cancelled`), `total`, `amount_paid`, `created_at` are the
  income source.
- **Auth & roles** — `authMiddleware`, `requireRole`, the multitenancy Enforcement
  Contract (`docs/multitenancy/multitenancy.spec.md`).
- **SPEC glossary** — *Cash closure (Corte de caja): Agent's daily summary: sales,
  operating expenses, and net balance.*

### Scope boundary with adjacent features (read carefully)

| Concern | Owner |
|---|---|
| Per-agent per-day drawer, **operating expenses**, **derived income summary**, **submit closure** (snapshot), **admin review/validate** | **This feature** |
| **Commissions** (base % + service bonus) on collected sales | *Commissions* (US-A12, US-AG-commissions) — **not** part of net balance here |
| **Bookings** partial payment / `booking` status that drives "pending to collect" | *Bookings* (US-AG07) — this feature **reads** `amount_paid`/`status` and reports `pending_balance` generically (0 until bookings exist) |
| **Folio cancellation** | *Total folio cancellation* (US-A21) — this feature **excludes** `cancelled` folios from collected cash |
| **Report export** (PDF/CSV) | *Report export* (COULD HAVE) — the closure here is JSON; no file generation |
| Re-opening a rejected closure / opening float / multi-currency | **Deferred** (see Business Rules) |

**New endpoints:** a new `src/routes/cash-drawers/` router mounted at
`/api/cash-drawers`, `authMiddleware` on `*` and **per-route** `requireRole` (agent for
`/me/*`, admin for the review surface).

| Method & path | Role | Purpose | US |
|---|---|---|---|
| `GET  /api/cash-drawers/me` | agent | The caller's drawer + live summary for a date | AG12 |
| `POST /api/cash-drawers/me/expenses` | agent | Register an operating expense | AG13 |
| `DELETE /api/cash-drawers/me/expenses/:id` | agent | Remove an expense (while open) | AG13 |
| `POST /api/cash-drawers/me/close` | agent | Submit the day's closure (snapshot) | AG14 |
| `GET  /api/cash-drawers` | admin | List closures in the org for review | A19 |
| `GET  /api/cash-drawers/:id` | admin | One closure's detail (breakdown + expenses) | A19 |
| `POST /api/cash-drawers/:id/review` | admin | Approve or reject a submitted closure | A19 |

> **Why one router, mixed roles.** Both surfaces act on the same resource. The static
> `/me/*` routes (agent) are registered **before** the `/:id` routes (admin) so `me` is
> never captured as an `:id`. (Two routers `/api/cash-drawer` + `/api/cash-drawers` would
> collide — the latter is a prefix of nothing but Hono mounts by prefix.)

---

## Data Model

Two **new tenant-scoped tables**. Per Multitenancy Rule 5 each declares
`organization_id TEXT NOT NULL REFERENCES organizations(id)`; expenses also carry it
directly for independent org-filtering and a clean org-leading index (Rule 6).

### Money & snapshot principles

- All money is **integer minor units** (centavos) — same as catalog/POS.
- **Income is server-derived, never client-sent.** `total_collected`, `pending_balance`,
  `folio_count` are computed from `folios` for `(organization_id, agent_id, business_date)`
  where `business_date` is the **UTC calendar date** of `folios.created_at`
  (`strftime('%Y-%m-%d', created_at, 'unixepoch')`) — the same naive single-timezone
  assumption used across schedules/POS/QR.
- A **submitted closure is immutable**: `close` snapshots the totals onto the
  `cash_drawers` row; reads of a submitted/reviewed drawer return the **snapshot**, not a
  live re-derivation, so post-submit sales never mutate a closure already in the admin's
  queue.

### `cash_drawers` (new table) — one agent's day

| Column | Type | Notes |
|---|---|---|
| `id` | `text` PK | `crypto.randomUUID()` |
| `organization_id` | `text NOT NULL` → `organizations(id)` | Rule 5 |
| `agent_id` | `text NOT NULL` → `users(id)` | the owning agent |
| `business_date` | `text NOT NULL` | `YYYY-MM-DD` org-local day |
| `status` | `text NOT NULL DEFAULT 'open'` | enum `['open','submitted','approved','rejected']` |
| `total_collected` | `integer` (nullable) | **snapshot at close** — cash collected (Σ `amount_paid`, non-cancelled) |
| `pending_balance` | `integer` (nullable) | **snapshot at close** — Σ `(total − amount_paid)` (bookings) |
| `expense_total` | `integer` (nullable) | **snapshot at close** — Σ expense amounts |
| `net_balance` | `integer` (nullable) | **snapshot at close** — `total_collected − expense_total` (may be negative) |
| `folio_count` | `integer` (nullable) | **snapshot at close** — count of non-cancelled folios |
| `submitted_at` | `integer` timestamp (nullable) | set on close |
| `reviewed_by` | `text` → `users(id)` (nullable) | admin who validated |
| `reviewed_at` | `integer` timestamp (nullable) | set on review |
| `review_note` | `text` (nullable) | admin note (esp. on reject) |
| `created_at` / `updated_at` | `integer` timestamp | |

Indexes (Rule 6):
```sql
CREATE UNIQUE INDEX cash_drawers_org_agent_date_unique_idx
  ON cash_drawers (organization_id, agent_id, business_date); -- one drawer per agent per day
CREATE INDEX cash_drawers_org_status_idx ON cash_drawers (organization_id, status); -- admin review list
```

> Snapshot columns are **nullable**: a row is `open` while the agent works (totals derived
> live on read); `close` fills them. A row is **lazily created** on the first expense or
> first close — a day with no activity has no row.

### `cash_drawer_expenses` (new table) — operating expenses

| Column | Type | Notes |
|---|---|---|
| `id` | `text` PK | |
| `organization_id` | `text NOT NULL` → `organizations(id)` | Rule 5, carried directly |
| `cash_drawer_id` | `text NOT NULL` → `cash_drawers(id)` | parent drawer |
| `description` | `text NOT NULL` | e.g. "Gasoline" (non-empty) |
| `amount` | `integer NOT NULL` | minor units, `> 0` |
| `created_at` | `integer` timestamp | |

Index (Rule 6): `CREATE INDEX cash_drawer_expenses_org_drawer_idx ON cash_drawer_expenses (organization_id, cash_drawer_id);`

> Migrations: `0015_create_cash_drawers.sql`, `0016_create_cash_drawer_expenses.sql`
> (FK order: drawers → expenses), matching the `0001`–`0014` style.

---

## Business Rules (enforced server-side)

1. **One drawer per agent per day** (`organization_id, agent_id, business_date` unique).
   Lazily created `open` on the first expense or first close; `GET /me` returns a
   **virtual** open drawer (`id: null`, zero expenses) when no row exists — reads never
   write.
2. **Income is derived, never sent.** `total_collected = Σ amount_paid`,
   `pending_balance = Σ (total − amount_paid)`, `folio_count = count`, over the agent's
   folios with `status != 'cancelled'` whose `created_at` UTC date equals `business_date`.
   (Bookings contribute their partial `amount_paid` to collected and their outstanding to
   `pending_balance`; paid folios contribute `0` pending.)
3. **Expenses:** `amount` integer `> 0`; `description` non-empty (trimmed). May be added or
   deleted **only while** the drawer is `open`; on a `submitted`/`approved`/`rejected`
   drawer → `409 CONFLICT`.
4. **Net balance** = `total_collected − expense_total` (minor units; **may be negative** —
   a loss day where pay-outs exceeded collections is valid).
5. **Close (submit)** snapshots `total_collected`, `pending_balance`, `expense_total`,
   `net_balance`, `folio_count`, `submitted_at`, and sets `status = 'submitted'`. A day with
   no activity may be closed (a zero closure). Closing a non-`open` drawer → `409 CONFLICT`.
   After close, the summary read returns the snapshot.
6. **Admin review** (US-A19) sets `status` `submitted → approved | rejected`, with
   `reviewed_by` (admin from context), `reviewed_at`, and an optional `review_note`.
   Reviewing a non-`submitted` drawer (still `open`, or already reviewed) → `409 CONFLICT`.
   Approved/rejected are **terminal** in the MVP (re-opening a rejected closure is deferred).
7. **Multitenancy & ownership.** Every query filters `organization_id` from context (Rules
   2 & 4). `/me/*` is additionally scoped to `agent_id = caller`; the admin surface spans
   all agents **in the caller's org only**. `organization_id`/`agent_id`/`status`/totals are
   **never** read from a body (Rules 1 & 3).
8. **No new `ErrorCode`.** Conflicts reuse `409 CONFLICT`; unknown/cross-org ids reuse
   `404 NOT_FOUND`; bad bodies reuse `400 VALIDATION_ERROR`.

---

## Endpoints

All endpoints **auth-required**. A suspended caller is stopped by `authMiddleware`
(`403 ACCOUNT_SUSPENDED`). Cross-org / unknown ids → `404 NOT_FOUND` (no existence leak).

### `GET /api/cash-drawers/me?date=YYYY-MM-DD` — agent daily summary (US-AG12)

`date` optional (defaults to the server UTC date). Returns the caller's drawer for that
day with a **live** summary when `open`, or the **snapshot** when submitted/reviewed.

#### 200 OK
```json
{
  "drawer": {
    "id": "cd_abc",
    "business_date": "2026-06-04",
    "status": "open",
    "income": { "folio_count": 7, "total_collected": 845000, "pending_balance": 0 },
    "expense_total": 32000,
    "net_balance": 813000,
    "expenses": [
      { "id": "ex_1", "description": "Gasoline", "amount": 32000, "created_at": 1750000000 }
    ],
    "submitted_at": null,
    "reviewed_at": null,
    "review_note": null
  }
}
```
`id` is `null` and `expenses` is `[]` when no drawer row exists yet.

### `POST /api/cash-drawers/me/expenses` — register an expense (US-AG13)

```json
{ "description": "Gasoline", "amount": 32000, "date": "2026-06-04" }
```
`date` optional (defaults today). Lazily creates the `open` drawer if needed; `409` if the
drawer for that date is already closed. → `201 { "expense": { … } }`.

### `DELETE /api/cash-drawers/me/expenses/:id` — remove an expense (US-AG13)

Deletes one of the caller's expenses **while its drawer is open**. → `200 { "ok": true }`.
`404` if not the caller's expense; `409` if the drawer is already closed.

### `POST /api/cash-drawers/me/close` — submit the closure (US-AG14)

```json
{ "date": "2026-06-04" }
```
Snapshots and sets `status = 'submitted'`. → `200 { "drawer": { …snapshot… } }`. `409` if
already submitted/reviewed.

### `GET /api/cash-drawers?status=&date=&agent_id=` — admin review list (US-A19)

Closures in the caller's org, newest first; optional filters. Defaults to all statuses;
admins typically filter `status=submitted`. → `200 { "drawers": [ {id, agent:{id,name},
business_date, status, total_collected, expense_total, net_balance, folio_count,
submitted_at, reviewed_at} ] }`. `open` drawers with no snapshot are omitted by default.

### `GET /api/cash-drawers/:id` — admin closure detail (US-A19)

One closure in the caller's org with its expense breakdown and income snapshot. → `200
{ "drawer": { …, agent, expenses[] } }`. `404` cross-org/unknown.

### `POST /api/cash-drawers/:id/review` — validate (US-A19)

```json
{ "decision": "approved", "note": "Matches deposit." }
```
`decision ∈ {approved, rejected}`; `note` optional. → `200 { "drawer": { …, status, reviewed_by, reviewed_at, review_note } }`. `409` if not `submitted`.

---

## Error responses

| Status | Code | Condition |
|---|---|---|
| 400 | `VALIDATION_ERROR` | `amount <= 0` / non-integer, empty `description`, bad `date`, `decision` not in enum |
| 401 | `UNAUTHORIZED` | No / unrefreshable session |
| 403 | `FORBIDDEN` | Wrong role (agent → admin route, or admin → `/me/*`) |
| 403 | `ACCOUNT_SUSPENDED` | Caller's account suspended (from `authMiddleware`) |
| 404 | `NOT_FOUND` | Drawer/expense unknown, not owned by caller, or in another org |
| 409 | `CONFLICT` | Expense add/delete on a closed drawer; close of a non-open drawer; review of a non-submitted drawer |

---

## Scenarios

### US-AG12 — Daily sales summary

#### Scenario 1 — Live summary aggregates the day's folios and expenses
**Given** an `agent` of `org_a` with three non-cancelled folios created today
(`amount_paid` 300000, 400000, 145000) and one expense (`Gasoline`, 32000)
**When** `GET /api/cash-drawers/me?date=<today>`
**Then** Status `200`; `status = "open"`; `income.folio_count = 3`;
`income.total_collected = 845000`; `income.pending_balance = 0`; `expense_total = 32000`;
`net_balance = 813000`.

#### Scenario 2 — A day with no activity returns a virtual open drawer
**Given** an `agent` with no folios and no expenses today
**When** `GET /api/cash-drawers/me`
**Then** Status `200`; `id = null`; `status = "open"`; all income fields `0`;
`expenses = []`; `net_balance = 0`. No `cash_drawers` row is created.

#### Scenario 3 — Cancelled folios are excluded from collected cash
**Given** two folios today, one `paid` (200000) and one `cancelled` (150000)
**When** `GET /api/cash-drawers/me`
**Then** `folio_count = 1`; `total_collected = 200000` (the cancelled folio is excluded).

### US-AG13 — Operating expenses

#### Scenario 4 — Register an expense lazily creates the open drawer
**Given** an `agent` of `org_a` with no drawer row yet today
**When** `POST /api/cash-drawers/me/expenses` `{ "description": "Gasoline", "amount": 32000 }`
**Then** Status `201`; an `open` `cash_drawers` row now exists for `(org_a, agent, today)`;
one `cash_drawer_expenses` row links to it; a subsequent `GET /me` shows
`expense_total = 32000`.

#### Scenario 5 — Invalid expense → 400
**When** `POST …/me/expenses` with `amount = 0`, a negative/non-integer `amount`, or an
empty `description`
**Then** Status `400 VALIDATION_ERROR`; nothing is written.

#### Scenario 6 — Expense on a closed drawer → 409
**Given** today's drawer is already `submitted`
**When** `POST …/me/expenses`
**Then** Status `409 CONFLICT`; no expense is added.

#### Scenario 7 — Delete an expense while open
**Given** the agent registered an expense today (drawer `open`)
**When** `DELETE …/me/expenses/:id`
**Then** Status `200`; the expense is removed; `net_balance` recomputes. Deleting another
agent's / unknown expense → `404`; deleting after the drawer is closed → `409`.

### US-AG14 — Submit the daily closure

#### Scenario 8 — Close snapshots the totals and locks the day
**Given** an `agent` with `total_collected = 845000` (derived) and `expense_total = 32000`
today, drawer `open`
**When** `POST /api/cash-drawers/me/close`
**Then** Status `200`; `status = "submitted"`; the row's `total_collected`,
`pending_balance`, `expense_total = 32000`, `net_balance = 813000`, `folio_count`, and
`submitted_at` are persisted; a later `GET /me` returns these **snapshot** values even if a
new folio is created afterward.

#### Scenario 9 — Closing twice → 409
**Given** today's drawer is already `submitted`
**When** `POST /api/cash-drawers/me/close`
**Then** Status `409 CONFLICT`; the existing snapshot is unchanged.

#### Scenario 10 — A zero-activity day may be closed
**Given** an `agent` with no folios and no expenses today
**When** `POST /api/cash-drawers/me/close`
**Then** Status `200`; a `submitted` drawer with all totals `0` is created (a valid zero
closure).

### US-A19 — Admin reviews & validates

#### Scenario 11 — Admin lists submitted closures in their org
**Given** agents of `org_a` have submitted closures, and an `org_b` agent has one too
**When** the `org_a` **admin** `GET /api/cash-drawers?status=submitted`
**Then** Status `200`; only `org_a` submitted closures appear, each with its agent and
totals; `org_b`'s closure is absent; `open` drawers are omitted.

#### Scenario 12 — Admin views a closure detail
**Given** a submitted closure of `org_a`
**When** the `org_a` admin `GET /api/cash-drawers/:id`
**Then** Status `200`; the snapshot totals + the expense breakdown + the agent are returned.

#### Scenario 13 — Admin approves a closure
**Given** a `submitted` closure
**When** `POST /api/cash-drawers/:id/review` `{ "decision": "approved" }`
**Then** Status `200`; `status = "approved"`; `reviewed_by = admin`, `reviewed_at` set.

#### Scenario 14 — Admin rejects with a note
**When** `POST …/review` `{ "decision": "rejected", "note": "Cash short by 200." }`
**Then** Status `200`; `status = "rejected"`; `review_note` stored.

#### Scenario 15 — Reviewing a non-submitted or already-reviewed closure → 409
**When** the admin reviews an `open` drawer, or one already `approved`/`rejected`
**Then** Status `409 CONFLICT`; status unchanged.

### Roles

#### Scenario 16 — Wrong role → 403
**Given** an `agent` calling an admin route (`GET /api/cash-drawers`,
`POST …/:id/review`), **or** an `admin` calling a `/me/*` route
**Then** Status `403 FORBIDDEN`.

### Multitenancy isolation (required — `seedTwoOrgs`)

#### Scenario 17 — B3/B4: cross-org drawers are invisible and unreachable
**Given** closures exist in both `org_a` and `org_b`
**When** the `org_a` admin lists/reads/reviews, and an `org_a` agent reads `/me`
**Then** only `org_a` rows ever appear; reading/reviewing an `org_b` drawer by id →
`404 NOT_FOUND`; an agent never sees another agent's drawer.

#### Scenario 18 — B1: injected org/agent/totals are ignored
**Given** an `org_a` agent registers an expense / closes with a body that also includes
`"organizationId": "org_b"`, `"agent_id": "other"`, or a forged `total_collected`/`net_balance`
**When** the request is processed
**Then** those fields are stripped/ignored; the row's `organization_id = org_a`,
`agent_id = caller`, and every total is the server's computed value.

---

## Definition of Done

- [ ] Migrations `0015_create_cash_drawers.sql` + `0016_create_cash_drawer_expenses.sql`
      create both tables with `organization_id` (Rule 5), the `(org, agent, business_date)`
      unique index, and org-leading indexes (Rule 6)
- [ ] Drizzle schema: `cashDrawers` + `cashDrawerExpenses` tables and inferred types
- [ ] New `src/routes/cash-drawers/` (`index.ts`, `handler.ts`, `schema.ts`) mounted at
      `/api/cash-drawers` with `authMiddleware` on `*` and per-route `requireRole`
      (`/me/*` agent, review surface admin); `/me/*` registered before `/:id`
- [ ] Income derived server-side from folios for `(org, agent, business_date)` excluding
      `cancelled`; client never sends totals; expenses validated (`amount > 0`, non-empty
      `description`)
- [ ] Expenses add/delete only while `open` (else `409`); `close` snapshots totals + sets
      `submitted`; closing a non-open drawer → `409`; reads of a submitted drawer return the
      snapshot
- [ ] Admin review scoped to org, sets `approved`/`rejected` + `reviewed_by`/`reviewed_at`/
      `review_note`; non-submitted/already-reviewed → `409`
- [ ] All reads/writes filter `organization_id`; `/me/*` filter `agent_id = self`; org/
      agent/status/totals never from the body (Rules 1 & 3); **no new `ErrorCode`**
- [ ] Scenarios 1–16 covered by `test/cash-drawer/cash-drawer.test.ts`
- [ ] Multitenancy Scenarios 17–18 (B1/B3/B4) covered using `seedTwoOrgs`
- [ ] Frontend: `cashDrawerService`, `features/cash-drawer/` (types/hooks), an agent
      **Cash drawer** page (live summary + expense add/delete + Close day), and an admin
      **review** surface (list + detail + approve/reject); agent-only **Caja / Cash** nav
      destination
- [ ] `pnpm --filter api-guideme test` green; `pnpm build:app` clean
- [ ] `docs/SPEC.md` MUST-HAVE item **Agent's daily cash drawer with operating expenses
      (US-AG12, US-AG13, US-AG14, US-A19)** ticked
