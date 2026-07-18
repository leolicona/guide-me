# Feature: Agent Balance UX Overhaul — Cash vs Electronic

**User story:** US-AG29 (agent)
**Phase:** 2 (Core Enhancements) · **Depends on:** Agent Continuous Cash Balance with Cash
Drops (`agent-balance-cash-drops.spec.md`) — the derivation, the shift anchor, and the
`/me` surface this feature re-presents; and Advanced Cash Collection
(`advanced-cash-collection.spec.md`) — the pending-signatures section already living on the
Balance page. Read both first.

> Redesigns the agent's balance dashboard into **three visually distinct blocks** — **Total
> Sales (cash vs. electronic)**, **Earned Commissions**, and the **Physical Cash Box** (the
> company cash the agent must hand in) — so an agent instantly understands that electronic
> payments (card, wire transfer, payment link) **earn them commission without increasing
> their cash debt**. The feature is **financially inert**: no derivation, watermark, or
> balance rule changes — it adds a shift-scoped *sales* read model and a new presentation.

---

## Context

Today the agent's `GET /api/cash/me` + `BalancePage` show one card: the headline `balance`
(physical cash held) and a reconciliation breakdown (`carry_forward + cash_collected −
commission_total − expense_total + payouts_total`). This is correct but conflates three
mental models the agent actually reasons about separately:

1. **"How much did I sell?"** — performance. Today invisible: `cash_collected` only counts
   *cash* folios, so an agent with a big card-sale day looks like they sold nothing.
2. **"How much did I earn?"** — `commission_total` exists but reads as a *deduction line*
   inside the cash math, not as *earnings*.
3. **"How much cash must I hand in?"** — the headline `balance`. Correct today.

The confusion peaks on electronic sales (US-AG24 behaviour, already shipped): a card sale
credits the commission against the cash debt without adding collected cash. Agents read the
breakdown, see "Comisión ganada −$X" with no matching "+", and think they're being charged.
US-AG29 fixes the *presentation*: electronic sales are first-class, shown as sales that
**benefit** the agent (commission credited) while visibly **bypassing** the cash box.

### Design decisions (✅ = confirmed with product)

| # | Decision | Choice | Rationale |
|---|---|---|---|
| D1 ✅ | **Payment-method granularity** | **Extend** `folios.payment_method` to `['cash','card','transfer','link']`. The enum is app-level only (migration `0022` added a plain `text` column, no CHECK) → **no SQL migration**; Drizzle + Zod + POS UI updates only. Everything `≠ 'cash'` is **electronic**. | US-AG29 explicitly names "card, wire transfer, link". The cash derivation keys on `= 'cash'` / `≠ 'cash'`, so new methods are automatically electronic — zero financial risk. |
| D2 | **Financially inert** | The running-balance derivation, settlement watermark, reversal logic, and every existing field of `/me` and `/balances` are **unchanged**. The feature only **adds** a read model + UI. | The balance math is settled, tested, and audited; a UX story must not touch it. |
| D3 ✅ | **Sales scope** | **Shift-scoped**, same anchor as the existing breakdown (events since the last confirmed drop; full history when none). | One consistent timeline on the page. "Today" would introduce a second boundary that contradicts the shift model the agent already learned (US-AG12). |
| D4 ✅ | **Commission split** | `commission_total` stays the single reconciling figure; the new block additionally exposes `commissions.cash` / `commissions.electronic` (display-only, sums to the total). | The split *is* the story: "your electronic commissions are pure benefit — they reduce your cash debt". One grouped query; no invariant change. |
| D5 ✅ | **Surface** | **Agent + admin balances**: `GET /api/cash/me` + `BalancePage`, **and** each `GET /api/cash/balances` row + `CashBalancesPage` carry the same `sales`/`commissions` buckets. The drops queue/detail are untouched. | Product confirmed the admin should see each agent's cash-vs-electronic split in the same shift-scoped row that already mirrors the agent's `/me` view — one shared read model, two surfaces. Period-based sales *reports* remain US-A17. |
| D6 | **No new endpoint** | Extend the existing `GET /me` and `GET /balances` payloads. | Both pages already fetch these; a second request buys nothing. |

### Scope boundary

