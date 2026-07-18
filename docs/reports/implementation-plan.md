# Implementation Plan: Commission Report by Period

Spec: `docs/reports/commission-report.spec.md` — US-A17, US-A18, US-A20.

**Shape:** one new **read-only** GET endpoint under `/api/reports` (admin) that aggregates
`folios` + `cash_drops` + `payouts` per seller over a date range, plus a CSV export of the same
read. No migration, no writes, no new mutable balance — it sums the same events the running
balance derives from, keyed on a calendar window instead of "since the last drop". Then a
`ReportsPage` (admin) wired into the account-surface overflow (US-UX03), reusing the
`features/cash` + `services/cashService` conventions.

**Aggregation strategy — O(1) queries, not per-seller loops.** Unlike `listBalances` (which maps
each agent through `deriveBalance`), this report needs no shift watermark, so it runs **three
grouped aggregate queries** (folios, confirmed drops, payouts), each `GROUP BY agent_id`, then
stitches them against the org's user roster in JS. Cost is constant in the number of sellers.

**PDF decision.** PDF is **not** generated in the Worker (no native PDF renderer; a JS PDF lib is
a heavy, browser-oriented dependency). The export endpoint streams **CSV** only; the frontend
offers **"Exportar CSV"** (server download) and **"Imprimir / PDF"** via `window.print()` over a
print-friendly layout — the standard pragmatic path. The spec DoD is updated to match.

---

## Phase 1 — Backend route scaffold

**Files:** `api-turistear/src/routes/reports/{index.ts,handler.ts,schema.ts}` + mount in `index.tsx`.

### 1.1 `schema.ts`
```ts
import { z } from 'zod'

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')

// from/to required & inclusive; from ≤ to enforced via .refine. Optional seller_id /
// affiliate_company_id narrow the read (affiliate_company_id powers the US-A53 drill-down).
export const commissionReportQuerySchema = z
  .object({
    from: ymd,
    to: ymd,
    seller_id: z.string().min(1).optional(),
    affiliate_company_id: z.string().min(1).optional(),
  })
  .refine((q) => q.from <= q.to, { message: 'from must be on or before to', path: ['from'] })

export const commissionExportQuerySchema = commissionReportQuerySchema.and(
  z.object({ format: z.enum(['csv']).default('csv') }),
)
export type CommissionReportQuery = z.infer<typeof commissionReportQuerySchema>
```
*(`from > to` and a bad `format` both surface as `400 VALIDATION_ERROR` via the validation hook —
no new `ErrorCode`.)*

### 1.2 `index.ts` (mirror `routes/cash/index.ts`)
```ts
const reports = new Hono<{ Bindings: CloudflareBindings; Variables: AppVariables }>()
const validationHook = (r: { success: boolean }) => {
  if (!r.success) throw new ApiError('VALIDATION_ERROR', 400, 'Invalid request payload')
}
reports.use('*', authMiddleware)
const admin = requireRole('admin')

reports.get('/commissions', admin, zValidator('query', commissionReportQuerySchema, validationHook), getCommissionReport)
reports.get('/commissions/export', admin, zValidator('query', commissionExportQuerySchema, validationHook), exportCommissionReport)
export default reports
```

### 1.3 Mount in `src/index.tsx`
```ts
import reportsRouter from './routes/reports'
app.route('/api/reports', reportsRouter)
```

---

## Phase 2 — Period aggregation (the core read)

All in `handler.ts`. Money is integer minor units; every query is org-scoped
(`organization_id` from the session, never the query — Multitenancy Rule 1).

### 2.1 Range helper (UTC, matching `routes/pos/handler.ts`)
```ts
// from/to are inclusive calendar days in the org's UTC reporting model (POS precedent).
// Returns [fromDate, toExclusiveDate) for half-open comparisons on folios.created_at.
const resolveRange = (from: string, to: string) => ({
  fromDate: new Date(`${from}T00:00:00Z`),
  toExclusive: new Date(Date.parse(`${to}T00:00:00Z`) + 86_400_000),
})
```

### 2.2 Three grouped aggregates, keyed by `agent_id`
Reuse the same keep-semantics the cash handler uses (cancelled excluded from sales/collected;
commission kept on a live folio OR a company-absorbed cancellation — `clawback = false`):

