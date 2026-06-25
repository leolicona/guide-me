# Feature: Commission Report by Period — US-A17, US-A18, US-A20

> A read-only **date-range** report that answers the admin's reconciliation questions: *"For
> this period, what did each seller sell, what commission did they earn, and how much of my
> cash are they still holding?"* It is a **query lens over existing events** — folios, cash
> drops, and payouts — not a new money flow and not a new mutable balance. It is the period
> counterpart to the **shift-scoped** running balance the Caja shows day-to-day
> (`docs/cash-drops/agent-balance-cash-drops.spec.md`).

## Context

The original US-A17 was written against the **superseded** commission model (a per-agent base
percentage plus per-service bonus, producing a "total commission **to pay**"). Two shipped
pivots make that framing wrong:

1. **Service-based commission** (`docs/commissions/service-based-commission.spec.md`, US-A12 rev.) —
   commission belongs to the **service** (`commission_type` + `commission_value`), snapshotted on
   the folio at sale time (`folios.commission_amount`). There is no base % and no bonus to report.
2. **Net-remittance / cash drops** (`docs/cash-drops/agent-balance-cash-drops.spec.md`) — the
   seller **keeps their commission by deducting it from the cash they owe the company**. The
   company does not disburse commission as a separate line. A literal payout (US-A25) happens
   **only** when the balance is negative — i.e. the seller's commission on electronic sales
   exceeded the cash they collected, so the company owes *them*.

So a "commission report" under this model is a **commission & settlement report**: per seller,
over `[from, to]`, it lays out the same terms as the running-balance formula, summed over the
period instead of since the last drop.

```
sales_total      = Σ folio.total          (paid + booking, not cancelled, in range)
cash_collected   = Σ folio.amount_paid    (payment_method = 'cash')
electronic_total = Σ folio.amount_paid    (payment_method ≠ 'cash')
commission_earned = Σ folio.commission_amount
confirmed_drops  = Σ drop.amount          (status = 'confirmed', in range)
payouts          = Σ payout.amount        (in range)

net_owed = cash_collected − commission_earned − confirmed_drops + payouts
           └── > 0: seller still owes the company this cash
           └── < 0: the company owes the seller (settle with a payout, US-A25)
```

> **Note — this is a period lens, not the live balance.** The headline running balance
> (Caja, `GET /api/cash/balances`) is **perpetual** and shift-scoped. `net_owed` here is a
> *reporting* figure summed over the chosen window; it intentionally ignores the carry-forward
> and the "since last drop" anchor. The two are reconciled by definition (the perpetual balance
> = the all-time `net_owed`) but are **not** the same number for an arbitrary date range, and the
> UI must label this report's figure as period-scoped to avoid confusion. Expenses (US-AG13) are
> **out** of the commission report's `net_owed` (they belong to the live cash balance, not a
> commission/performance reconciliation); they may appear as a separate informational column but
> never alter `commission_earned`.

**User Stories:**
- **US-A17** — the per-seller commission & settlement report for a date range.
- **US-A18** — the cross-seller performance comparison for a period.
- **US-A20** — CSV/PDF export of the report.
- **US-A53** (affiliate-setup spec) — the **per-affiliate** settlement drill-down; reuses this
  read with `affiliate_company_id` as the filter. This report is its canonical engine.

## Scope boundary

