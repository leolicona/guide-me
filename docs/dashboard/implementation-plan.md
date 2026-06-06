# Implementation Plan: Daily Operations Dashboard (admin)

Spec: `docs/dashboard/occupancy-dashboard.spec.md` — US-A14, US-A15, US-A16.

**Shape:** three new **read-only** GET endpoints under `/api/dashboard` (two admin, one
agent), all derived live from `slots` + `folios`. **No migration, no writes, no cash
re-derivation** — the Cash pillar and attention strip *compose* the existing `/api/cash/*`
endpoints client-side. Then a rebuilt `DashboardPage` with role-specific views. Mirror the
`routes/cash` router and `features/cash` frontend conventions.

---

## Phase 1 — Backend route scaffold

**Files:** `api-guideme/src/routes/dashboard/{index.ts,handler.ts,schema.ts}` + mount.

### 1.1 `schema.ts`
```ts
import { z } from 'zod'
export const dateQuerySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD').optional(),
})
export type DateQuery = z.infer<typeof dateQuerySchema>
```

### 1.2 `index.ts` (mirror `routes/cash/index.ts`)
```ts
const dashboard = new Hono<{ Bindings: CloudflareBindings; Variables: AppVariables }>()
dashboard.use('*', authMiddleware)
const admin = requireRole('admin'); const agent = requireRole('agent')

dashboard.get('/occupancy',     admin, zValidator('query', dateQuerySchema, validationHook), getOccupancy)
dashboard.get('/sales-summary', admin, zValidator('query', dateQuerySchema, validationHook), getSalesSummary)
dashboard.get('/me',            agent, zValidator('query', dateQuerySchema, validationHook), getMyDay)
export default dashboard
```

### 1.3 Mount in `src/index.tsx`
```ts
import dashboardRouter from './routes/dashboard'
app.route('/api/dashboard', dashboardRouter)
```

---

## Phase 2 — Day-window + day-bucket helpers (the timezone seam)

Pure helpers in `handler.ts`; single source so all pillars agree (spec § operating-day boundary).

```ts
const ORG_TZ_OFFSET_MINUTES = -360 // America/Mexico_City, UTC−06:00, no DST (MVP)
const OFFSET_SEC = ORG_TZ_OFFSET_MINUTES * 60

// query → { date:'YYYY-MM-DD', startSec, endSec } in the org offset
const resolveDay = (date?: string) => {
  const day = date ?? new Date(Date.now() + ORG_TZ_OFFSET_MINUTES * 60_000).toISOString().slice(0, 10)
  const startSec = Math.floor((Date.parse(`${day}T00:00:00Z`) - ORG_TZ_OFFSET_MINUTES * 60_000) / 1000)
  return { date: day, startSec, endSec: startSec + 86_400 }
}
// local epoch-day bucket for the comparison rollup: cast((created_at + OFFSET_SEC)/86400 as int)
const bucketToDate = (bucket: number) => new Date(bucket * 86_400_000).toISOString().slice(0, 10)
```

> Unit-test `resolveDay` against Scenario 10 (`05:00Z` → previous local day; `07:00Z` → queried day).

---

## Phase 3 — `getOccupancy` (US-A14, US-A15 + revenue potential)

Single org-scoped query: active slots on `:date` **inner join active services** (need
`services.name`, `services.basePrice`), ordered `services.name, slots.startTime`. Group in JS.

```ts
const ALMOST_FULL_RATIO = 0.2
const classify = (capacity: number, booked: number) => {
  const remaining = Math.max(0, capacity - booked)
  if (capacity === 0 || remaining === 0) return 'full'
  return remaining / capacity <= ALMOST_FULL_RATIO ? 'almost_full' : 'available'
}
// per slot: remaining, status, potential_revenue = remaining * basePrice
```
Reduce into `services[]` keyed by `service_id`, accumulating per-service `summary`
(capacity/booked/remaining/`potential_revenue`/status counts) and grand `totals` (+ `full_count`,
`almost_full_count`). Return `{ date, services, totals }` (Rules 3–6, 12).

---

