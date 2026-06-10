# Feature: Agent Continuous Cash Balance with Cash Drops

## Context

A field sales agent collects cash all day across many sales. The number that actually
matters operationally is **"how much company cash is this agent holding right now?"** —
not a paper reconciliation pinned to a calendar day. This feature replaces the daily cash
closure (*corte de caja*) with a **perpetual running balance** that rises with every
collected sale and falls with every operating expense and every **cash drop** (a physical
hand-in of cash to the admin). Settlement happens **whenever cash moves**, not on a clock.

```
running_balance(agent) = Σ cash_collected − Σ commissions_earned − Σ expenses − Σ confirmed_cash_drops + Σ confirmed_payouts
```

Like POS totals and the old closure income, the balance is **server-derived from events**,
never hand-entered — there is no mutable balance column to drift. A **cash drop** is the
settlement event: the agent registers "I'm handing you $X"; the admin **confirms receipt**
(which reduces the agent's balance) or **rejects** it (with a note). The admin's operational
view is the list of **outstanding balances** per agent (the company's cash exposure) and the
queue of **pending drops** to confirm.

**Shift-scoped breakdown (the agent's daily view, US-AG12).** The headline `balance` the
agent sees is always the **full perpetual figure above** — the exact physical cash they are
holding right now. But the *breakdown* that explains it (cash collected, commissions,
expenses) is scoped to the **current shift**: only the events **since the agent's last
confirmed cash drop**. Whatever balance the previous drop left behind (if it didn't bring the
agent to zero) appears as a single **carry-forward** line, so the agent reads:

```
balance = carry_forward + collected_since − commissions_since − expenses_since (+ payouts_since)
```

The carry-forward absorbs all prior history into one number, keeping the daily view focused on
the shift in progress without ever changing the true balance. With **no confirmed drop yet**,
`carry_forward = 0` and "the shift" is simply the agent's whole history.

**User Stories:** US-AG12 (see my running balance), US-AG13 (register operating expenses),
US-AG14 (register a cash drop / hand-in), US-AG23 (auto-deduct commissions), US-AG24 (card sales credit), US-AG25 (payment methods), US-A19 (admin confirms cash drops), US-A25 (payouts for negative balances), US-A26 (clawbacks on cancellation).

> **This feature REPLACES the daily cash-closure model.** It supersedes and removes
> `docs/cash-drawer/cash-drawer.spec.md` (now deprecated): the `cash_drawers` /
> `cash_drawer_expenses` tables, the `/api/cash-drawers` router, its tests, and the agent
> **Caja** + admin **Closures** UI. The migration assumes **no production cash-drawer data
> to preserve** (the daily-closure feature shipped immediately before this pivot).

**Builds on:**
- **POS / folios** (`docs/pos/pos-controlled-discount.spec.md`) — `folios.agent_id`,
  `status` (`paid`/`booking`/`cancelled`), `total`, `amount_paid` are the **collected**
  source. Bookings contribute their partial `amount_paid` and grow it as the balance later
  rises (the continuous model handles partial collection naturally — no day boundary to
  split it across).
- **Total folio cancellation** (`docs/cancellation/total-folio-cancellation.spec.md`) — a
  cancelled folio is excluded from `collected`; depending on the admin's choice (US-A26), it can either trigger a commission clawback or be absorbed by the company.
- **Commissions** (US-A12) — are now an integral part of the derivation, auto-deducted from the cash the agent owes.
- **Auth & roles** — `authMiddleware`, `requireRole`, the multitenancy Enforcement Contract
  (`docs/multitenancy/multitenancy.spec.md`).
- **Reused review pattern** — the drop `pending → confirmed | rejected` machine mirrors the
  closure `submitted → approved | rejected` machine being retired (same `reviewed_by` /
  `reviewed_at` / `review_note` shape, the admin UI is recognizably similar).

### Scope boundary with adjacent features (read carefully)

| Concern | Owner |
|---|---|
| Perpetual **running balance** (derived), **operating expenses**, **cash drops** (hand-ins), **payouts** (admin-to-agent), **commissions auto-deduction** | **This feature** |
| **Daily cash closure** (*corte de caja*), `cash_drawers`, the close/submit + day snapshot | **Removed** — deprecated by this pivot |
| **Commission definition** (base % + bonus) | *Commissions* (US-A12) — MUST HAVE, provides the rates for this feature to derive the amount |
| **Period sales reports** (daily/weekly per agent) | *Occupancy dashboard* (US-A14–A16, SHOULD HAVE) — a read-only **query** over folios+drops; the "day" becomes a reporting lens, not a workflow state |
| **Refunds** of cancelled folios (US-A23) | *Cancellation/refund* — separate money flow; a refund is not a cash drop |
| Adjusting a drop's amount on confirm / opening float / multi-currency | **Deferred** (see Business Rules & TECH_DEBT) |

**New endpoints:** a new `src/routes/cash/` router mounted at `/api/cash`, `authMiddleware`
on `*` and **per-route** `requireRole` (agent for `/me/*`, admin for the balances/drops
review surface). `/me/*` registered **before** any `/:id`-style route.

| Method & path | Role | Purpose | US |
|---|---|---|---|
| `GET  /api/cash/me` | agent | My running balance + breakdown + expenses + my recent drops | AG12 |
| `POST /api/cash/me/expenses` | agent | Register an operating expense | AG13 |
| `DELETE /api/cash/me/expenses/:id` | agent | Remove an expense | AG13 |
| `POST /api/cash/me/drops` | agent | Register a cash drop (hand-in), `pending` | AG14 |
| `DELETE /api/cash/me/drops/:id` | agent | Cancel a still-`pending` drop | AG14 |
| `GET  /api/cash/balances` | admin | Each agent's outstanding balance + pending-drops rollup | A19 |
| `GET  /api/cash/drops?status=&agent_id=` | admin | List drops to review (default `pending`) | A19 |
| `GET  /api/cash/drops/:id` | admin | One drop's detail | A19 |
| `POST /api/cash/drops/:id/review` | admin | Confirm receipt or reject a `pending` drop | A19 |
| `POST /api/cash/payouts` | admin | Register a company-to-agent payment to clear negative balance | A25 |

---

## Data Model

The daily-closure tables are **dropped**. Two **new tenant-scoped tables** replace them.
Per Multitenancy Rule 5 each declares `organization_id TEXT NOT NULL REFERENCES
organizations(id)` and carries it directly for org-leading indexes (Rule 6).

### Money & derivation principles

- All money is **integer minor units** (centavos) — same as catalog/POS.
- **The balance is server-derived, never client-sent.** It is recomputed live from events
  on every read; there is no stored balance column (cannot drift).
- A **drop carries an audit snapshot** (`balance_before`) of the agent's running balance at
  the instant it was created — so the admin sees the agent's self-reported position next to
  the amount being handed in.
- Only a **confirmed** drop reduces the balance. A `pending` drop is cash physically handed
  over but **not yet acknowledged** by the admin — the agent is still liable for it, so it
  is shown separately (`pending_drops_total`), not netted out of the balance.
- **The balance value is all-time; only its breakdown is shift-scoped.** The agent's `GET /me`
  returns the same perpetual `balance` regardless of presentation. The breakdown components
  (`collected`, `commissions`, `expense_total`) count **only events since the anchor** — the
  agent's **most recent confirmed drop** (ordered by `created_at`). **`carry_forward`** is the
  balance the agent carried *into* the current shift — intuitively the residual the anchor drop
  left behind (≈ `balance_before − amount`), but computed as the **balancing term**
  `carry_forward = balance − (collected − commissions − expense_total + payouts_since)` so the
  displayed breakdown **always reconciles** to the authoritative all-time `balance`, even when a
  pre-anchor folio is cancelled later (that adjustment correctly lands in `carry_forward`, not
  the current shift). When there is no confirmed drop, the anchor is undefined,
  `carry_forward = 0`, and the breakdown spans the agent's full history.

### `agent_expenses` (new table) — operating expenses

| Column | Type | Notes |
|---|---|---|
| `id` | `text` PK | `crypto.randomUUID()` |
| `organization_id` | `text NOT NULL` → `organizations(id)` | Rule 5 |
| `agent_id` | `text NOT NULL` → `users(id)` | the owning agent |
| `description` | `text NOT NULL` | e.g. "Gasoline" (non-empty, trimmed) |
| `amount` | `integer NOT NULL` | minor units, `> 0` |
| `created_at` | `integer` timestamp | |

Index (Rule 6): `CREATE INDEX agent_expenses_org_agent_idx ON agent_expenses (organization_id, agent_id);`

### `cash_drops` (new table) — hand-in settlement events

| Column | Type | Notes |
|---|---|---|
| `id` | `text` PK | |
| `organization_id` | `text NOT NULL` → `organizations(id)` | Rule 5 |
| `agent_id` | `text NOT NULL` → `users(id)` | the agent handing in cash |
| `amount` | `integer NOT NULL` | minor units, `> 0` — reduces the balance once confirmed |
| `balance_before` | `integer NOT NULL` | **audit snapshot** of the running balance at creation (may be negative) |
| `status` | `text NOT NULL DEFAULT 'pending'` | enum `['pending','confirmed','rejected']` |
| `note` | `text` (nullable) | optional agent note ("end of Saturday route") |
| `reviewed_by` | `text` → `users(id)` (nullable) | admin who confirmed/rejected |
| `reviewed_at` | `integer` timestamp (nullable) | set on review |
| `review_note` | `text` (nullable) | admin note (esp. on reject) |
| `created_at` / `updated_at` | `integer` timestamp | |

Indexes (Rule 6):
```sql
CREATE INDEX cash_drops_org_status_idx ON cash_drops (organization_id, status); -- admin review queue
CREATE INDEX cash_drops_org_agent_idx  ON cash_drops (organization_id, agent_id); -- per-agent history + balance
```

> Migrations: `0018_drop_cash_drawers.sql` (DROP `cash_drawer_expenses` then `cash_drawers`),
> `0019_create_agent_expenses.sql`, `0020_create_cash_drops.sql`, `0021_create_payouts.sql` — matching the `0001`–`0017`
> style. Drop order respects the FK (expenses → drawers). Additionally, folios need a `payment_method` column and `commission_amount`.

---

## Business Rules (enforced server-side)

1. **Running balance is derived, never sent.**
   `balance = cash_collected − commissions − expenses − confirmed_drops + confirmed_payouts`, where
   `cash_collected = Σ folios.amount_paid` (only `payment_method='cash'` and `status != 'cancelled'`);
   `commissions = Σ folios.commission_amount` (for all payment methods, `status != 'cancelled'` or clawback=false);
   `expenses = Σ agent_expenses.amount`; `confirmed_drops = Σ cash_drops.amount`.
   All scoped to `(organization_id, agent_id)`, **all-time — no day boundary.** This is the
   authoritative `balance` value (the physical cash held); the shift-scoped breakdown in Rule 1a
   only re-expresses it, never changes it.
1a. **Shift-scoped breakdown (US-AG12).** The `GET /me` breakdown is scoped to the **anchor** —
   the agent's most recent **confirmed** drop by `created_at`:
   - `collected`, `commissions`, `expense_total` sum **only** folios/expenses created **after**
     `anchor.created_at` (full history when no anchor);
   - `carry_forward = balance − (collected − commissions − expense_total + payouts_since)` — the
     balance carried into the current shift (≈ the anchor's `balance_before − amount`), computed
     as the balancing term so the breakdown **always reconciles** to the authoritative `balance`
     of Rule 1; `0` when no confirmed drop exists;
   - `pending_drops_total` is unchanged (Σ of all `pending` drops, cross-shift).
   The invariant `balance == carry_forward + collected − commissions − expense_total
   (+ payouts_since)` holds by construction. *(Edge cases — bookings whose `amount_paid` grows
   across a confirmed drop, and out-of-order confirmation of multiple pending drops — fold into
   `carry_forward` rather than mis-stating the shift; finer attribution is a deferred refinement,
   see TECH_DEBT.)*
2. **The balance may be negative** — a cancellation after a confirmed drop, or an agent who
   handed in more than they held, is a valid, meaningful state (the company owes the agent /
   a reconciliation gap), shown plainly (accent/error color in UI).
3. **Pending vs. confirmed drops.** A `pending` drop does **not** change the balance; it is
   reported as `pending_drops_total`. Only when the admin **confirms** does the drop's
   `amount` enter `confirmed_drops` and reduce the balance. A `rejected` drop never affects
   the balance.
4. **Expenses:** `amount` integer `> 0`; `description` non-empty (trimmed). Add/delete
   allowed at any time (the live balance is always the truth; a deletion simply raises the
   balance and is visible). *(Freezing settled history is a deferred refinement — TECH_DEBT.)*
5. **Cash drop creation** (US-AG14): `amount` integer `> 0`. The server snapshots
   `balance_before` from the live derivation, sets `status = 'pending'`, `agent_id = caller`
   (from context). An agent may **cancel** (`DELETE`) a drop **only while `pending`**; a
   confirmed/rejected drop is terminal (→ `409 CONFLICT`).
6. **Admin review** (US-A19): `decision ∈ {confirmed, rejected}` sets `status`
   `pending → confirmed | rejected`, with `reviewed_by` (admin from context), `reviewed_at`,
   and optional `review_note`. Reviewing a non-`pending` drop → `409 CONFLICT`.
   `confirmed`/`rejected` are **terminal** in the MVP (no adjust-on-confirm; a wrong amount
   is rejected and the agent re-registers).
7. **Outstanding balances (admin):** the balances list derives each agent's live balance
   across the org (agents only), plus their `pending_drops_total` and pending count.
8. **Multitenancy & ownership.** Every query filters `organization_id` from context (Rules
   2 & 4). `/me/*` is additionally scoped to `agent_id = caller`; the admin surface spans
   all agents **in the caller's org only**. `organization_id` / `agent_id` / `status` /
   `balance_before` / amounts-already-confirmed are **never** read from a body (Rules 1 & 3).
9. **No new `ErrorCode`.** Conflicts reuse `409 CONFLICT`; unknown/cross-org ids reuse
   `404 NOT_FOUND`; bad bodies reuse `400 VALIDATION_ERROR`.

---

## Endpoints

All endpoints **auth-required**. A suspended caller is stopped by `authMiddleware`
(`403 ACCOUNT_SUSPENDED`). Wrong role → `403 FORBIDDEN`. Cross-org / unknown ids →
`404 NOT_FOUND` (no existence leak).

### `GET /api/cash/me` — agent running balance (US-AG12)

The headline `balance` is the agent's full perpetual figure (the physical cash held); the
breakdown (`carry_forward`, `collected`, `commissions`, `expense_total`) is scoped to the
**current shift** — everything since the agent's last confirmed drop. `last_drop` identifies
the anchor that defines the shift (omitted/`null` when no confirmed drop exists yet).

```json
{
  "balance": {
    "carry_forward": 13000,
    "collected": 845000,
    "commissions": 84500,
    "expense_total": 32000,
    "pending_drops_total": 0,
    "balance": 741500,
    "last_drop": {
      "id": "dr_1", "amount": 500000, "balance_before": 513000, "confirmed_at": 1750100000,
      "created_at": 1750090000
    },
    "expenses": [
      { "id": "ex_1", "description": "Gasoline", "amount": 32000, "created_at": 1750000000 }
    ],
    "drops": [
      { "id": "dr_1", "amount": 500000, "balance_before": 513000, "status": "confirmed",
        "note": null, "reviewed_at": 1750100000, "review_note": null, "created_at": 1750090000 }
    ]
  }
}
```
`balance = carry_forward + collected − commissions − expense_total (+ payouts_since)` and is
identical to the all-time perpetual derivation (Rule 1). `carry_forward` is the anchor drop's
`balance_before − amount` (here `513000 − 500000 = 13000` — the previous drop left 13000
behind, so it surfaces instead of resetting the view to zero). `collected`/`commissions`/
`expense_total` count only events since `last_drop.created_at`; `expenses` lists the
current-shift expenses; `drops` lists the agent's recent drops (all statuses) for context.
With no confirmed drop, `carry_forward = 0`, `last_drop = null`, and the breakdown spans the
agent's whole history.

### `POST /api/cash/me/expenses` — register an expense (US-AG13)

```json
{ "description": "Gasoline", "amount": 32000 }
```
→ `201 { "expense": { id, description, amount, created_at } }`. `400` if `amount <= 0` or
`description` empty.

### `DELETE /api/cash/me/expenses/:id` — remove an expense (US-AG13)

Deletes one of the caller's expenses. → `200 { "ok": true }`. `404` if not the caller's /
unknown / cross-org.

### `POST /api/cash/me/drops` — register a cash drop (US-AG14)

```json
{ "amount": 500000, "note": "End of Saturday route" }
```
Snapshots `balance_before`, creates a `pending` drop. → `201 { "drop": { … } }`. `400` if
`amount <= 0`.

### `DELETE /api/cash/me/drops/:id` — cancel a pending drop (US-AG14)

→ `200 { "ok": true }` while `pending`. `404` if not the caller's / unknown; `409` if the
drop is already `confirmed`/`rejected`.

### `GET /api/cash/balances` — admin outstanding balances (US-A19)

Each agent in the caller's org with their live balance and pending rollup, ordered by
balance desc (largest exposure first). The breakdown is **shift-scoped** — `cash_collected`,
`commission_total`, `expense_total` and `payouts_total` count only events since the agent's
last confirmed drop, with `carry_forward` folding in everything before it (mirroring the
agent's own `/me` view). `balance` stays the authoritative all-time figure (the physical cash
held); `last_drop` is the anchor (`null` when none). Per-row invariant:
`balance = carry_forward + cash_collected − commission_total − expense_total + payouts_total`. →
```json
{ "balances": [
  { "agent": { "id": "usr_1", "name": "Ana" },
    "carry_forward": 13000, "cash_collected": 845000, "commission_total": 84500,
    "expense_total": 32000, "payouts_total": 0, "balance": 741500,
    "last_drop": { "id": "drp_1", "amount": 500000, "balance_before": 513000,
                   "confirmed_at": 1700000000, "created_at": 1700000000 },
    "pending_drops_total": 0, "pending_drops_count": 0 }
] }
```

### `GET /api/cash/drops?status=&agent_id=` — admin drops queue (US-A19)

Drops in the caller's org, newest first; defaults to `status=pending`. →
`{ "drops": [ { id, agent:{id,name}, amount, balance_before, status, note, created_at,
reviewed_at } ] }`.

### `GET /api/cash/drops/:id` — admin drop detail (US-A19)

One drop in the caller's org + its agent. → `{ "drop": { … } }`. `404` cross-org/unknown.

### `POST /api/cash/drops/:id/review` — confirm or reject (US-A19)

```json
{ "decision": "confirmed", "note": "Counted, matches." }
```
`decision ∈ {confirmed, rejected}`; `note` optional. → `200 { "drop": { …, status,
reviewed_by, reviewed_at, review_note } }`. `409` if the drop is not `pending`.

---

## Error responses

| Status | Code | Condition |
|---|---|---|
| 400 | `VALIDATION_ERROR` | `amount <= 0` / non-integer, empty `description`, `decision` not in enum |
| 401 | `UNAUTHORIZED` | No / unrefreshable session |
| 403 | `FORBIDDEN` | Wrong role (agent → admin route, or admin → `/me/*`) |
| 403 | `ACCOUNT_SUSPENDED` | Caller's account suspended (from `authMiddleware`) |
| 404 | `NOT_FOUND` | Expense/drop unknown, not owned by caller, or in another org |
| 409 | `CONFLICT` | Cancel/review of a non-`pending` drop |

---

## Scenarios

### US-AG12 — Running balance (shift-scoped breakdown)

#### Scenario 1 — Breakdown is scoped to the current shift, with a carry-forward line
**Given** an `agent` of `org_a` whose most recent **confirmed** drop was registered with
`balance_before = 513000`, `amount = 500000` (the anchor — it left 13000 behind), **and since
that drop** has non-cancelled cash folios totalling `amount_paid = 845000`, commissions of
84500, and one expense (`Gasoline`, 32000)
**When** `GET /api/cash/me`
**Then** Status `200`; `carry_forward = 13000`; `collected = 845000`; `commissions = 84500`;
`expense_total = 32000`; `pending_drops_total = 0`; `balance = 741500`
(`13000 + 845000 − 84500 − 32000`); `last_drop` references the anchor.

#### Scenario 2 — No confirmed drop yet → carry-forward is zero, breakdown spans all history
**Given** a fresh `agent` with cash folios totalling 200000, commissions 20000, no confirmed
drop
**When** `GET /api/cash/me`
**Then** `carry_forward = 0`; `last_drop = null`; `collected = 200000`; `commissions = 20000`;
`balance = 180000` (the whole history is the current shift).

#### Scenario 3 — A pending drop does not change the balance
**Given** the Scenario 1 agent with an additional **pending** drop of 100000
**When** `GET /api/cash/me`
**Then** `pending_drops_total = 100000`; `balance = 741500` (unchanged); the breakdown lines
are unchanged (a pending drop is reported, not netted out and not a new anchor).

#### Scenario 4 — Cancelling a pre-anchor folio is absorbed by carry-forward; balance can go negative
**Given** an agent whose anchor drop had `balance_before = 200000`, `amount = 200000`
(carry-forward 0), whose only collection was a **pre-anchor** folio of 200000 that is then
**cancelled**, and no activity since the drop
**When** `GET /api/cash/me`
**Then** `collected = 0` (nothing this shift); `carry_forward = −200000` (the prior-shift
cancellation lands here, not in the current shift); `balance = −200000` — a valid
reconciliation signal that the company owes the agent — and the breakdown still reconciles.

### US-AG13 — Operating expenses

#### Scenario 5 — Register and delete an expense
**When** the agent `POST /api/cash/me/expenses { "description": "Gasoline", "amount": 32000 }`
**Then** `201`; a later `GET /me` shows `expense_total = 32000` and `balance` reduced by it.
**When** the agent `DELETE …/me/expenses/:id`
**Then** `200`; the expense is gone; `balance` rises back.

#### Scenario 6 — Invalid expense → 400
**When** `POST …/me/expenses` with `amount = 0`, negative/non-integer, or empty `description`
**Then** `400 VALIDATION_ERROR`; nothing written.

### US-AG14 — Cash drops

#### Scenario 7 — Register a drop snapshots the balance and is pending
**Given** an agent whose live balance is 813000
**When** `POST /api/cash/me/drops { "amount": 500000 }`
**Then** `201`; the drop has `status = "pending"`, `balance_before = 813000`,
`amount = 500000`; the balance is **still** 813000 (unconfirmed).

#### Scenario 8 — Cancel a pending drop
**Given** a `pending` drop
**When** the agent `DELETE …/me/drops/:id`
**Then** `200`; the drop is removed. A `confirmed`/`rejected` drop → `409`; another agent's
/ unknown drop → `404`.

#### Scenario 9 — Invalid drop → 400
**When** `POST …/me/drops` with `amount = 0` or negative/non-integer
**Then** `400 VALIDATION_ERROR`.

### US-A19 — Admin confirms receipt & sees exposure

#### Scenario 10 — Admin lists outstanding balances in their org
**Given** two `org_a` agents with positive balances and an `org_b` agent with one too
**When** the `org_a` admin `GET /api/cash/balances`
**Then** `200`; only `org_a` agents appear, each with a **shift-scoped** breakdown
(`carry_forward`/`cash_collected`/`commission_total`/`expense_total`/`payouts_total`) plus the
all-time `balance` and pending rollup, mirroring that agent's `/me` view; ordered by `balance`
desc; `org_b` absent. Agents at different shift states do not bleed into one another (each is
scoped to its own confirmed-drop anchor).

#### Scenario 11 — Admin lists and reads the pending drops queue
**Given** pending drops in `org_a`
**When** the admin `GET /api/cash/drops` (defaults to `pending`) and `GET /api/cash/drops/:id`
**Then** `200`; each drop with its agent, `amount`, `balance_before`, `note`; detail returns
the full drop + agent.

#### Scenario 12 — Admin confirms a drop → balance drops, drop becomes the new anchor
**Given** an agent with `balance = 813000` and a `pending` drop of 500000 (`balance_before = 813000`)
**When** `POST /api/cash/drops/:id/review { "decision": "confirmed" }`
**Then** `200`; `status = "confirmed"`, `reviewed_by = admin`, `reviewed_at` set; the
agent's `GET /me` now anchors on this drop — `last_drop` is it, `carry_forward = 313000`
(`813000 − 500000`), the shift breakdown resets to zero, and `balance = 313000`.

#### Scenario 13 — Admin rejects a drop with a note → balance unchanged
**When** `POST …/review { "decision": "rejected", "note": "Short by 200." }`
**Then** `200`; `status = "rejected"`; `review_note` stored; the balance is **unchanged**
(a rejected drop never reduces it).

#### Scenario 14 — Reviewing a non-pending drop → 409
**When** the admin reviews a drop already `confirmed`/`rejected`
**Then** `409 CONFLICT`; status unchanged.

### Roles

#### Scenario 15 — Wrong role → 403
**Given** an `agent` calling an admin route (`GET /api/cash/balances`,
`GET/POST …/drops…`), **or** an `admin` calling a `/me/*` route
**Then** `403 FORBIDDEN`.

### Multitenancy isolation (required — `seedTwoOrgs`)

#### Scenario 16 — B3/B4: cross-org drops/balances invisible and unreachable
**Given** drops/expenses exist in both `org_a` and `org_b`
**When** the `org_a` admin lists balances/drops, reads/reviews a drop by id, and an `org_a`
agent reads `/me`
**Then** only `org_a` rows ever appear; reading/reviewing an `org_b` drop by id →
`404 NOT_FOUND`; an agent never sees another agent's data.

#### Scenario 17 — B1: injected org/agent/status/snapshot are ignored
**Given** an `org_a` agent registers an expense / a drop with a body that also includes
`"organizationId": "org_b"`, `"agent_id": "other"`, `"status": "confirmed"`, or a forged
`balance_before`
**When** the request is processed
**Then** those fields are stripped/ignored; the row's `organization_id = org_a`,
`agent_id = caller`, `status = 'pending'`, and `balance_before` is the **server-computed**
snapshot.

---

## Definition of Done

- [ ] Migrations `0018_drop_cash_drawers.sql` (drops `cash_drawer_expenses` then
      `cash_drawers`), `0019_create_agent_expenses.sql`, `0020_create_cash_drops.sql` with
      `organization_id` (Rule 5) and org-leading indexes (Rule 6)
- [ ] Drizzle schema: **remove** `cashDrawers` + `cashDrawerExpenses`; **add** `agentExpenses`
      + `cashDrops` tables and inferred types
- [ ] **Remove** the deprecated daily-closure feature: `src/routes/cash-drawers/`,
      `test/cash-drawer/`, the agent **Caja**/**Cash drawer** page, the admin
      **Closures** list/detail pages, their service/hooks/types, routes & nav entries
- [ ] New `src/routes/cash/` (`index.ts`, `handler.ts`, `schema.ts`) mounted at `/api/cash`
      with `authMiddleware` on `*` and per-route `requireRole` (`/me/*` agent, balances/drops
      admin); `/me/*` before any `/:id`
- [ ] Balance derived server-side (all-time `collected − commissions − expenses −
      confirmed_drops + payouts`); agent `GET /me` breakdown **shift-scoped** to the last
      confirmed drop with a reconciling `carry_forward` line and `last_drop` anchor (admin
      `/balances` stays all-time exposure); pending drops reported, not netted; balance may be
      negative; client never sends totals/`balance_before`
- [ ] Drop machine `pending → confirmed | rejected` (admin review, guarded); agent cancels
      only while `pending`; non-`pending` cancel/review → `409`
- [ ] All reads/writes filter `organization_id`; `/me/*` filter `agent_id = self`;
      org/agent/status/snapshot never from the body (Rules 1 & 3); **no new `ErrorCode`**
- [ ] Scenarios 1–15 covered by `test/cash/agent-balance-cash-drops.test.ts`
- [ ] Multitenancy Scenarios 16–17 (B1/B3/B4) covered using `seedTwoOrgs`
- [ ] Frontend: `cashService`, `features/cash/` (types/hooks), an agent **Balance** page
      (running balance + expense add/delete + register-drop), and an admin surface
      (**Balances** list + **Drops** review queue with confirm/reject); agent-only **Balance**
      + admin-only **Cash** nav destinations replacing the old Caja/Closures entries
- [ ] `pnpm --filter api-guideme test` green; `pnpm build:app` clean
- [ ] `docs/SPEC.md` MUST-HAVE item **Agent continuous cash balance with cash drops** ticked
- [ ] `docs/TECH_DEBT.md`: mark the daily cash-drawer feature **superseded**; note the
      deferred refinements (settled-history immutability, unbounded balance sum → snapshot
      carry, adjust-amount-on-confirm, and finer shift attribution — bookings whose
      `amount_paid` grows across a confirmed drop and out-of-order confirmation currently fold
      into `carry_forward`)