| Concern | Owner |
|---|---|
| Period **commission & settlement report** per seller, cross-seller comparison, export | **This feature** |
| **Commission definition** (rate per service) | *Service-based commission* (US-A12) — provides `commission_amount` |
| **Live running balance**, drops confirmation, payouts, expenses | *Cash drops* (US-AG12/A19/A25) — provides the events this report sums |
| **Single-day** operational dashboard (today's sales, capacity, cash position) | *Daily Operations Dashboard* (US-A14–A16) — a **single-day** lens; this report is **date-range** |
| **Folio attribution** (`agent_id`, `affiliate_company_id`) | *POS* / *Affiliate setup* (US-A51) — stamped at sale; this report groups by it |
| Per-affiliate settlement view UI | *Affiliate setup* (US-A53) — same read, affiliate-scoped |

No new tables, columns, migrations, or `ErrorCode`s. The report is a pure aggregate over
`folios`, `cash_drops`, and `payouts`, all of which already carry `organization_id`,
`created_at`, and the seller keys.

---

## Data Model

**No schema change.** Read-only over existing columns:

| Source | Columns read |
|---|---|
| `folios` | `agent_id`, `affiliate_company_id`, `status`, `payment_method`, `total`, `amount_paid`, `commission_amount`, `created_at`, `settled_at` |
| `cash_drops` | `agent_id`, `amount`, `status`, `created_at` *(or `reviewed_at` — see Business Rule 4)* |
| `payouts` | `agent_id`, `amount`, `created_at` |

Seller identity for grouping/labels: `users` (`id`, `name`, `role`) LEFT JOIN
`affiliate_companies` (`name`) — the same shape `GET /api/cash/balances` already returns
(role + affiliate company), so a seller row reads identically across Caja and this report.

---

## Period semantics (decisions)

1. **A folio counts in the period when its `created_at` falls in `[from, to]`.** Bookings count
   at their `amount_paid` collected to date (the continuous model already handles partial
   collection); a booking created in-range but settled later contributes its in-range collection.
   *(Open refinement: attribute the settlement top-up to the settlement date — deferred; the live
   balance already nets it, and a period report keyed on `created_at` is the simpler v1.)*
2. **Cancelled folios are excluded** from sales/collected. A clawed-back commission (US-A26) is
   already `0`/removed on the folio, so summing `commission_amount` reflects clawbacks for free; a
   company-absorbed loss keeps the commission, matching the live balance.
3. **`[from, to]` is inclusive, interpreted in the org's reporting day** (single-timezone UTC
   model, consistent with the bookings/sales-cutoff specs). `from > to` → `400 VALIDATION_ERROR`.
4. **Drops and payouts count by their event date in range.** A drop counts when **confirmed**
   (`status = 'confirmed'`); pending/rejected drops never appear (they never moved cash). *(Drops
   are attributed by `created_at` for v1 to match the folio key; revisit if confirm-date
   attribution proves more intuitive for month-boundary settlements.)*

---

## Endpoints (new, admin-only, org-scoped)

A new `src/routes/reports/` router mounted at `/api/reports`, `authMiddleware` on `*` +
`requireRole('admin')`. Org-filtered on every query (Multitenancy Rule 1 — `organization_id`
from the session, never the body/query).

| Method & path | Purpose | US |
|---|---|---|
| `GET /api/reports/commissions?from&to&seller_id?&affiliate_company_id?` | Per-seller commission & settlement rows for the range (the US-A17 read; also powers US-A18 comparison and US-A53 when `affiliate_company_id` is set) | A17, A18, A53 |
| `GET /api/reports/commissions/export?from&to&format=csv&…` | Same query, streamed as a downloadable **CSV** | A20 |

> **PDF is client-side, not a server format.** Cloudflare Workers have no native PDF renderer
> and a JS PDF library is a heavy, browser-oriented dependency, so the export endpoint streams
> **CSV only** (`format=csv`; any other value → `400`). The frontend delivers PDF via
> **`window.print()`** over a print-friendly layout (the standard pragmatic path).

### `GET /api/reports/commissions` — response shape

```jsonc
{
  "period": { "from": "2026-06-01", "to": "2026-06-30" },
  "totals": {                       // org rollup across all sellers in range
    "sales_total": 4200000,
    "cash_collected": 2600000,
    "electronic_total": 1600000,
    "commission_earned": 540000,
    "confirmed_drops": 2300000,
    "payouts": 0,
    "net_owed": -240000             // company owes sellers net this period
  },
  "sellers": [
    {
      "seller_id": "usr_…",
      "name": "María López",
      "role": "agent",              // 'agent' | 'affiliate' | 'admin'
      "affiliate_company": null,    // company name for affiliates, else null
      "folios_sold": 18,
      "sales_total": 900000,
      "cash_collected": 700000,
      "electronic_total": 200000,
      "commission_earned": 120000,
      "confirmed_drops": 650000,
      "payouts": 0,
      "net_owed": -70000            // < 0 → company owes this seller
    }
    // … one row per seller with activity in range
  ]
}
```