## Phase 4 — `getSalesSummary` (US-A16 + comparison anchor)

`handler.ts`. Reuse the `coalesce(sum(...),0)` / `count(*)` idiom from `cash/handler.ts`.

- **Day totals (non-cancelled, `created_at ∈ [startSec,endSec)`):** one query —
  `sum(amount_paid)` total, `count(*)`, conditional cash/card sums
  (`sum(case when payment_method='cash' then amount_paid else 0 end)`), over `ne(status,'cancelled')`.
- **Cancelled count:** `count(*)` `status='cancelled'` in window (Rule 7).
- **Per-agent (day lens, Rule 10):** `group by agent_id` over non-cancelled day folios
  (`count`, `sum(amount_paid)`, cash sum); join `users` for `name` (org-scoped); order desc.
  **No balance/drops here** — joined client-side.
- **Comparison (Rule 9):** one query over a trailing 28-day window —
  `select cast((created_at + :OFFSET_SEC)/86400 as int) bucket, sum(amount_paid)
   from folios where org and ne(status,'cancelled') and created_at >= :since group by bucket`.
  In JS: map buckets → dates, take last 7 for `spark`, `previous_day_total` = yesterday's
  bucket, `weekday_avg` = mean of the prior 4 same-weekday buckets.

Return `{ date, total_collected, cash_collected, card_collected, folio_count, cancelled_count,
comparison, per_agent }`. Empty day → zeros, `per_agent: []` (Rule 12). Money = minor units.

---

## Phase 5 — `getMyDay` (agent self lens)

`handler.ts`. Caller-scoped (`agent_id = c.get('user').id`), same day window, non-cancelled:
`{ folio_count, total_collected, cash_collected, commission_earned = sum(commission_amount) }`.
Balance/expenses/drops come from the existing `/api/cash/me` — not duplicated (Rule 11).

---

## Phase 6 — Backend tests

`api-guideme/test/dashboard/occupancy-dashboard.test.ts` (`cloudflare:test`, `SELF.fetch`,
`seedUser`/`seedTwoOrgs`, direct `env.DB.prepare` inserts with explicit `created_at`).

| Scenario | Assertion |
|---|---|
| 1 | grouping + remaining + status + `potential_revenue` + per-service summary |
| 2 | status thresholds |
| 3 | inactive slot & inactive service excluded |
| 4 | `date` defaults to today |
| 5 | empty day → `200` empty arrays (incl. `potential_revenue: 0`) |
| 6 | malformed `date` → `400` |
| 7 | totals + cash/card split |
| 8 | cancelled excluded, counted separately |
| 9 | per-agent day lens ordered desc, no-sale agents absent, **no balance fields** |
| 10 | day boundary honors offset |
| 11 | comparison: `previous_day_total`, `weekday_avg`, 7-entry `spark` |
| 12 | empty day → zeros |
| 13 | agent `/me` self-scoped (`commission_earned`); no cross-agent data |
| 14 | wrong role → `403` (agent→admin routes, admin→`/me`) |
| 15 | `seedTwoOrgs` B3/B4 — no cross-org leakage on all endpoints |

Plus a unit test on `resolveDay` / bucket math.

---

## Phase 7 — Frontend service + feature

### 7.1 `services/dashboardService.ts`
```ts
const qs = (date?: string) => (date ? `?date=${date}` : '')
export const getOccupancy   = (date?: string) => request<Occupancy>(`/api/dashboard/occupancy${qs(date)}`)
export const getSalesSummary= (date?: string) => request<SalesSummary>(`/api/dashboard/sales-summary${qs(date)}`)
export const getMyDay       = (date?: string) => request<MyDay>(`/api/dashboard/me${qs(date)}`)
```

### 7.2 `features/dashboard/`
- `types.ts` — `OccupancyStatus`, `OccupancySlot`(+`potential_revenue`), `ServiceOccupancy`,
  `Occupancy`(+`totals.full_count`/`almost_full_count`), `Comparison`, `SalesSummary`,
  `AgentSales`, `MyDay`.
