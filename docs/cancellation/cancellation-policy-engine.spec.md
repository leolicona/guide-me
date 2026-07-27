# Feature: Cancellation Policy Engine

## Context

Today a cancellation refund is decided **ad hoc**. There is no place for a company to state
"5 days out we refund everything, same-day we keep half, after departure we keep it all" —
so the two cancellation paths in the codebase answer the same question differently:

| Path | Tour folio | Stay folio |
|---|---|---|
| `cancelFolio` (`folios/handler.ts:493`) — admin cancels | `refund_status` stays `'none'` — **no refund is ever recorded** | 2-tier lodging policy from `organizations.lodging_free_cancel_days` / `lodging_cancel_penalty_pct` (`0039`) |
| `approveCancellationRequest` (`:681`) — admin approves a tourist request | `refund_amount = amount_paid` — **always a full refund** | same, full refund |

The same folio therefore refunds 0 or 100% depending on *who initiated* the cancellation.
That is the defect this feature fixes, and the configurability is the feature it ships.

This is a **minimal, data-gated** engine. Its governing constraint:

> **An organization with no policy configured runs exactly the code that runs today.**
> Every new code path is behind `if (policy)`. No existing org changes behaviour, no existing
> reconciliation scenario is rewritten, the ledger keeps reversing in full. The engine turns
> on only when an admin writes a ladder.

**User Stories:**
- **US-A69** — *As an admin, I want to configure a refund ladder for my company (how much is
  refunded at each distance from departure) so cancellations are priced by policy, not by
  whoever happens to process them.*
- **US-A70** — *As an admin, I want each tier to state what share of their commission the
  selling agent keeps, so a same-day cancellation doesn't silently punish (or reward) the agent.*
- **US-A71** — *As an admin, I want to mark a cancellation as **made by the company** so the
  customer is refunded in full and the agent keeps their commission, regardless of the ladder.*
- **US-A72** — *As an admin, I want an **affiliate**'s commission retention to be configurable
  separately from my in-house agents', because a reseller and my own staff are not the same
  relationship.*
- **US-A73** — *As an admin, I want to allow (or forbid) my agents to cancel their own sales, so a
  customer who changes their mind two minutes after paying doesn't have to wait for me.*
- **US-AG44** — *As an agent, I want to cancel a sale I made during my current shift and hand the
  money back on the spot, from the cash I am still carrying.*
- **US-A74** — *As an admin, I want expired bookings — which the system cancels on its own — to
  follow the same policy as every other cancellation, instead of a hidden hardcoded rule.*

**Builds on:**
- **Total folio cancellation** (`docs/cancellation/total-folio-cancellation.spec.md`) —
  `cancelFolio`, `applyCancellation`, `cancellation_clawback` (US-A26).
- **Tourist portal** (`docs/tourist-portal/tourist-self-service-portal.spec.md`) —
  `approveCancellationRequest`, the refund PIN, `confirmRefund` (audit-only).
- **Paid ledger** (`docs/paid-ledger/spec.md`) — `folio_payments`, `buildCancellationReversal`
  (`utils/folioPayments.ts:132`), decision **D6** (reversal is written at cancellation).
- **Organization timezone** (`docs/timezone/spec.md`) — `utils/tz.ts` (`naiveEpoch`, `orgToday`).
- **Bookings & down payments** (`docs/bookings/`) — `booking_min_down_payment_pct`, and the
  current rule that a booking deposit is non-refundable (US-AG07.4).
- **Service-based commission** (`docs/commissions/service-based-commission.spec.md`) —
  `folio_lines.commission_type` / `commission_value` snapshotted at sale.
- **Affiliate program** (`docs/affiliates/affiliate-setup-commissions.spec.md`) —
  `affiliate_commissions` sets a reseller's per-service rate, but the earned amount lands on the
  **same** `folios.commission_amount` an in-house agent's does. The ladder therefore reaches
  affiliates for free; US-A72 is about being able to treat them *differently*, not about
  reaching them.
