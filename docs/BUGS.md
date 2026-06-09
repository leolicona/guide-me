# Bug Register

Tracks confirmed bugs, root causes, and fixes. Each entry is immutable once closed — it is a historical record, not a living document.

> **Format:** bugs are numbered in reverse-discovery order (newest first). Status: ⚠️ OPEN | ✅ FIXED | 🔍 INVESTIGATING.

---

## BUG-002 — `commission_bonus` Applied as Flat Centavos per Pass Instead of % of Line Total — ✅ FIXED

**Discovered:** 2026-06-08
**Fixed:** 2026-06-08 (deployed `2619f2d2`)
**Reporter:** Leo Licona (manual verification)
**Affected component:** `api-guideme/src/routes/pos/handler.ts`

### Symptom

An agent with `base_commission = 1000` (10%) selling a service with `commission_bonus = 500` (5%) on a $1,000 sale received **$125** instead of **$150**. The system was consistently underpaying agents by the full service-bonus portion.

### Root Cause

The `bonusTotal` reduction in `confirmSale` used:

```ts
// WRONG — treats 500 as a flat centavo amount per pass
(sum, l) => sum + l.commissionBonus * l.quantity
```

`commission_bonus = 500` (basis points = 5%) was multiplied by `quantity` (e.g., 5 passes → `500 × 5 = 2,500` centavos = $25 bonus), rather than applied as a percentage of the line total (`5% × $1,000 = $50`). The bug caused the bonus to scale with pass count rather than sale value, and the discrepancy worsened as price per pass increased.

### Fix

Changed to percentage-of-line-total (consistent with `base_commission` treatment):

```ts
// CORRECT — 500 bp = 5% of line_total
(sum, l) => sum + Math.round((l.lineTotal * l.commissionBonus) / 10000)
```

### Data corrections (production)

Three production folios were under-credited and corrected:

| Folio | Was | Should Be | Delta |
|---|---|---|---|
| `2c3cab17` ($1,000 sale) | $125 | **$150** | +$25 |
| `2590a959` ($3,000 sale) | $400 | **$450** | +$50 |
| `999362eb` ($900 sale) | $115 | **$135** | +$20 |

Agent's balance adjusted: $875 → **$780** (the $95 difference credited).

### Related changes

- `api-guideme/src/routes/pos/handler.ts` — formula fix
- `api-guideme/src/routes/services/schema.ts` — `commission_bonus` validation: int 0–10000 (bp), replaces money validator
- `api-guideme/src/db/schema.ts` — column comment updated to clarify basis points
- `app-guideme/src/features/catalog/types.ts` — `percentToBasisPoints` / `basisPointsToPercent` helpers; field changed from `$` to `%`
- `app-guideme/src/features/catalog/schemas.ts` — validation 0–100 (percent in UI)
- `app-guideme/src/features/catalog/components/ServiceFormDialog.tsx` — conversion on prefill + submit
- `app-guideme/src/pages/CatalogDetailPage.tsx` — display as `X%` not money
- `docs/commissions/commissions.spec.md` — formula, data model, scenarios updated
- Tests: `pos-controlled-discount.test.ts` + `service-catalog.test.ts` corrected

---

## BUG-001 — Commission Formula Divisor `/100` Instead of `/10000` (1000× Overcharge) — ✅ FIXED

**Discovered:** 2026-06-07
**Fixed:** 2026-06-07
**Reporter:** Leo Licona (CURL validation)
**Affected component:** `api-guideme/src/routes/pos/handler.ts`

### Symptom

Two production folios had astronomical `commission_amount` values:

| Folio | Total | `commission_amount` | Effective rate |
|---|---|---|---|
| `062fe361` | $900 | $9,000 | **1000%** |
| `eabda6ba` | $1,390 | $35,550 | **2557%** |

### Root Cause

`agents/schema.ts` defined `base_commission` in **basis points** (`1000 = 10%`), but `pos/handler.ts` divided by `100`:

```ts
// WRONG — treats basis points as if they were simple integer percents
const baseCommission = Math.round((total * basePct) / 100)
// basePct = 1000 (10% in bp) → divides by 100 → 10× overcharge
```

A 10% agent (`base_commission = 1000`) produced a 1000% commission.

### Fix

```ts
// CORRECT — 10000 is the basis-point denominator (1000 bp = 10%)
const baseCommission = Math.round((total * basePct) / 10000)
```

### Data corrections (production)

| Folio | Was | Should Be |
|---|---|---|
| `062fe361` | $9,000 | **$900** |
| `eabda6ba` | $35,550 | **$427.50** |

A `820,000` centavo cash drop that had been confirmed against the inflated balance was reviewed and left as-is (arithmetically correct given all recorded transactions at that moment — user chose Option A).

### Related changes

- `api-guideme/src/routes/pos/handler.ts` — divisor `/100` → `/10000`
- Production D1 rows patched via `wrangler d1 execute`

---

*See also `docs/TECH_DEBT.md` for known limitations and accepted trade-offs that are not bugs.*