- `hooks/useDashboard.ts`:
  ```ts
  export const useOccupancy   = (d?: string) => useQuery({ queryKey:['dashboard','occupancy',d??'today'],
    queryFn:()=>getOccupancy(d), refetchInterval:30_000 })        // US-A15 real-time
  export const useSalesSummary= (d?: string) => useQuery({ queryKey:['dashboard','sales',d??'today'],
    queryFn:()=>getSalesSummary(d), refetchInterval:60_000 })
  export const useMyDay       = (d?: string) => useQuery({ queryKey:['dashboard','me',d??'today'],
    queryFn:()=>getMyDay(d), refetchInterval:60_000 })
  ```
  Cash data reuses the **existing** cash hooks — `useBalances` (`/api/cash/balances`) for the
  admin bridge/attention strip, `useMyBalance` (`/api/cash/me`) for the agent.
- `components/`:
  - `AttentionStrip` — composes occupancy (`full_count`/`almost_full_count`) + `useBalances`
    (pending-drops count/total, agents with negative balance). Chips deep-link via `ROUTES`:
    pending drops → `/cash/drops`, capacity → `/catalog`, negative balances → `/cash`.
  - `OccupancyStatusChip` — `available` neutral/teal · `almost_full` amber · `full` muted error.
  - `ServiceOccupancyCard` — header (name, summary chip, **potential_revenue**) + slot rows.
  - `OccupancyGrid` — maps services; empty state.
  - `SalesSparkline` + `SalesSummaryCard` — total (large), cash/card split labeled "nueva
    exposición de efectivo" vs "comisión sin deuda", cancelled count, **vs-yesterday/weekday-avg delta**.
  - `AgentSalesTable` — per-agent day row + **balance held / pending drops** columns joined
    from `useBalances` by `agent_id` (cash-exposure bridge).
  - `MyDayCard` — agent: today's sales + running balance (`useMyBalance`) + register-drop CTA.
  - `DashboardDatePicker` — default today.
- `index.ts` — exports.

---

## Phase 8 — `DashboardPage` assembly

Rebuild `app-guideme/src/pages/DashboardPage.tsx`, role-split:

- **admin:** `DashboardDatePicker` (state: selected date, default today) →
  `AttentionStrip` → `OccupancyGrid` (Capacity) → `SalesSummaryCard` + `AgentSalesTable`
  (Sales + cash bridge). Page-level `Fade`, skeletons, error alerts, empty states.
- **agent:** `MyDayCard` (today's sales + balance + one-tap register-cash-drop CTA reusing
  the existing drop flow) — replaces the placeholder.

No route/nav change — `ROUTES.DASHBOARD` and the nav item already exist for both roles.
Verify `pnpm build:app` clean, `pnpm lint:app` 0 errors.

---

## Phase 9 — Docs & wrap-up
- Tick `docs/SPEC.md` SHOULD-HAVE **Occupancy visual dashboard (admin)** → link here (note the
  broadened "Daily Operations Dashboard" scope).
- Add `docs/TECH_DEBT.md`: fixed `ORG_TZ_OFFSET_MINUTES` → action `organizations.timezone` column.

---

## Risks / decisions

- **Composition over duplication (key).** The Cash pillar, the per-agent balance columns, and
  the attention strip all reuse `/api/cash/balances` + `/api/cash/me` rather than re-deriving.
  `deriveBalance` stays single-sourced; the dashboard backend only ever touches `slots`+`folios`.
  Cost: the admin page makes 3 fetches and joins client-side — negligible, and it keeps feature
  ownership clean.
- **Timezone seam isolated** in `resolveDay` + one constant; per-org tz later is localized.
  TECH_DEBT, not a blocker.
- **Comparison anchor is the scope ceiling.** One bounded 28-day rollup for delta + sparkline.
  Date-range reports, agent comparison, CSV/PDF = US-A17/A18/A20 (separate feature) — explicitly out.
- **"Real-time" = polling** (React Query `refetchInterval`); no websockets/SSE (matches online-only MVP).
- **Agent dashboard reuses cash `/me`** — the register-drop CTA feeds the admin's confirm queue,
  closing the same settlement loop the attention strip surfaces.