```ts
// Folios: one row per seller via conditional aggregation over the range.
const folioAgg = await db.select({
  agentId: folios.agentId,
  foliosSold:      sql<number>`count(case when ${folios.status} != 'cancelled' then 1 end)`,
  salesTotal:      sql<number>`coalesce(sum(case when ${folios.status} != 'cancelled' then ${folios.total} end), 0)`,
  cashCollected:   sql<number>`coalesce(sum(case when ${folios.status} != 'cancelled' and ${folios.paymentMethod} = 'cash' then ${folios.amountPaid} end), 0)`,
  electronicTotal: sql<number>`coalesce(sum(case when ${folios.status} != 'cancelled' and ${folios.paymentMethod} != 'cash' then ${folios.amountPaid} end), 0)`,
  commission:      sql<number>`coalesce(sum(case when (${folios.status} != 'cancelled' or ${folios.cancellationClawback} = 0) then ${folios.commissionAmount} end), 0)`,
}).from(folios)
  .where(and(eq(folios.organizationId, org), gte(folios.createdAt, fromDate), lt(folios.createdAt, toExclusive),
             ...(sellerId ? [eq(folios.agentId, sellerId)] : []),
             ...(affiliateCompanyId ? [eq(folios.affiliateCompanyId, affiliateCompanyId)] : [])))
  .groupBy(folios.agentId)

// Confirmed drops in range, grouped by agent.
const dropAgg = await db.select({ agentId: cashDrops.agentId, total: sql<number>`coalesce(sum(${cashDrops.amount}),0)` })
  .from(cashDrops).where(and(eq(cashDrops.organizationId, org), eq(cashDrops.status, 'confirmed'),
                             gte(cashDrops.createdAt, fromDate), lt(cashDrops.createdAt, toExclusive)))
  .groupBy(cashDrops.agentId)

// Payouts in range, grouped by agent.
const payoutAgg = await db.select({ agentId: payouts.agentId, total: sql<number>`coalesce(sum(${payouts.amount}),0)` })
  .from(payouts).where(and(eq(payouts.organizationId, org),
                           gte(payouts.createdAt, fromDate), lt(payouts.createdAt, toExclusive)))
  .groupBy(payouts.agentId)
```
*(When `affiliate_company_id` is set, drops/payouts are still keyed by agent — they are filtered
to that company's sellers in the stitch step, since `cash_drops`/`payouts` carry no company
column. For the per-affiliate (US-A53) case the company's seller-id set comes from the roster.)*

### 2.3 Stitch against the roster
Collect every `agent_id` present in any aggregate, fetch those users (org-scoped) with
`role` + affiliate company name (LEFT JOIN `affiliate_companies`, same shape as `listBalances`),
filter to the requested company when set, and build one row per seller:

```ts
net_owed = cash_collected − commission_earned − confirmed_drops + payouts
```
Drop/payout-only sellers (cash settled this period against prior sales) **do** appear — that is
activity. Sort `sellers` by `sales_total` desc. Sum the rows into the org `totals` rollup.
Response per the spec's JSON shape (`period`, `totals`, `sellers[]`).

---

## Phase 3 — CSV export (US-A20)

`exportCommissionReport` calls the same aggregation, then serializes:

```ts
const header = ['seller','role','affiliate_company','folios_sold','sales_total',
                'cash_collected','electronic_total','commission_earned','confirmed_drops','payouts','net_owed']
// money columns as decimal strings (minor/100); a final TOTALS row; CRLF line endings.
return new Response(csv, {
  headers: {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="comisiones_${from}_${to}.csv"`,
  },
})
```
CSV-inject guard: prefix any cell beginning with `= + - @` with a `'`. No new error codes.

---

## Phase 4 — Frontend data layer

### 4.1 Types — `features/cash/types.ts` (or a new `features/reports/types.ts`)
`CommissionReportRow`, `CommissionReportTotals`, `CommissionReport { period, totals, sellers }`,
and `CommissionReportParams { from; to; seller_id?; affiliate_company_id? }`. Money is `number`
(minor units), formatted with the existing `formatMoney`.

### 4.2 Service — `services/reportsService.ts`
```ts
export const getCommissionReport = (p: CommissionReportParams) =>
  request<CommissionReport>(`/api/reports/commissions?${new URLSearchParams(clean(p))}`)
// Export: build the same query + `format=csv`, fetch as blob, trigger a download anchor.
export const exportCommissionReportCsv = async (p: CommissionReportParams) => { /* blob → <a download> */ }
```
Reuses the shared `request` (cookie auth, `ServiceError` on non-2xx) from `authService`.