- **Agent balance & cash drops** (`docs/cash-drops/agent-balance-cash-drops.spec.md`) — the
  `settlementWatermark` (the agent's most recent confirmed drop) is what bounds US-AG44.
- **Bookings auto-expiry** (`docs/bookings/`, US-AG07 P3) — `sweepExpiredBookings`
  (`routes/pos/sweep.ts`), run by the `*/15 * * * *` cron in `wrangler.jsonc`.

### Scope boundary

| Concern | Owner |
|---|---|
| A configurable per-org refund ladder, evaluated per line, snapshotted at sale | **This feature** |
| The single refund computation shared by **both** cancellation paths | **This feature** |
| Proportional ledger reversal when a policy retains money | **This feature** (contained change to `buildCancellationReversal`) |
| Per-tier agent-commission retention, split in-house vs affiliate | **This feature** |
| "Cancelled by the company" override (full refund, commission intact) | **This feature** |
| Who may cancel: the agent same-shift permission (US-A73 / US-AG44) | **This feature** |
| Auto-expired bookings routed through the same engine (US-A74) | **This feature** |
| Releasing seats / flipping status / the cancellation audit columns | *Total folio cancellation* — unchanged |
| Refund PIN, `confirmRefund`, the physical hand-back | *Tourist portal* — unchanged, still audit-only |
| Per-service or per-category policy override | **Deferred** (§ Deferred) |
| `refund_obligations` table, partial hand-backs, choosing the refund method | **Deferred** (§ Deferred) |
| Bulk-cancelling a whole slot (weather) | **Deferred** (§ Deferred) |
| Partial / per-line cancellation | **WON'T HAVE** (SPEC) — a cancellation is still total |

**One new endpoint.** The ladder rides the existing `PATCH /api/organizations/current`
(`updateOrganizationSchema`, `organizations/schema.ts:18`) and the admin cancellation endpoints
keep their paths and gain fields. US-AG44 adds `POST /api/pos/folios/:id/cancel` — **agent-scoped,
under `/api/pos`**, because `/api/folios/*` is admin-only by construction
(`foliosRouter.use('*', authMiddleware, requireRole('admin'))`) and that guard is a safety
property worth keeping intact rather than punching a hole through.

---

## Design decisions

| # | Decision | Why |
|---|---|---|
| **D1** | **Data gate, not a feature flag.** `organizations.cancellation_policy IS NULL` → the entire engine is bypassed and today's code runs verbatim. | The only credible way to ship this without rewriting the paid-ledger reconciliation suite. Rollback = `SET cancellation_policy = NULL`. |
| **D2** | **A JSON column on `organizations`, not a `cancellation_policies` table.** | Policy is org-level only for now. A column needs no CRUD routes — it slots into the settings PATCH that already exists — and the snapshot is a string copy. A table becomes worth it when per-service overrides land; migrating JSON → table later is additive. |
| **D3** | **The tier states what is REFUNDED; the engine works in RETENTION.** `retention = line_total × (100 − refund_pct)/100`, then `refund = max(0, amount_paid − Σ retention)`. | Retention-first makes deposits fall out for free: a 30% deposit against a 50% retention refunds 0 with no special rule, and the company never chases the customer for the shortfall. Refund-percent-of-paid would hand back most of a small deposit even though the seat was lost. |
| **D4** | **Evaluated per line, retentions summed.** Each line matches its own tier by its own departure. | A folio can hold tomorrow's tour and next week's. Anything else charges the far line the near line's penalty (or vice-versa). It is also the only reading consistent with `line_total` being the base. |
| **D5** | **Tiers are measured in HOURS of time-distance, in the org timezone.** | `0052` fixed exactly this bug for booking buffers: a slot that is calendar-tomorrow can be three hours away. Today `cancelFolio` computes days with `new Date().toISOString()` — UTC, date-only. Hours + `naiveEpoch` is the already-proven pattern. |
| **D6** | **The policy is snapshotted onto the folio at sale.** | The customer agreed to the ladder they were shown. Editing the policy must never re-price a sale already made. Mirrors `folio_lines.commission_value`, snapshotted for the same reason. |
| **D7** | **A redeemed line retains 100%, skipping the ladder.** | The service was delivered. Falls out naturally from D4. |
| **D8** | **The agent's kept commission is capped by what the company retained.** | Otherwise a full-refund tier that also lets the agent keep commission makes the company *lose* money on a cancellation — paying for a sale that was undone. |
| **D9** | **Paid-ledger D6 (reversal written at cancellation) is preserved.** | Moving the reversal to the physical hand-back is more accurate but reopens the drop-watermark premise of the cash engine. Deferred deliberately; see § Deferred. |
| **D10** | **The engine is binding; the only escape is "cancelled by the company" (US-A71).** | Keeps the ladder meaningful. The one real-world exception (weather, operator fault) is typed rather than left to a free-form amount field. |
| **D12** | **A tier carries two commission percentages: `agent_commission_pct` and `affiliate_commission_pct`.** Which one applies is decided by the seller's role, not by the folio. | An affiliate is a reseller, not staff — a company may well forgive its own agent a same-day cancellation while clawing back the reseller's cut. Both default to the same value in the settings UI, so a company that doesn't care never sees the distinction. Cheap now; expensive after policies exist in production with a one-percentage shape. |
| **D13** | **The agent's cancellation window is their current shift — everything up to their next confirmed cash drop.** Not a configurable number of hours. | The money is the boundary. While the cash is still in the agent's pocket, they can hand it back and their own balance absorbs it. Once the drop is confirmed the money is the company's and the balance is frozen (`balance_after` must never be rewritten — TECH_DEBT §12a). It needs no parameter, it can't be misconfigured, and it is *already* the line the cash engine draws. |
| **D14** | **The agent permission is a single org-level on/off switch, default OFF.** | US-A73 asks whether agents *may*, not which ones. Per-agent grants are a permissions system, and this feature is not that. Default OFF preserves today's admin-only behaviour under D1's guarantee. |
| **D15** | **The auto-expiry sweep calls the same engine.** | Today `sweepExpiredBookings` hardcodes "retain the deposit, write nothing to the ledger" — so an agent silently keeps full commission on a booking that never happened. Nobody decided that; it is what fell out. Routing the sweep through the engine makes it a stated policy. With no policy configured the outcome is byte-identical (deposit floor 100% → refund 0 → no rows). |

---

## Data Model

**No new tables.** Four additive columns.

### Migration `0053_cancellation_policy.sql`

```sql
-- Org-level cancellation refund ladder (US-A69/A70/A72). NULL = no policy configured, in which
-- case every cancellation path behaves exactly as it did before this migration (D1).
ALTER TABLE organizations ADD COLUMN cancellation_policy TEXT;

-- US-A73 (D14) — may an agent cancel their own current-shift sale? OFF preserves the admin-only
-- behaviour that has always been enforced by requireRole('admin') on the folios router.
ALTER TABLE organizations ADD COLUMN agent_cancellation_enabled INTEGER NOT NULL DEFAULT 0;

-- The ladder in force when the sale was confirmed (D6). NULL for folios sold before this feature
-- or sold while the org had no policy — those fall back to the org's live policy, which is also
-- NULL for them, so they take the legacy path.
ALTER TABLE folios ADD COLUMN cancellation_policy_snapshot TEXT;

-- Who cancelled, as a TYPE rather than a prose reason. Today the only way to tell a system expiry
-- from an admin action is `cancelled_by IS NULL` plus the Spanish string 'Apartado vencido' — not
-- something a report should have to parse. NULL for folios cancelled before this migration.
--   'admin' | 'agent' | 'tourist_request' | 'company' | 'system_expiry'
ALTER TABLE folios ADD COLUMN cancellation_source TEXT;
```

The `folios` columns are nullable and default-free — safe on a populated table, same shape as
`0013`'s `qr_token` and `0017`'s cancellation columns. `agent_cancellation_enabled` carries a
`0` default, matching how every other org toggle was added (`0028`, `0039`, `0052`).
**No backfill** — a NULL `cancellation_source` reads as "cancelled before this feature".

### The policy document

```json
{
  "version": 1,
  "tiers": [
    { "min_hours": 120,  "refund_pct": 100, "agent_commission_pct": 0,   "affiliate_commission_pct": 0   },
    { "min_hours": 0,    "refund_pct": 50,  "agent_commission_pct": 100, "affiliate_commission_pct": 50  },
    { "min_hours": null, "refund_pct": 0,   "agent_commission_pct": 100, "affiliate_commission_pct": 100 }
  ],
  "booking_deposit_retained_pct": 100
}
```

| Field | Meaning |
|---|---|
| `tiers[].min_hours` | Matches when the line's departure is **at least** this many hours away. `null` is the terminal catch-all (a departure already past). |
| `tiers[].refund_pct` | 0–100. Share of that **line's total** the customer is entitled to. Retention is the complement. |
| `tiers[].agent_commission_pct` | 0–100. Share of that **line's commission** an **in-house agent** keeps, before the D8 cap. `0` = full clawback. |
| `tiers[].affiliate_commission_pct` | 0–100, **optional — defaults to `agent_commission_pct`** when omitted (US-A72, D12). Same meaning for a sale made by an affiliate reseller. |
| `booking_deposit_retained_pct` | 0–100, default `100`. Floor applied to an unsettled `booking` folio. `100` reproduces today's "the deposit is never refunded" (US-AG07.4); `0` lets the deposit follow the ladder. |

The example above reads: *cancel with 5 days' notice and nobody earns anything; cancel same-day
and my own agent keeps their full commission while the reseller keeps half; a no-show pays
everyone in full, since the company kept 100%.*

**Which percentage applies** is decided by the **seller of the folio**, resolved once per folio,
not per line: a folio whose `agent_id` belongs to an affiliate company uses
`affiliate_commission_pct`; otherwise `agent_commission_pct`. Affiliate sales are already
distinguishable — an affiliate's commission rate comes from `affiliate_commissions`, and the
affiliate settlement (`affiliates/handler.ts:539`) already sums `folios.commission_amount` for
exactly this population.

**Validation** (Zod, in `organizations/schema.ts`):
- 1–10 tiers; each `refund_pct` / `agent_commission_pct` / `affiliate_commission_pct` an integer
  0–100.
- `min_hours` an integer ≥ 0, or `null`.
- **Exactly one** tier with `min_hours: null`, and it must sort last.
- `min_hours` values strictly descending and unique — no ambiguous or unreachable tier.
- The whole document is rejected as a unit; a malformed policy is never persisted, so a stored
  policy is always evaluable.
- A stored policy written **before** `affiliate_commission_pct` existed stays valid and behaves
  as it did — the field is optional and falls back (D12). Snapshots (D6) therefore never break.

---

## The computation

One **pure function**, `computeCancellationRefund` in `src/utils/cancellationPolicy.ts` — no
database, no clock of its own, fully unit-testable.

```
Inputs:  policy, lines[], amountPaid, folioStatus, nowEpoch, orgTimezone, sellerKind

# US-A72 / D12 — one lookup per folio, not per line.
commissionPctOf(tier) =
    sellerKind = 'affiliate'
      ? tier.affiliate_commission_pct ?? tier.agent_commission_pct
      : tier.agent_commission_pct

departureEpoch(line):
    lineType 'slot' → naiveEpoch(line.slot_date, line.slot_start_time, tz)
    lineType 'stay' → naiveEpoch(line.check_in, '00:00', tz)          # D11 below
    neither present → treated as already departed (terminal tier)

for each line:
    hoursOut   = (departureEpoch(line) − nowEpoch) / 3600
    tier       = first tier whose min_hours is not null and ≤ hoursOut,
                 else the terminal (min_hours: null) tier
    retention  = line.redeemed_count > 0                              # D7
                   ? line.line_total
                   : floor(line.line_total × (100 − tier.refund_pct) / 100)
    commission = line.commission_type = 'percent'
                   ? round(line.line_total × line.commission_value / 10000)
                   : line.commission_value × line.quantity
    kept       = min(floor(commission × commissionPctOf(tier) / 100), retention)       # D8 + D12

totalRetention  = Σ retention
totalCommission = Σ commission
keptCommission  = Σ kept

refund = max(0, amountPaid − totalRetention)                          # D3
if folioStatus = 'booking':                                           # deposit floor
    refund = min(refund, floor(amountPaid × (100 − booking_deposit_retained_pct) / 100))

Outputs: refund, totalRetention, keptCommission, reversedCommission = totalCommission − keptCommission,
         and a per-line breakdown (line id, hoursOut, tier matched, retention) for the UI and audit.
```

**D11 — a stay's departure is its check-in at 00:00 org-local.** Lodging has no configurable
check-in hour today, and midnight is the conservative reading: the whole check-in day counts as
"same day". If a check-in time setting ever lands, this is the single line that changes.

**Rounding** is `floor` on retention (favours the customer) and `round` on commission (matches
`pos/handler.ts:1226`, so a cancellation never disagrees with the sale about what was earned).
`refund + totalRetention = amountPaid` holds by construction whenever `totalRetention ≤ amountPaid`.

### Worked example (the ladder above)

Folio: line A = tour tomorrow 08:00 (20h out), `line_total` 600, commission 60 · line B = tour in
8 days, `line_total` 400, commission 40. Customer paid 1000 in cash. Cancelled now.

```
line A → tier min_hours 0   → refund 50%  → retention 300 · kept commission min(60, 300) = 60
line B → tier min_hours 120 → refund 100% → retention   0 · kept commission min(0,    0) =  0

totalRetention = 300      refund = max(0, 1000 − 300) = 700
keptCommission =  60      reversedCommission = 100 − 60 = 40
```

Ledger writes `refund −700 cash` and `commission_reversal −40 cash`. Net live: **+300 revenue,
+60 agent commission**. The company earned 240 on a cancelled sale, and it is visible.

---

## Business Rules (enforced server-side)

1. **The gate (D1).** `resolvePolicy(folio) = folio.cancellation_policy_snapshot ?? org.cancellation_policy`.
   If it resolves to `null`, **no rule below applies** — `cancelFolio` and
   `approveCancellationRequest` run their current code unchanged, including the lodging path of
   `0039` and the full ledger reversal.
2. **One computation, two callers.** When a policy resolves, both `cancelFolio` and
   `approveCancellationRequest` set `refund_amount` from `computeCancellationRefund`. The
   divergence documented in § Context ceases to exist.
3. **`refund_status`.** `refund > 0` → `'pending'`; `refund = 0` → `'none'` (nothing to hand back,
   so no refund PIN is minted and the confirm-refund flow never opens).
4. **The refund PIN follows the refund, not the path.** Today only the tourist path mints a PIN.
   With a policy, any cancellation with `refund > 0` mints one — a tourist owed money must be
   able to prove presence at hand-back regardless of who pressed cancel.
5. **Commission (US-A70).** `cancellation_clawback` is set to `reversedCommission > 0`, preserving
   the column's meaning for every existing reader. The *amount* reversed is `reversedCommission`,
   not the whole commission. A ladder using only `agent_commission_pct` ∈ {0, 100} produces
   exactly today's boolean behaviour.
6. **The `clawback` request field is ignored when a policy resolves.** The ladder is binding (D10).
   With no policy it keeps working as today. It is not removed from the schema — older clients and
   the existing tests keep passing.
7. **Company cancellation (US-A71).** `POST /api/folios/:id/cancel` accepts
   `cancelled_by_company: boolean` (default `false`). When true, the ladder is skipped:
   `refund = amount_paid`, `keptCommission = totalCommission`, `cancellation_clawback = false`.
   Recorded in `cancellation_reason` with a `[EMPRESA]` prefix so reports can separate a
   policy outcome from an operator-caused one.
8. **Proportional ledger reversal.** `buildCancellationReversal` takes an optional `refundAmount`.
   - **Omitted** (no policy) → today's behaviour: every positive method bucket reversed in full.
   - **Provided** → the reversal is prorated across the folio's positive method buckets in
     proportion to what each collected, with the largest bucket absorbing the rounding remainder
     so `Σ reversal = refundAmount` exactly.
   Commission reversal is prorated the same way against `reversedCommission`.
9. **Retention is revenue, and it stays attributed.** The un-reversed remainder keeps its
   `collected_by`, so the selling agent's balance still shows the money they are holding. This is
   the point of the whole change: with a full reversal the retained cash exists physically in an
   agent's pocket and in no report.
10. **The snapshot is written once, at sale.** `confirmSale` (`pos/handler.ts:831`) copies
    `organizations.cancellation_policy` verbatim into `folios.cancellation_policy_snapshot`. It is
    never rewritten — not on settle, not on edit.
11. **Timezone.** Every hour computation uses `naiveEpoch(date, time, org.timezone)` (`utils/tz.ts`).
    No `toISOString()`, no calendar-date subtraction.
12. **Multitenancy.** Unchanged: org-scoped everywhere, `organization_id` / `status` /
    `cancelled_by` never read from a body. `refund_amount` is **never** client-supplied — the only
    client input that can move money is `cancelled_by_company`, which is typed, admin-only and
    audited.
13. **`cancellation_source` is always set by the server**, from the route and the caller —
    never from a body. `admin` · `agent` (US-AG44) · `tourist_request` · `company` (US-A71) ·
    `system_expiry` (the sweep).
14. **No new `ErrorCode`.** `400 VALIDATION_ERROR` for a malformed policy document,
    `403 FORBIDDEN` for an agent cancelling outside their permission or window; everything else
    reuses the existing codes.

---

## Authorization — who may cancel

### Today

`/api/folios/*` is admin-only (`foliosRouter.use('*', authMiddleware, requireRole('admin'))`).
An agent has no cancellation path at all — a customer who changes their mind thirty seconds
after paying has to find an admin.

### US-A73 / US-AG44 — the agent's current shift

15. **Off by default (D14).** With `agent_cancellation_enabled = 0` — every existing org — the
    new endpoint returns `403 FORBIDDEN` for everyone. Nothing changes.
16. **The window is the shift, not a clock (D13).** An agent may cancel a folio only while
    **every one of its `folio_payments` rows is strictly after their `settlementWatermark`** (the
    instant of their most recent confirmed cash drop; `null` = they have never dropped, so
    everything qualifies). The money must still be in their hands.
    - This is deliberately stricter than "the folio was created this shift": a booking whose
      deposit was collected last week and settled today has a *pre-watermark* payment row, so the
      agent cannot cancel it. Part of that money is already the company's.
    - It also makes the reversal safe by construction. A confirmed drop freezes `balance_after`,
      which must never be rewritten (TECH_DEBT §12a); a cancellation confined to the current shift
      can never touch a frozen figure.
    - `settlementWatermark` is currently a private `const` in `cash/handler.ts:296`. It moves to
      `src/utils/cashWatermark.ts` unchanged and both call sites import it — a pure move, no
      behaviour change.
17. **Only their own sales.** `folios.agent_id = caller.userId`. An agent never sees, let alone
    cancels, another agent's folio.
18. **Nothing redeemed.** Any line with `redeemed_count > 0` → `403 FORBIDDEN`. A delivered
    service is an admin conversation, and it also keeps D7's 100%-retention rule out of the
    agent's hands.
19. **The agent executes the policy, they do not set it.** The ladder computes the refund exactly
    as it would for an admin. The agent **cannot** pass `cancelled_by_company` (US-A71 is
    admin-only — it is the escape from the policy, so it cannot belong to the person the policy
    constrains) and **cannot** pass `clawback`. Both are rejected, not ignored, so a mistaken
    client fails loudly.
20. **The agent hands the money back from their own drawer.** The refund reverses against their
    own balance (Rule 9 attribution), which is where the cash physically is. `refund_status` and
    the PIN follow Rules 3 & 4 unchanged.
21. **A cancelled folio is not re-cancellable and not re-openable.** Unchanged: `409 CONFLICT`.
    An agent who cancels by mistake needs an admin — there is no un-cancel in this system.

### US-A74 — the system's own cancellations

22. **The sweep runs the engine (D15).** `sweepExpiredBookings` (`routes/pos/sweep.ts`, cron
    `*/15 * * * *`) resolves the folio's policy exactly like any other caller and writes
    `cancellation_source = 'system_expiry'`, `cancelled_by = null` (unchanged — there is no user).
    - **No policy → byte-identical to today**: deposit retained, no ledger rows, agent keeps the
      commission.
    - **With a policy**, the tier matched is the one in force **at the moment of expiry**, and
      `booking_deposit_retained_pct` still floors the refund — so the default configuration also
      refunds 0. What changes is that the *commission* is now a stated decision instead of an
      accident: a company can make an expired booking pay no commission.
23. **The sweep must not become slow or unbounded.** It already loops folio-by-folio with a batch
    each. The engine adds one policy parse per folio and, when a commission is reversed, one more
    row in the same batch. No new query per folio: the policy comes from the snapshot the folio
    already carries.
24. **The sweep stays fail-soft.** It runs under `waitUntil` with a `.catch`. A folio whose policy
    fails to parse is **skipped and logged**, never left half-cancelled, and never aborts the
    sweep for the other folios.

---

## Endpoints

### `PATCH /api/organizations/current` — configure the ladder (US-A69, A70, A72, A73)

Existing endpoint, two new optional fields. `cancellation_policy: null` clears the policy and
returns the org to the legacy path (D1 — this is the rollback).

```json
{
  "cancellation_policy": {
    "version": 1,
    "tiers": [
      { "min_hours": 120,  "refund_pct": 100, "agent_commission_pct": 0,   "affiliate_commission_pct": 0   },
      { "min_hours": 0,    "refund_pct": 50,  "agent_commission_pct": 100, "affiliate_commission_pct": 50  },
      { "min_hours": null, "refund_pct": 0,   "agent_commission_pct": 100, "affiliate_commission_pct": 100 }
    ],
    "booking_deposit_retained_pct": 100
  },
  "agent_cancellation_enabled": true
}
```

### `GET /api/folios/:id` — folio detail

Gains a `cancellation_quote` block on a **cancellable** folio: what would happen if it were
cancelled right now. Pure read, computes nothing persistent — it is what the confirm sheet shows.

```json
{
  "cancellation_quote": {
    "refund": 700,
    "retention": 300,
    "kept_commission": 60,
    "reversed_commission": 40,
    "lines": [
      { "line_id": "fl_a", "hours_out": 20,  "refund_pct": 50,  "retention": 300 },
      { "line_id": "fl_b", "hours_out": 192, "refund_pct": 100, "retention": 0   }
    ]
  }
}
```

`null` when the folio has no policy, is already cancelled, or is not cancellable.

### `POST /api/folios/:id/cancel` — cancel (US-A21, US-A71)

```json
{ "reason": "El cliente no llegó", "cancelled_by_company": false }
```

`clawback` is still accepted and still honoured **only when no policy resolves** (Rule 6).
Sets `cancellation_source = 'admin'`, or `'company'` when `cancelled_by_company` is true.
Response adds the realised numbers alongside the existing folio payload:
`refund_amount`, `cancellation_retention`, `cancellation_kept_commission`.

### `POST /api/pos/folios/:id/cancel` — **NEW** — agent cancels their own shift sale (US-AG44)

Agent-scoped, mounted on the POS router alongside the existing agent receipt read
(`GET /api/pos/folios/:id`) so the admin-only guard on `/api/folios/*` stays intact.

```json
{ "reason": "El cliente cambió de opinión" }
```

`reason` optional. **No other field is accepted** — `cancelled_by_company`, `clawback` and
`refund_amount` are rejected with `400 VALIDATION_ERROR` rather than silently stripped (Rule 19),
so a client that thinks it can set them finds out immediately.

Sets `cancellation_source = 'agent'`, `cancelled_by = caller.userId`. Returns the same shape as
the admin cancel.

| Status | Condition |
|---|---|
| `403 FORBIDDEN` | `agent_cancellation_enabled = 0`, or the folio is not theirs, or a payment predates their watermark, or a line is redeemed |
| `404 NOT_FOUND` | Unknown or cross-org folio (checked before the ownership rules, so a 403 never confirms a folio exists elsewhere) |
| `409 CONFLICT` | Already cancelled |

### `GET /api/pos/folios/:id` — agent receipt read

Gains the same `cancellation_quote` block, plus `can_cancel: boolean` — so the POS can show or
hide the button without the agent discovering the answer by pressing it. `can_cancel` evaluates
Rules 15–18 and is the single source of truth for both the UI and the endpoint.

### `POST /api/folios/cancellation-requests/:requestId/approve` — approve a tourist request

Same computation, same response additions. Its `clawback` body field follows Rule 6.

---

## Error responses

| Status | Code | Condition |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Malformed policy: bad percentages, zero or multiple terminal tiers, non-descending `min_hours`, more than 10 tiers |
| 400 | `VALIDATION_ERROR` | Malformed cancel body (non-boolean `cancelled_by_company`) |
| 400 | `VALIDATION_ERROR` | An agent sent `cancelled_by_company`, `clawback` or `refund_amount` (Rule 19) |
| 403 | `FORBIDDEN` | Caller is not an admin (admin routes) |
| 403 | `FORBIDDEN` | Agent cancellation disabled for the org (US-A73) |
| 403 | `FORBIDDEN` | Agent cancelling a folio that is not theirs, or with a payment at/before their settlement watermark, or with a redeemed line |
| 404 | `NOT_FOUND` | Folio unknown or in another org |
| 409 | `CONFLICT` | Folio already cancelled |

---

## Scenarios

### US-A69 — the ladder

#### Scenario 1 — The example, end to end
**Given** an org with the ladder above and a **paid** tour folio of 1000 fully paid in cash, whose
single line departs in 6 days
**When** the admin cancels it
**Then** `refund_amount = 1000`, retention 0, and the ledger holds `refund −1000 cash` — a full
refund. Cancelling an identical folio departing **in 3 hours** yields `refund_amount = 500`,
retention 500, ledger `refund −500 cash`, and 500 remains live in the agent's balance. Cancelling
one whose departure was **yesterday** yields `refund_amount = 0`, `refund_status = 'none'`, and
**no** `refund` row at all.

#### Scenario 2 — Per-line evaluation (D4)
**Given** the two-line folio of the worked example (600 at 20h, 400 at 8 days), 1000 paid
**When** the admin cancels
**Then** `refund_amount = 700`, `cancellation_retention = 300`; the quote's `lines` array reports
tier 50% for line A and 100% for line B.

#### Scenario 3 — A redeemed line retains everything (D7)
**Given** a 2-day package, line A (500) already scanned (`redeemed_count = 1`), line B (500)
departing in 20 hours, 1000 paid, ladder as above
**When** the admin cancels
**Then** retention = 500 (line A, full) + 250 (line B, 50%) = 750; `refund_amount = 250`.

#### Scenario 4 — Deposit floor on a booking (US-AG07.4 preserved)
**Given** `booking_deposit_retained_pct = 100`, a `booking` folio of 1000 with a 300 deposit paid,
departing in 6 days (a 100%-refund tier)
**When** the admin cancels
**Then** `refund_amount = 0` — the deposit is retained, exactly as today.
**And** with `booking_deposit_retained_pct = 0` the same cancellation refunds 300.

#### Scenario 5 — Retention above what was collected never goes negative (D3)
**Given** a `paid` folio, total 1000, only 300 collected, cancelled same-day (50% retention = 500)
**When** the admin cancels
**Then** `refund_amount = 0` (not −200); retention is capped at 300 in the ledger — the customer
is not pursued for the shortfall.

#### Scenario 6 — Timezone and time-distance (D5)
**Given** an org in `America/Mexico_City` and a slot at 06:00 tomorrow local, cancelled at 23:00
today local — calendar-tomorrow, but 7 hours away
**When** the admin cancels
**Then** the **same-day** tier (`min_hours: 0`) matches, not the 120h tier. Asserted against the
current UTC-date implementation, which would match the wrong tier.

### US-A70 — commission

#### Scenario 7 — Per-tier commission retention
**Given** the worked-example folio (commission 60 + 40)
**When** it is cancelled
**Then** the agent keeps 60, the ledger holds `commission_reversal −40`, and
`cancellation_clawback = true` (something was reversed).
**And** with `agent_commission_pct: 100` on every tier nothing is reversed and
`cancellation_clawback = false`.

#### Scenario 8 — Kept commission is capped by retention (D8)
**Given** a tier with `refund_pct: 100` and `agent_commission_pct: 100`, a folio of 1000 fully
paid with commission 100
**When** it is cancelled
**Then** retention 0 → kept commission `min(100, 0) = 0`; the full commission is reversed. The
company refunds 1000 and pays 0 — it never ends a cancellation out of pocket.

### US-A71 — company cancellation

#### Scenario 9 — Weather cancellation overrides the ladder
**Given** a folio departing in 3 hours (50% tier) with 1000 paid and 100 commission
**When** the admin cancels with `{ "cancelled_by_company": true, "reason": "Mal clima" }`
**Then** `refund_amount = 1000`, retention 0, **no** commission reversal,
`cancellation_clawback = false`, and `cancellation_reason` starts with `[EMPRESA]`.

### The gate (D1) — regression guarantees

#### Scenario 10 — No policy → byte-identical behaviour
**Given** an org with `cancellation_policy = NULL`
**When** a tour folio is cancelled by the admin, and another via an approved tourist request
**Then** the outcomes match the pre-feature behaviour exactly: the admin path leaves
`refund_status = 'none'`, the tourist path sets `refund_amount = amount_paid` and mints a PIN, the
ledger reverses **every** bucket in full, and `clawback` from the body is honoured. *(The existing
`folio-cancellation.test.ts` and `agent-balance-cash-drops.test.ts` suites pass unmodified — this
is the acceptance criterion for the whole feature.)*

#### Scenario 11 — Clearing the policy is a rollback
**Given** an org that configured a ladder and cancelled a folio under it
**When** the admin PATCHes `cancellation_policy: null`
**Then** subsequent cancellations of folios **without** a snapshot take the legacy path; folios
**with** a snapshot keep being priced by their snapshot (D6) — a rollback never re-prices a sale
that was already made under a policy.

### Snapshot (D6)

#### Scenario 12 — Editing the policy does not re-price an existing sale
**Given** a folio sold under a 100%/50%/0% ladder
**When** the admin changes the org policy to 0% everywhere, then cancels that folio same-day
**Then** the refund is computed from the **snapshot** — 50%, not 0%.

#### Scenario 13 — A folio sold before this feature falls back to live
**Given** a folio with `cancellation_policy_snapshot = NULL` in an org that has since configured
a ladder
**When** it is cancelled
**Then** the org's **current** policy is applied (there is nothing else to apply), and this is
stated in the settings UI where the ladder is edited.

### Ledger (Rule 8)

#### Scenario 14 — Proportional reversal across methods
**Given** a folio paid 300 cash + 700 transfer, cancelled with `refund_amount = 500`
**When** the reversal is written
**Then** two rows: `refund −150 cash` and `refund −350 transfer`; `Σ reversal = −500` exactly, and
each method's live bucket stays non-negative.

#### Scenario 15 — Rounding remainder lands in the largest bucket
**Given** a folio paid 333 cash + 667 transfer, `refund_amount = 500`
**When** the reversal is written
**Then** the two rows sum to exactly −500 (no lost or invented unit), with the remainder absorbed
by the transfer bucket.

#### Scenario 16 — Retained money stays in the agent's balance
**Given** agent Ana holding a paid cash folio of 1000, cancelled with 300 retained
**When** `GET /api/cash/me`
**Then** Ana's `cash_collected` includes **300**, not 0 and not 1000 — she is still holding the
retained cash and the corte asks for it.

### US-A72 — affiliate commission split (D12)

#### Scenario 17 — The same tier pays an agent and a reseller differently
**Given** a tier `{ refund_pct: 50, agent_commission_pct: 100, affiliate_commission_pct: 50 }` and
two identical same-day folios of 1000 with commission 100 — one sold by an in-house agent, one by
an affiliate
**When** both are cancelled
**Then** the in-house agent keeps 100 (nothing reversed, `cancellation_clawback = false`); the
affiliate keeps 50 and `commission_reversal −50` is written. Both refunds are 500 — the split
touches commission only, never the customer's money.

#### Scenario 18 — Omitting the affiliate percentage falls back
**Given** a tier with `agent_commission_pct: 0` and **no** `affiliate_commission_pct`
**When** an affiliate's folio is cancelled under it
**Then** the affiliate is treated exactly like an in-house agent — 0% kept, full reversal. A
policy written before US-A72 keeps behaving as it did, including one already snapshotted onto a
folio (D6).

#### Scenario 19 — The D8 cap applies to affiliates too
**Given** a tier with `refund_pct: 100` and `affiliate_commission_pct: 100`
**When** an affiliate's folio is cancelled under it
**Then** retention 0 → the affiliate keeps 0. The cap is a property of the engine, not of the
seller's role.

### US-A73 / US-AG44 — agent cancels their own shift sale

#### Scenario 20 — Disabled by default
**Given** an org that has never touched the setting (`agent_cancellation_enabled = 0`)
**When** an agent calls `POST /api/pos/folios/:id/cancel` on their own folio, sold one minute ago
**Then** `403 FORBIDDEN`; nothing changes. **And** `GET /api/pos/folios/:id` reports
`can_cancel: false`.

#### Scenario 21 — Enabled: the agent cancels and hands the money back
**Given** `agent_cancellation_enabled = 1`, agent Ana with **no** confirmed drop yet, and her own
paid cash folio of 1000 departing in 6 days (100%-refund tier)
**When** Ana cancels it
**Then** `200`; `refund_amount = 1000`, `cancellation_source = 'agent'`,
`cancelled_by = <Ana's id>`; the seats are released; the ledger holds `refund −1000 cash` against
**Ana's** balance, so her `cash_collected` drops by 1000 — she handed the cash back.

#### Scenario 22 — The window closes at the confirmed drop (D13)
**Given** Ana sells a folio, then her cash drop is **confirmed**
**When** Ana cancels that folio
**Then** `403 FORBIDDEN` — its payment row is at/before her settlement watermark. The admin path
still works and behaves normally.

#### Scenario 23 — A settled booking is not the agent's to cancel
**Given** a booking whose **deposit** was collected last week (before Ana's last confirmed drop)
and whose **balance** Ana settled this shift
**When** Ana cancels it
**Then** `403 FORBIDDEN` — the rule is *every* payment row after the watermark, not the most
recent one. Part of that money already belongs to the company.

#### Scenario 24 — Not their folio, and redeemed lines
**Given** `agent_cancellation_enabled = 1`
**When** Ana cancels a folio sold by Beto, and separately her own folio with `redeemed_count = 1`
on a line
**Then** `403 FORBIDDEN` in both cases; nothing changes.

#### Scenario 25 — The agent cannot escape the policy
**Given** `agent_cancellation_enabled = 1` and a same-day folio (50% tier)
**When** Ana cancels with `{ "cancelled_by_company": true }` — or with `{ "clawback": false }`, or
`{ "refund_amount": 1000 }`
**Then** `400 VALIDATION_ERROR` in every case (Rule 19). Cancelling with only a `reason` succeeds
and refunds 500 — the ladder, not Ana.

#### Scenario 26 — A cross-org folio 404s before it 403s
**Given** `agent_cancellation_enabled = 1` in `org_a`
**When** the `org_a` agent cancels an `org_b` folio by id
**Then** `404 NOT_FOUND` — never `403`, which would confirm the folio exists somewhere.

### US-A74 — auto-expired bookings (D15)

#### Scenario 27 — No policy → the sweep behaves exactly as today
**Given** an org with `cancellation_policy = NULL` and a booking past `booking_expires_at` with a
300 deposit and 30 commission
**When** the cron sweep runs
**Then** the folio is `cancelled` with `cancelled_by = null`, reason *"Apartado vencido"*, the
seats and zones are released, **no** `folio_payments` rows are written, and the agent keeps the 30.
`cancellation_source = 'system_expiry'`.

#### Scenario 28 — With a policy, the deposit floor still holds
**Given** the same booking in an org with a ladder and `booking_deposit_retained_pct: 100`
**When** the sweep runs
**Then** `refund_amount = 0` and `refund_status = 'none'` — no refund row, no PIN. The customer is
owed nothing, exactly as before.

#### Scenario 29 — An expired booking can be made to pay no commission
**Given** the same booking, and the tier in force at expiry has `agent_commission_pct: 0`
**When** the sweep runs
**Then** `commission_reversal −30` is written and `cancellation_clawback = true` — the agent does
not earn on a booking that never happened. *(This is the behaviour change US-A74 exists to make
choosable; it requires an explicit policy.)*

#### Scenario 30 — A broken policy skips one folio, not the sweep
**Given** two expired bookings, one whose snapshot fails to parse
**When** the sweep runs
**Then** the healthy folio is cancelled normally, the broken one is left `booking` and logged, and
the sweep returns having processed the rest (Rule 24).

### Multitenancy (required — `seedTwoOrgs`)

#### Scenario 31 — B3/B4: policies do not leak across orgs
**Given** `org_a` with a ladder and `org_b` with none
**When** an `org_a` admin cancels an `org_b` folio by id
**Then** `404 NOT_FOUND`; the `org_b` folio is untouched.
**And** cancelling an `org_b` folio as an `org_b` admin uses **no** policy — `org_a`'s ladder is
never consulted.

#### Scenario 32 — B1: injected money fields are ignored
**Given** an `org_a` admin cancelling with a body containing
`{"refund_amount": 999999, "cancellation_retention": 0, "organizationId": "org_b"}`
**Then** the persisted `refund_amount` is the **computed** one and the org is unchanged — Zod
strips the unknown keys before the handler sees them.

---

## Definition of Done

- [ ] Migration `0053_cancellation_policy.sql` — `organizations.cancellation_policy` and
      `folios.cancellation_policy_snapshot`, both nullable, no backfill
- [ ] Drizzle schema updated; types infer
- [ ] `src/utils/cancellationPolicy.ts` — the policy Zod schema, `resolvePolicy`, and the pure
      `computeCancellationRefund`, with a dedicated unit-test file covering the algorithm
      (tier matching, redeemed lines, deposit floor, D3 clamp, D8 cap, rounding)
- [ ] `updateOrganizationSchema` accepts `cancellation_policy` (object or `null`, incl.
      `affiliate_commission_pct`) and `agent_cancellation_enabled`, with the full validation of
      § Data Model; `GET /api/organizations/current` returns both
- [ ] `confirmSale` (`pos/handler.ts:831`) writes the snapshot (Rule 10)
- [ ] `buildCancellationReversal` takes an optional `refundAmount` + `reversedCommission` and
      prorates; **omitting them reproduces the current full reversal byte for byte** (Rule 8)
- [ ] `cancelFolio` and `approveCancellationRequest` both call the engine behind the D1 gate;
      `cancelled_by_company` handled (US-A71); `refund_status` and the PIN follow Rules 3 & 4;
      `cancellation_source` set on every path (Rule 13)
- [ ] `settlementWatermark` moved from `cash/handler.ts:296` to `src/utils/cashWatermark.ts`
      unchanged, imported by both call sites (pure move — the cash suite must stay green)
- [ ] **NEW** `POST /api/pos/folios/:id/cancel` — agent-scoped, gated by
      `agent_cancellation_enabled`, enforcing Rules 15–21; strict body (Rule 19)
- [ ] `GET /api/folios/:id` and `GET /api/pos/folios/:id` return `cancellation_quote`;
      the POS read also returns `can_cancel`, computed from the same predicate the endpoint uses
- [ ] `sweepExpiredBookings` routed through the engine with `cancellation_source =
      'system_expiry'`, fail-soft per folio (Rules 22–24)
- [ ] Scenarios 1–32 covered by `test/folios/cancellation-policy.test.ts` (+ agent-permission and
      sweep cases), with the ledger assertions (14–16) alongside the paid-ledger suite
- [ ] **`folio-cancellation.test.ts`, `agent-balance-cash-drops.test.ts` and the bookings
      auto-expiry tests pass with no edits** (Scenarios 10 & 27 — the feature's central guarantee)
- [ ] Frontend: a **Política de cancelación** section in admin settings (ladder editor with a live
      preview — "cancelando ahora un folio de $1,000 → se devuelve $X" — the affiliate column
      collapsed behind a *"¿Los afiliados tienen otra regla?"* toggle so a company that doesn't
      care never sees it, and the **agent cancellation** switch); the computed refund shown in the
      cancel `ConfirmSheet` with its per-line breakdown and the `cancelled_by_company` toggle;
      a **Cancelar venta** action in the POS receipt, rendered only when `can_cancel`
- [ ] `pnpm --filter api-turistear test` green; `pnpm build:app` clean
- [ ] `docs/SPEC.md` updated with US-A69–A74 and US-AG44

---

## Deferred — and why each is safe to defer

| Deferred | Why it holds | What lands it later |
|---|---|---|
| **`refund_obligations` table** — the refund as a first-class obligation with its own lifecycle | The seven scalar columns of `0029` carry one refund per folio, which is all a single cancellation produces today | Needed the moment you want partial hand-backs, a later exception adjusting an already-computed refund, or a record of *which drawer* the money left |
| **Moving the ledger reversal to the physical hand-back** (reopening paid-ledger D6) | With proportional reversal the discrepancy shrinks to the refunded portion and lasts only until hand-back. It is a reporting inaccuracy, not lost money | Land it together with `refund_obligations`, since that table is what makes the pending amount visible |
| **Choosing the refund method at hand-back** | Proportional prorating is correct by default and never leaves a method bucket negative | A `method` field on `confirmRefund` — but only once the reversal is written at hand-back, otherwise the row exists before the choice does |
| **Per-service / per-category policy override** | The column is org-level; `resolvePolicy` is a single function and already the only place resolution happens | Add `services.cancellation_policy_id` and a resolution chain inside `resolvePolicy`. The snapshot (D6) already protects history through the change |
| **Bulk-cancelling a whole slot** (weather cancels a departure, not a folio) | US-A71 makes the per-folio outcome correct; the pain is repetition, not correctness | `POST /api/schedules/slots/:id/cancel` fanning out with `cancelled_by_company: true`. Note it collides with the "no partial cancellation" rule for multi-service folios |
| **Retiring `lodging_free_cancel_days` / `lodging_cancel_penalty_pct` (`0039`)** | They still drive stays for orgs without a ladder; an org that configures one supersedes them (Rule 1) | See § Known behaviour change |
| **Per-agent cancellation permission** (trusted agents may, new hires may not) | US-A73 asks *whether*, not *which* — and the shift window (D13) already bounds the blast radius to money the agent is physically holding | A real permissions layer. Do not grow it as a second boolean on `users`; it belongs with roles |
| **Un-cancelling / reopening a folio** | There is no un-cancel in this system today, for anyone (Rule 21) | Out of scope entirely — it would have to reverse the reversal *and* re-take the seats, which may be gone |
| **Notifying the customer that the system expired their booking** | The sweep sends nothing today either | The same email seam `cancelFolio` already leaves for US-C03 |

---

## Known behaviour change

For an org that **configures a ladder** while having lodging settings from `0039`, the stay path
of `cancelFolio:528` is superseded. The two are not equivalent:

```
today  refund = floor(stay_total × (100 − penalty_pct) / 100)      # no clamp to amount_paid
new    refund = max(0, amount_paid − retention)                    # clamped by construction
```

A stay sold with a 30% deposit and cancelled inside the penalty window can, **today**, produce a
`refund_amount` larger than the customer ever paid. The engine cannot. This is a fix, but it
changes numbers in production for any org that had those settings and then adopts a ladder — it
must be called out when the feature is rolled out, not discovered afterwards. Orgs that never
configure a ladder are untouched (D1).

---

## Pre-existing bug found while specifying this — fixed separately

**Manual cancellation did not release zoned seats.** `applyCancellation`
(`folios/handler.ts:378`) only decremented `slots.booked`, never `slot_zones.booked` and never
`reconcileSlotTotals` — while the three other release sites (`cancelBooking`, `rejectPayment`,
`sweepExpiredBookings`) all did both. Cancelling a zoned sale by hand left that zone's counter
inflated and its seats permanently unsellable.

Fixed **ahead of this feature**, on its own branch (`fix/cancellation-zone-release`), so the
inventory fix and this money-behaviour change land separately and can be rolled back
independently. Root cause, fix and coverage: **BUG-016** in `docs/BUGS.md`.

It was worth doing first for a plain reason: a policy engine makes cancelling routine, so a rare
bug becomes a frequent one. This spec assumes the fix is in — the seat-release behaviour it
describes is the post-BUG-016 behaviour.