| Concern | Owner |
|---|---|
| `sales`/`commissions` read model on `GET /me` **and** `GET /balances`, the three-block Balance page redesign, the per-agent split on `CashBalancesPage`, POS payment-method options `transfer`/`link` (D1) | **This feature** |
| The balance derivation, watermark, carry-forward, drops, expenses, payouts, acknowledgments | *Baselines* — **unchanged** |
| US-AG24 behaviour (electronic sale credits commission, adds no cash debt) | *Already shipped* — this feature only **presents** it |
| Agent home/daily snapshot (US-AG26) | *Occupancy dashboard* feature — it may later reuse the same `sales` block |
| Admin sales/commission **reports by period** (US-A17/A18/A20) | *Reports* feature |
| Real card processing / payment gateways | **Out of scope** (Won't-have) — `payment_method` stays a declarative label of how the client paid |

---

## Data Model

**No new tables, no SQL migration.** One app-level enum extension (D1):

- `api-turistear/src/db/schema.ts` — `folios.payment_method` enum becomes
  `['cash', 'card', 'transfer', 'link']` (column stays `text NOT NULL DEFAULT 'cash'`).
- `api-turistear/src/routes/pos/schema.ts` — `payment_method: z.enum(['cash','card','transfer','link'])`.
- Frontend `PaymentMethod` type (`features/pos/types.ts`, `features/cash/types.ts`) extended
  to match.

**Electronic** is a derived bucket, never stored: `payment_method ≠ 'cash'`.

---

## Business Rules (enforced server-side)

All baseline rules hold unchanged. This feature adds **read-model rules only**:

1. **The `sales` block is shift-scoped and display-only.** It uses the **same anchor**
   (`since` = the last confirmed drop's settlement instant) as the existing breakdown.
   It never participates in the balance invariant — `balance = carry_forward +
   cash_collected − commission_total − expense_total + payouts_total` is untouched.
2. **Bucketing.** `sales.cash` = Σ `amount_paid` over non-cancelled folios with
   `payment_method = 'cash'` since the anchor; `sales.electronic` = same with
   `payment_method ≠ 'cash'`, additionally broken down `by_method`; `sales.total` = cash +
   electronic. Counts per bucket accompany the amounts.
3. **`sales.cash` equals `cash_collected`.** Both apply the same since-anchor sum *and* the
   same settled-cancellation reversal (TECH_DEBT §12a), so the sales block and the cash-box
   breakdown never show two different "cash" numbers on one screen.
4. **Commission split (D4).** `commissions.cash` / `commissions.electronic` group the
   existing commission sum (same `since`, same clawback semantics) by the folio's payment
   method; their sum **equals** `commission_total`. A cancelled folio with clawback drops
   out of its bucket exactly as it drops out of the total today.
5. **Electronic money never touches the cash box.** No electronic amount appears in
   `cash_collected`, `balance`, `balance_before`, or any drop/watermark figure (already true
   — restated as an explicit test obligation).
6. **POS validation (D1).** `payment_method ∈ {cash, card, transfer, link}`; anything else →
   `400 VALIDATION_ERROR`. Default remains `'cash'`. Commission snapshotting at POS is
   method-agnostic (unchanged).
7. **Admin balances mirror the agent view (D5).** Each `GET /api/cash/balances` row carries
   the **same** `sales`/`commissions` buckets, computed by the same shared helper with that
   agent's own anchor — the admin row and the agent's `/me` are always byte-identical for
   the same instant (the established mirroring guarantee of US-A19 extends to the new
   buckets). Ordering, existing fields, and the pending rollup are unchanged.
8. **Multitenancy.** The `sales` block derives strictly from `(organization_id, agent_id)` —
   the caller on `/me`, each in-org agent on `/balances` (admin's org only). Cross-org
   isolation proven with `seedTwoOrgs`.

---

## Endpoints

No new routes. **`GET /api/cash/me`** (agent) and **`GET /api/cash/balances`** (admin) are
extended — everything existing is unchanged. `GET /me` gains:

```json
{
  "balance": {
    "carry_forward": 13000,
    "cash_collected": 845000,
    "commission_total": 104500,
    "expense_total": 32000,
    "payouts_total": 0,
    "pending_drops_total": 0,
    "balance": 721500,
    "last_drop": { "…": "unchanged" },
    "expenses": [ "…unchanged…" ],
    "drops": [ "…unchanged…" ],
    "pending_acknowledgments": [ "…unchanged…" ],
    "pending_acknowledgments_count": 0,

    "sales": {
      "total": 1045000,
      "cash": 845000,
      "electronic": 200000,
      "by_method": { "card": 150000, "transfer": 50000, "link": 0 },
      "cash_count": 9,
      "electronic_count": 3
    },
    "commissions": {
      "total": 104500,
      "cash": 84500,
      "electronic": 20000
    }
  }
}
```

- `sales.cash == cash_collected` and `commissions.total == commission_total` always
  (Rules 3–4) — the old flat fields stay for backward compatibility and remain the
  reconciling figures.
- With no confirmed drop, the block spans the agent's whole history (same as the breakdown).
- `by_method` always carries all electronic keys (zero-filled) so the client renders a
  stable list.

### `GET /api/cash/balances` (admin) — extended per row (D5)

Each balance row gains the **same two blocks**, shift-scoped to that agent's own anchor,
alongside the unchanged existing fields:

```json
{ "balances": [
  { "agent": { "id": "usr_1", "name": "Ana" },
    "carry_forward": 13000, "cash_collected": 845000, "commission_total": 104500,
    "expense_total": 32000, "payouts_total": 0, "balance": 721500,
    "last_drop": { "…": "unchanged" },
    "pending_drops_total": 0, "pending_drops_count": 0,

    "sales": { "total": 1045000, "cash": 845000, "electronic": 200000,
               "by_method": { "card": 150000, "transfer": 50000, "link": 0 },
               "cash_count": 9, "electronic_count": 3 },
    "commissions": { "total": 104500, "cash": 84500, "electronic": 20000 }
  }
] }
```

Same invariants per row (`sales.cash == cash_collected`, `commissions.total ==
commission_total`); ordering by `balance` desc unchanged.

### `POST /api/pos/folios` (existing) — extended enum (D1)

`payment_method` accepts `'cash' | 'card' | 'transfer' | 'link'` (default `'cash'`).
Behaviour for the three electronic values is **identical** (US-AG24 path): commission
snapshotted and deducted, `amount_paid` never enters the cash balance.

---

## Frontend (app-turistear)

Layered per the frontend rules; this is a **redesign of `pages/BalancePage.tsx`** with new
presentational components under `features/cash/components/`. Elegant-minimalist: outlined
cards (`elevation={0}`, `1px solid divider`), one accent, generous spacing; mobile-first.

### Page structure (top → bottom)

1. **Pendientes de firma** — unchanged (advanced-cash-collection).
2. **🟦 Mi caja física** *(the single accent — the actionable number)*
   - Headline: **"Efectivo por entregar"** `$7,215.00` (or **"La empresa te debe"** in
     error color when negative — unchanged semantics).
   - The existing pending-drops hint and the reconciliation breakdown move into a
     **collapsible "¿Cómo se calcula?"** detail (rows: Saldo anterior, Efectivo cobrado,
     − Comisión ganada, − Gastos, + Pagos recibidos) — same rows as today, now folded so the
     headline reads clean.
   - Primary action **"Entregar efectivo"** stays attached to this block (it acts on it).
3. **🟩 Mis ventas** *(shift-scoped, from `sales`)*
   - Headline: **"Ventas del turno"** `$10,450.00` (+ count).
   - A two-segment visual split (thin stacked bar or two tiles): **Efectivo** `$8,450 · 9` /
     **Electrónico** `$2,000 · 3`, with quiet per-method chips (Tarjeta · Transferencia ·
     Link) from `by_method` (zero methods hidden).
   - Caption under Electrónico: *"No entra a tu caja — la cobra la empresa."*
4. **🟨 Mis comisiones** *(from `commissions`)*
   - Headline: **"Comisiones ganadas"** `$1,045.00`.
   - Split lines: *De ventas en efectivo* `$845.00` · *De ventas electrónicas* `$200.00`.
   - The explainer that resolves the US-AG29 confusion, shown when `electronic > 0`:
     *"Tus comisiones ya están descontadas de tu caja. Las de ventas electrónicas reducen tu
     deuda de efectivo — son ganancia directa."*
5. **Gastos** and **Entregas** — unchanged.

All three blocks share one timeline caption (existing copy): *"Desde tu última entrega ·
{fecha}"* / *"Toda tu actividad"* — rendered **once** above block 2.

### Admin — `pages/CashBalancesPage.tsx` (D5)

Each agent row keeps its headline balance + reconciliation breakdown and gains a compact
**cash-vs-electronic strip** (from the row's `sales`/`commissions`):
*Ventas del turno `$10,450` · Efectivo `$8,450` · Electrónico `$2,000`* with a quiet
*Comisiones `$1,045` (electrónicas `$200`)* line — read-only, no new actions. Per-method
chips appear only where a method is non-zero (the row stays scannable on mobile).

### POS checkout (D1)

The payment-method selector (`PosCheckoutPage` / its feature component) gains
**Transferencia** and **Link de pago** alongside Efectivo/Tarjeta — same control, four
options, grouped visually as *Efectivo* vs *Electrónico*.

### Types / service / hooks

- `features/cash/types.ts`: `PaymentMethod = 'cash' | 'card' | 'transfer' | 'link'` (shared
  with `features/pos/types.ts` — consider re-exporting from one place);
  `AgentBalance` **and** `BalanceListItem` gain `sales: SalesBreakdown` and
  `commissions: CommissionBreakdown`:

```ts
export interface SalesBreakdown {
  total: number
  cash: number              // always equals cash_collected
  electronic: number
  by_method: Record<Exclude<PaymentMethod, 'cash'>, number>
  cash_count: number
  electronic_count: number
}
export interface CommissionBreakdown {
  total: number             // always equals commission_total
  cash: number
  electronic: number
}
```

- `services/cashService.ts` / hooks: **no changes** beyond the type — same endpoint, same
  query key `['cash','me']`.
- New presentational components: `features/cash/components/SalesSummaryCard.tsx`,
  `CommissionsCard.tsx`, `CashBoxCard.tsx` (extracting the headline + collapsible breakdown
  from the page).

---

## Error responses

No new error cases. `POST /api/pos/folios` with an unknown `payment_method` → existing
`400 VALIDATION_ERROR` (the enum simply has four values now).

---

## Scenarios

### US-AG29 — Sales & commission split (read model)

#### S1 — Mixed shift splits correctly and stays reconciled
**Given** an agent whose anchor left `carry_forward = 13000`, with since-anchor non-cancelled
folios: cash `845000` (9 folios, commission `84500`), card `150000` (2, commission `15000`),
transfer `50000` (1, commission `5000`), and expenses `32000`
**When** `GET /api/cash/me`
**Then** `sales = { total: 1045000, cash: 845000, electronic: 200000, by_method: { card:
150000, transfer: 50000, link: 0 }, cash_count: 9, electronic_count: 3 }`;
`commissions = { total: 104500, cash: 84500, electronic: 20000 }`;
`cash_collected = 845000`; `commission_total = 104500`; and
`balance = 13000 + 845000 − 104500 − 32000 = 721500` — **identical to the value before this
feature existed** (financially inert, D2).

#### S2 — Pure-electronic shift drives the balance negative
**Given** a fresh agent whose only activity is a card folio of `200000` with commission `20000`
**When** `GET /api/cash/me`
**Then** `sales.cash = 0`, `sales.electronic = 200000`, `commissions.electronic = 20000`,
`balance = −20000` (the company owes the agent — existing US-AG24 semantics, now legible).

#### S3 — Shift scoping matches the breakdown anchor
**Given** the S1 agent with additional **pre-anchor** folios (any method)
**Then** none of them appear in `sales` / `commissions` — same `since` as `cash_collected`.

#### S4 — Cancellations: bucket follows the total
**Given** a since-anchor card folio that is **cancelled with clawback** and a cash folio
cancelled without clawback
**Then** the card folio leaves `sales.electronic` and `commissions.electronic`; the cash
folio leaves `sales.cash` but its commission **stays** in `commissions.cash` (company
absorbed it) — bucket sums always equal `commission_total` / the sales totals.

#### S5 — Settled-cancellation reversal keeps `sales.cash == cash_collected`
**Given** a pre-anchor cash folio cancelled **after** the watermark (TECH_DEBT §12a)
**When** `GET /api/cash/me`
**Then** the reversal lands in **both** `cash_collected` and `sales.cash` equally — one
"cash" number on screen.

### US-AG25 extension — new electronic methods (D1)

#### S6 — POS accepts transfer and link; both behave like card
**When** an agent confirms a folio with `payment_method: 'transfer'` (then `'link'`)
**Then** `201`; commission snapshotted and deducted from the balance; `amount_paid` adds
**no** cash debt; the folio serializes its method; `GET /me` buckets it under
`by_method.transfer` / `.link`.

#### S7 — Invalid method rejected
**When** `payment_method: 'crypto'`
**Then** `400 VALIDATION_ERROR`; no folio written.

#### S8 — Backward compatibility
**Given** existing folios created before this feature (`cash` / `card` only)
**Then** every figure (balance, breakdown, sales block) derives correctly with
`by_method.transfer = by_method.link = 0`.

### US-A19 extension — admin balances carry the split (D5)

#### S9 — Balances rows mirror each agent's /me buckets
**Given** the S1 agent and a second agent with only cash activity
**When** the admin `GET /api/cash/balances`
**Then** each row's `sales`/`commissions` equal that agent's own `/me` values exactly
(including per-agent anchors — agents at different shift states don't bleed into one
another); all existing fields and the `balance`-desc ordering are unchanged.

### Roles & Multitenancy

#### S10 — Wrong role
An `admin` calling `GET /api/cash/me`, or an `agent` calling `GET /api/cash/balances` →
`403 FORBIDDEN` (unchanged baseline).

#### S11 — `seedTwoOrgs` isolation (required)
**Given** folios across `org_a` and `org_b` agents with mixed payment methods
**Then** an `org_a` agent's `sales` / `commissions` count only their own `(org, agent)`
folios, and the `org_a` admin's `/balances` rows never include `org_b` agents or activity.

---

## Definition of Done

**Backend**
- [x] `folios.payment_method` enum extended to `['cash','card','transfer','link']` in Drizzle
      schema + POS Zod schema (no SQL migration — app-level enum, D1).
- [x] `deriveBalance` (or a sibling read helper) returns the shift-scoped `sales` +
      `commissions` buckets; `GET /me` **and** each `GET /balances` row serialize them via
      the same shared helper; **no existing field changes**.
- [x] Invariants tested: `sales.cash == cash_collected`, `commissions.cash +
      commissions.electronic == commission_total`, balance value byte-identical to
      pre-feature derivation (S1), `/balances` rows mirror `/me` (S9).
- [x] Tests S1–S11 in `test/cash/` (new file `agent-balance-ux-overhaul.test.ts`), incl.
      `seedTwoOrgs` (S11) and POS method tests (S6–S8).

**Frontend**
- [x] `PaymentMethod` extended; `AgentBalance` + `BalanceListItem` gain `SalesBreakdown` /
      `CommissionBreakdown`.
- [x] `BalancePage` redesigned into the three blocks (Caja física with collapsible
      breakdown · Mis ventas with cash/electronic split + per-method chips · Mis comisiones
      with split + explainer); Gastos/Entregas/Pendientes-de-firma unchanged.
- [x] `CashBalancesPage` rows show the read-only cash-vs-electronic strip + commissions line.
- [x] POS checkout selector offers Transferencia + Link de pago.
- [x] `pnpm lint:app`, `tsc`, `pnpm build:app` clean.

**Docs**
- [x] `docs/SPEC.md` Phase-2 line for US-AG29 links this spec; checked off when shipped.

---

## Resolved questions

All four open decisions were confirmed with product (2026-06-10):

1. **D1 ✅ Extend payment methods** to `cash|card|transfer|link` now (no SQL migration).
2. **D4 ✅ Show the commission split** (*De ventas en efectivo / electrónicas*).
3. **D3 ✅ Shift-scoped** sales block — same anchor as the existing breakdown.
4. **D5 ✅ Include the admin surface** — `GET /api/cash/balances` rows and
   `CashBalancesPage` carry the same buckets (default of "agent only" was overridden).