### 4.3 Hooks — `features/reports/hooks/useReports.ts`
```ts
export const useCommissionReport = (p: CommissionReportParams) =>
  useQuery({ queryKey: ['reports','commissions', p], queryFn: () => getCommissionReport(p) })
```

---

## Phase 5 — Reportes page + IA wiring

### 5.1 `pages/ReportsPage.tsx` (admin)
- A **date-range picker** defaulting to the current month (`from = first of month`, `to = today`,
  UTC), two `type="date"` MUI `TextField`s (mobile-native pickers; MUI v9 `slotProps`).
- A **per-seller table** (US-A17): seller (with the affiliate storefront `Chip` reused from the
  Caja fold), folios, sales, cash/electronic split, commission earned, drops, payouts, and
  **net owed** colored like the Caja (positive = owed to company `error.main`-adjacent vs negative
  = company owes `secondary.main`). A **TOTALS** footer row.
- A **comparison sort toggle** (US-A18): sort by sales / folios / commission (client-side).
- An **Exportar** menu: **CSV** (server download) and **Imprimir / PDF** (`window.print()` with a
  `@media print` layout that hides the app chrome). A clear caption: *"Cifras del período
  seleccionado — distinto del saldo en vivo de Caja."*
- Loading skeleton + empty state (*"Sin ventas en este período."*); elegant-minimalist (cards
  breathe, `elevation={0}` + 1px divider borders).

### 5.2 Route — `config/routes.ts` + `App.tsx`
```ts
REPORTS: '/reports', // admin — commission & settlement report by period (US-A17/18/20)
```
`<Route path={ROUTES.REPORTS} element={<RoleGuard role="admin"><ReportsPage /></RoleGuard>} />`

### 5.3 Account overflow — `layout/AccountMenu.tsx`
Add to `MANAGEMENT_LINKS`: `{ label: 'Reportes', to: ROUTES.REPORTS, icon: AssessmentRounded }`
(remove any `disabled` placeholder if one exists). This realizes the "Reportes home" entry
(SPEC.md COULD-HAVE, `role-based-ia-reorganization.md`).

---

## Phase 6 — Tests (`api-turistear/test/reports/commission-report.test.ts`)

Reuse `seedTwoOrgs`, `seedUser`, `seedAffiliateCompany`, `clearAffiliateDb`, and a local raw-D1
`seedFolio` / `seedDrop` / `seedPayout` (mirror the cash + affiliate suites; `buildFakeJwt` auth).

1. **Per-seller settlement math** — agent with cash + card + a clawed-back cancellation: assert
   `sales_total`, cash/electronic split, `commission_earned` (clawback excluded, company-absorbed
   kept), `confirmed_drops`, `payouts`, `net_owed`.
2. **Pending/rejected drops excluded**; only `confirmed` count.
3. **Date-range boundaries** — a folio one second before `from` and one at `to`'s end-of-day:
   the in-range one counts, the out-of-range one does not (half-open `[from, to+1d)`).
4. **Affiliates + admin appear as sellers**; affiliate row carries `role:'affiliate'` +
   `affiliate_company`; admin sales show `role:'admin'`.
5. **`affiliate_company_id` filter** = the US-A53 drill-down (only that company's sellers).
6. **Zero-activity sellers omitted**; **drop-only seller appears** with negative `net_owed`.
7. **`from > to` → 400**; **bad `format` → 400**.
8. **Cross-org isolation** (`seedTwoOrgs`): org A admin never sees org B sellers/folios/drops/
   payouts in the report or the CSV export.
9. **CSV export** — `200`, `text/csv`, `Content-Disposition: attachment`, a TOTALS row, and the
   injection-guard prefix on a crafted name.

**Gate:** `pnpm --filter api-turistear test` green (the API has no tsc gate — vitest is the gate).
Frontend: `pnpm lint:app` + `tsc` + `vite build` clean.

---

## Order of execution
1. Phase 1–3 backend (scaffold → aggregate → CSV) + Phase 6 tests → run suite green.
2. Phase 4–5 frontend (service → hooks → page → route → menu) → lint/tsc/build.
3. Update the spec DoD's PDF line to the CSV-server + print-PDF decision.
