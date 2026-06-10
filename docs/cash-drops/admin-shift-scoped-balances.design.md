# Design — Admin Dashboard Shift-Scoped Balances (US-A19 upgrade)

> **Spec:** `docs/cash-drops/agent-balance-cash-drops.spec.md` (US-A19)
> **Touches:** `routes/cash/handler.ts` (`listBalances`), `CashBalancesPage.tsx`,
> `features/cash/types.ts`, the balance test suite.
> **Builds on:** the `balance_after` settlement watermark and the canonical
> `deriveBalance` shipped in TECH_DEBT §12 (Phases 1–4).

## The change

The admin "Cash → Saldos" dashboard (`CashBalancesPage` ← `GET /api/cash/balances`)
currently shows **all-time** sums per agent — Collected, Commissions, Expenses, Dropped.
Those cumulative figures are operational noise: to reconcile a cash drop the admin needs
exactly the transactions that built the debt **during the agent's current shift** — i.e.
since their last confirmed drop — plus a carry-forward line for whatever the previous drop
left behind.

The outstanding **balance** headline (the physical company cash the agent is holding) does
**not** change — it stays the authoritative all-time figure. Only the *breakdown* becomes
shift-scoped.

## Core insight — it already exists

The shift-scoped breakdown the admin now wants is, line for line, what the **agent** already
sees on their own `BalancePage` via `getMyBalance` → **`deriveBalance`**:

```
balance = carry_forward + cash_collected − commission_total − expense_total + payouts_total
                          └──────────── all scoped to "since the last confirmed drop" ───────┘
```

`deriveBalance` is already the single canonical derivation, already accelerated by the
`balance_after` watermark to **O(shift)** (TECH_DEBT §12b), already handling the legacy
fallback, the settlement-timeline anchor (§12e) and post-watermark cancellation reversal
(§12a). The elegant move is therefore **not** to build a second shift-scoped aggregation —
it is to make the admin dashboard *mirror the agent's own view* by mapping each agent through
`deriveBalance`, and to retire the bespoke grouped all-time aggregation, which the new
requirement makes obsolete.

### Why this re-opens — and cleanly reverses — Phase 1 (§12d)

§12d replaced an O(history) per-agent `deriveBalance` loop with grouped `GROUP BY` aggregates.
The pathology it cured was **O(history) per iteration** (§12b), not the loop itself. The
watermark fixed §12b: every `deriveBalance` is now **O(shift)**. With the requirement now
demanding per-agent shift scoping — which a single grouped query fundamentally can't express
without a per-agent watermark join — the grouped aggregation has lost its purpose (all-time
totals are precisely what the screen must stop showing). We bring the per-agent derivation
back, but **bounded** (O(shift) each) and **parallelized** (`Promise.all`). Admin and agent
become one source of truth.

## Wire shape — `BalanceListItem`

| field | before | after |
|---|---|---|
| `agent` | ✓ | ✓ |
| `balance` | all-time (unchanged) | all-time (unchanged) |
| `cash_collected` | all-time | **shift-scoped** |
| `commission_total` | all-time | **shift-scoped** |
| `expense_total` | all-time | **shift-scoped** |
| `payouts_total` | all-time | **shift-scoped** |
| `carry_forward` | — | **NEW** — balance carried into the shift |
| `last_drop` | — | **NEW** — anchor, for the "since …" caption (`null` if none) |
| `confirmed_drops_total` | ✓ | **REMOVED** |
| `pending_drops_total` / `_count` | ✓ | ✓ (unchanged) |

`confirmed_drops_total` is dropped because in a shift scope it is **always 0** — the anchor
*is* the last confirmed drop, so no confirmed drop sits strictly after it; its value is now
folded into `carry_forward`. Per-row invariant, identical to the agent view:

```
balance = carry_forward + cash_collected − commission_total − expense_total + payouts_total
```

## Efficiency

`N` agents × **O(shift)** derivations, fired **concurrently** with `Promise.all`. At this
product's shape (one org = tens of agents, admin screen, cold path) that is well inside the
Workers subrequest budget and the D1 round-trip cost is dominated by the slowest single
derivation, not the sum.

**Escape hatch (documented, not built):** if an org ever grows to hundreds of agents,
collapse back to O(1) queries with *conditional aggregation over a per-agent watermark
window* — a `ROW_NUMBER() OVER (PARTITION BY agent_id ORDER BY reviewed_at DESC)` CTE for the
latest confirmed drop, then `SUM(CASE WHEN created_at > watermark THEN … END)` grouped sums
joined to it. The cost is duplicating derivation logic in SQL; the regression gate below is
what makes that safe to attempt later.

## Regression gate (repurposed)

Today Scenario 12a cross-checks the *grouped* `/balances` balance against the *watermark*
`/me` balance — an independent recompute. Once `/balances` **uses** `deriveBalance` that
cross-check is tautological. Repurpose it to guard the two things that can still break:

1. **Admin mirrors agent** — the dashboard row's full breakdown (`carry_forward`,
   `cash_collected`, `commission_total`, `expense_total`, `payouts_total`, `balance`) equals
   the agent's `/me` breakdown **field by field**.
2. **`deriveBalance` itself** — an independent all-time recompute (raw sums) still equals the
   row's `balance`.

## Plan

- **Phase 1 — Backend.** Rewrite `listBalances`: list org agents → `Promise.all` over
  `deriveBalance` → shape rows (carry_forward, shift terms, last_drop, balance, pending
  rollup) → sort by `balance` desc. Delete the six grouped aggregates + merge. No new helpers.
- **Phase 2 — Tests.** Rewrite Scenario 10b as shift-scoped (per-agent watermark + post-drop
  activity; assert breakdown is post-drop only and `carry_forward === balance_after`). Drop
  `confirmed_drops_total` assertions. Repurpose the Scenario 12a gate (field-by-field admin
  === agent + independent all-time recompute). Add a two-agents-at-different-watermarks
  scenario proving no cross-shift bleed.
- **Phase 3 — Frontend.** `types.ts`: add `carry_forward`/`last_drop`, remove
  `confirmed_drops_total`. `CashBalancesPage` `BalancesTab`: replace the all-time `Metric` row
  with a shift breakdown mirroring `BalancePage` — a carry-forward line (when ≠ 0),
  Cobrado / Comisión / Gastos (+ Pagado when > 0), captioned "desde la última entrega · {date}"
  or "Toda la actividad". Headline balance, pending badge and payout action unchanged.
- **Phase 4 — Docs.** Update US-A19 acceptance criteria in the spec to shift-scoped; note in
  TECH_DEBT §12d that the grouped aggregation was superseded by the shift-scoping requirement
  (canonical `deriveBalance` is now the single source of truth; O(1) escape hatch recorded).

## Definition of Done

- `/balances` returns a shift-scoped breakdown + carry-forward per agent; headline balance
  unchanged; admin row mirrors the agent's `/me` view exactly.
- Cross-org isolation preserved (still only the caller's org agents).
- Full suite green, `build:api` / `build:app` / `lint:app` clean.