Sellers with **no activity in range are omitted** (no zero-row noise). All money is integer
minor units (centavos), formatted client-side (`formatMoney`).

### `GET /api/reports/commissions/export`

Same query + grouping; `format=csv` returns `text/csv` (one row per seller, header line matching
the JSON columns, plus a final TOTALS row, `Content-Disposition: attachment`). Cells beginning
with a formula trigger (`= + - @`) are prefixed with `'` (CSV-injection guard). Unsupported
`format` → `400`. PDF is produced client-side via browser print, not by this endpoint.

---

## Business Rules (enforced server-side)

1. **Read-only & derived.** No writes. Every figure is summed from events; there is no stored
   report row to drift (same principle as the running balance).
2. **Org-scoped, admin-only.** `requireRole('admin')`; `organization_id` from the session. A
   `seller_id` or `affiliate_company_id` from another org → empty rows / `404` consistent with the
   multitenancy contract — never cross-org data.
3. **Attribution.** Group by `folios.agent_id` for the seller, surfacing `affiliate_company_id`
   so an affiliate's sales are tagged with their company (US-A51); admins appear as sellers
   (`role = 'admin'`, US-A33). `affiliate_company_id` filter → the US-A53 per-affiliate view.
4. **Commission is the snapshot.** Sum `folios.commission_amount` as-stored; never recompute from
   current service rates (rate changes must not rewrite sold history — the snapshot rule, US-A12).
5. **Net-remittance, not disbursement.** `net_owed` is the only settlement number; a positive
   value is cash the seller owes, a negative value is cleared by a payout (US-A25). The UI must
   **not** present `commission_earned` as a "to pay" total.
6. **Period figure, clearly labelled.** The UI states the report is for `[from, to]` and that
   `net_owed` is period-scoped, distinct from the live perpetual balance in Caja.

---

## Performance comparison (US-A18)

The same `sellers[]` array, sorted (default by `sales_total` desc), is the comparison: each row
already carries `folios_sold`, `sales_total`, the cash/electronic split, and `commission_earned`.
The frontend renders a ranked table/bar list — **no separate endpoint**. Sort key is a client
concern (sales, folios, or commission).

---

## Frontend (Reportes home — US-A17/A18/A20)

Reached from the account surface overflow (`docs/navigation/role-based-ia-reorganization.md`,
COULD-HAVE Reportes home). A date-range picker (default: current month), a per-seller table with
the settlement columns, a comparison sort toggle (US-A18), and an **Exportar** menu (CSV / PDF,
US-A20). Affiliates appear inline with a storefront chip (the same presentation the Caja already
uses for the folded affiliate rows). Money via `formatMoney`; net-owed colored like the Caja
(positive = owed to company, negative = company owes — `error`/`secondary` accents).

---

## Definition of Done

- [x] `GET /api/reports/commissions?from&to` returns org-scoped per-seller rows (agents **and**
      affiliates, plus the admin as a seller) with `sales_total`, cash/electronic split,
      `commission_earned`, `confirmed_drops`, `payouts`, and `net_owed`, plus an org `totals`
      rollup; sellers with no in-range activity are omitted (a drop/payout-only seller still appears).
- [x] `commission_earned` sums the **snapshotted** `folios.commission_amount`; cancelled folios
      are excluded; clawed-back commission is reflected; `net_owed` matches the running-balance
      formula summed over the range.
- [x] `affiliate_company_id` (and `seller_id`) filters scope the read correctly — the US-A53
      per-affiliate settlement view is this same query with the company filter.
- [x] `from > to` → `400 VALIDATION_ERROR`; bad `format` → `400`; non-admin → `403`.
- [x] Cross-org isolation test (`seedTwoOrgs`): org A's admin never sees org B's sellers, folios,
      drops, or payouts in the report or the CSV export.
- [x] `…/export?format=csv` streams a per-seller CSV with a TOTALS row, the CSV-injection guard,
      and `Content-Disposition: attachment`. PDF is delivered client-side via browser print.
- [x] Reportes home renders the date-range report + comparison sort + CSV/print export, labelling
      `net_owed` as a **period** figure distinct from the live Caja balance.
