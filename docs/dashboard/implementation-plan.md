# Implementation Plan: Occupancy Visual Dashboard (admin)

Spec: `docs/dashboard/occupancy-dashboard.spec.md` — US-A14, US-A15, US-A16.

**Shape of the work:** two new **read-only, admin-only** GET endpoints under `/api/dashboard`,
all numbers derived live from `slots` / `folios` / `users`. No migration, no writes. Then a
rebuilt `DashboardPage` for admins. Mirror the `routes/cash` router conventions and the
`features/cash` frontend layout.

---

## Phase 1 — Backend route scaffold

**Files:** `api-guideme/src/routes/dashboard/{index.ts,handler.ts,schema.ts}` + mount in
`src/index.tsx`.

### 1.1 `schema.ts`
```ts
import { z } from 'zod'

// Optional ?date=YYYY-MM-DD; absent → server uses "today" in the org offset.
export const dateQuerySchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
    .optional(),
})
export type DateQuery = z.infer<typeof dateQuerySchema>
```

### 1.2 `index.ts` (mirror `routes/cash/index.ts`)
```ts
const dashboard = new Hono<{ Bindings: CloudflareBindings; Variables: AppVariables }>()
dashboard.use('*', authMiddleware)
const admin = requireRole('admin')

dashboard.get('/occupancy', admin, zValidator('query', dateQuerySchema, validationHook), getOccupancy)
dashboard.get('/sales-summary', admin, zValidator('query', dateQuerySchema, validationHook), getSalesSummary)
export default dashboard
```

### 1.3 Mount in `src/index.tsx`
```ts
import dashboardRouter from './routes/dashboard'
// …
app.route('/api/dashboard', dashboardRouter)
```

---

## Phase 2 — Day-window helper (the timezone seam)

In `handler.ts`, a small pure helper resolves `:date` (or today) to the `[start, end)`
epoch-second window and the canonical date string. Single source of truth so both endpoints
agree (spec § operating-day boundary).

```ts
const ORG_TZ_OFFSET_MINUTES = -360 // America/Mexico_City, UTC−06:00, no DST (MVP)

// Resolve query → { date:'YYYY-MM-DD', startSec, endSec } in the org offset.
const resolveDay = (date?: string) => {
  const offsetMs = ORG_TZ_OFFSET_MINUTES * 60_000
  // "now in org-local" → local midnight → back to UTC epoch.
  const day = date ?? new Date(Date.now() + offsetMs).toISOString().slice(0, 10)
  const startUtcMs = Date.parse(`${day}T00:00:00Z`) - offsetMs
  const startSec = Math.floor(startUtcMs / 1000)
  return { date: day, startSec, endSec: startSec + 86_400 }
}
```

> Unit-test `resolveDay` directly against Scenario 10 (a `05:00Z` folio falls on the
> previous local day; `07:00Z` falls on the queried day).

---

## Phase 3 — `getOccupancy` (US-A14, US-A15)

`handler.ts`. Single org-scoped query: active slots on `:date` joined to active services,
ordered `service.name, start_time`. Group in JS, classify status, roll up.

```ts
const ALMOST_FULL_RATIO = 0.2

const classify = (capacity: number, booked: number) => {
  const remaining = Math.max(0, capacity - booked)
  if (capacity === 0 || remaining === 0) return 'full'
  if (remaining / capacity <= ALMOST_FULL_RATIO) return 'almost_full'
  return 'available'
}
```

- Query: `select slot cols + services.name from slots inner join services …
  where slots.organizationId = org and slots.date = day and slots.status='active'
  and services.status='active' order by services.name, slots.startTime`.
- Reduce rows into `services[]` (keyed by `service_id`), pushing serialized slots and
  accumulating the per-service `summary` (capacity/booked/remaining, status counts).
- Accumulate grand `totals`. Return `{ date, services, totals }` (Rules 3–5, 9).

---

## Phase 4 — `getSalesSummary` (US-A16)

`handler.ts`. Reuse the `coalesce(sum(...),0)` / `count(*)` idiom from `cash/handler.ts`,
filtered by `created_at ∈ [startSec, endSec)` and org.

- **Totals (non-cancelled):** one query selecting
  `sum(amount_paid)` total, `count(*)`, and conditional sums for cash vs card
  (`sum(case when payment_method='cash' then amount_paid else 0 end)` etc.) over
  `ne(status,'cancelled')`.
- **Cancelled count:** `count(*)` where `status='cancelled'` in the window (Rule 6).
- **Per-agent:** `select agent_id, count(*), sum(amount_paid) from folios where org and
  window and status != 'cancelled' group by agent_id`; join `users` for `name` (org-scoped);
  order by total desc (Rule 8).
- Return `{ date, total_collected, cash_collected, card_collected, folio_count,
  cancelled_count, per_agent }` (Rules 6–9).

> Money stays integer minor units. Empty day → all zeros, `per_agent: []` (Rule 9).

---

## Phase 5 — Backend tests

`api-guideme/test/dashboard/occupancy-dashboard.test.ts` (Vitest `cloudflare:test`,
`SELF.fetch`, `seedUser`/`seedTwoOrgs`, direct `env.DB.prepare` inserts for slots/folios).

| Scenario | Assertion |
|---|---|
| 1 | grouping + remaining + per-service summary |
| 2 | status thresholds full / almost_full / available |
| 3 | inactive slot & inactive service excluded |
| 4 | `date` defaults to today |
| 5 | empty day → `200` empty arrays |
| 6 | malformed `date` → `400 VALIDATION_ERROR` |
| 7 | totals + cash/card split |
| 8 | cancelled excluded from totals, counted separately |
| 9 | per-agent ordered desc, no-sale agents absent |
| 10 | day boundary honors `ORG_TZ_OFFSET_MINUTES` |
| 11 | empty day → `200` zeros |
| 12 | agent caller → `403 FORBIDDEN` |
| 13 | `seedTwoOrgs` B3/B4 — no cross-org leakage on both endpoints |

Helper to insert a slot/folio with explicit `created_at` for Scenario 10.

---

## Phase 6 — Frontend service + feature

### 6.1 `app-guideme/src/services/dashboardService.ts`
```ts
import { request } from './authService'
import type { Occupancy, SalesSummary } from '../features/dashboard/types'

const qs = (date?: string) => (date ? `?date=${date}` : '')
export const getOccupancy = (date?: string) =>
  request<{ /* Occupancy fields */ }>(`/api/dashboard/occupancy${qs(date)}`)
export const getSalesSummary = (date?: string) =>
  request<SalesSummary>(`/api/dashboard/sales-summary${qs(date)}`)
```

### 6.2 `features/dashboard/`
- `types.ts` — `OccupancyStatus = 'available'|'almost_full'|'full'`, `OccupancySlot`,
  `ServiceOccupancy`, `Occupancy`, `AgentSales`, `SalesSummary`.
- `hooks/useDashboard.ts`:
  ```ts
  export const useOccupancy = (date?: string) =>
    useQuery({ queryKey: ['dashboard','occupancy',date ?? 'today'],
               queryFn: () => getOccupancy(date), refetchInterval: 30_000 }) // US-A15
  export const useSalesSummary = (date?: string) =>
    useQuery({ queryKey: ['dashboard','sales',date ?? 'today'],
               queryFn: () => getSalesSummary(date), refetchInterval: 60_000 })
  ```
- `components/`:
  - `OccupancyStatusChip` — design-system chip: `available` neutral/teal, `almost_full`
    amber, `full` muted error.
  - `ServiceOccupancyCard` — service header w/ summary chip + slot rows (time, remaining/cap).
  - `OccupancyGrid` — maps services; empty state when none.
  - `SalesSummaryCard` — total collected (large), folio count, cash/card split,
    cancelled count.
  - `AgentSalesTable` — per-agent rows (name, folios, collected via `formatMoney`).
  - `DashboardDatePicker` — date selector defaulting to today.
- `index.ts` — public exports.

---

## Phase 7 — `DashboardPage` assembly

Rebuild `app-guideme/src/pages/DashboardPage.tsx`:
- Read `user.role`. For **admin**: render `DashboardDatePicker` (state: selected date,
  default today) + `OccupancyGrid` + `SalesSummaryCard`/`AgentSalesTable`, all driven by the
  selected date. For **agent**: keep the existing lightweight welcome (US-A14/15/16 are admin
  stories; the nav `Dashboard` item is shown to both roles).
- Loading skeletons, error alert, empty states. Page-level `Fade` like other pages.
- No route/nav change needed — `ROUTES.DASHBOARD` and the nav item already exist.

Verify: `pnpm build:app` clean, `pnpm lint:app` 0 errors.

---

## Phase 8 — Docs & wrap-up
- Tick `docs/SPEC.md` SHOULD-HAVE **Occupancy visual dashboard (admin)** with a link here.
- Add `docs/TECH_DEBT.md` entry: fixed `ORG_TZ_OFFSET_MINUTES` (single-market MVP); action
  if revisited → `organizations.timezone` column + per-org day window.

---

## Risks / decisions

- **Timezone (highest-value decision).** A single fixed offset keeps occupancy (date-text)
  and sales (timestamp) on the same calendar day with zero schema change. The seam is
  isolated in `resolveDay` + one constant, so a per-org timezone later is a localized change.
  Documented as TECH_DEBT, not a blocker.
- **Two endpoints vs one composite.** Split lets occupancy poll fast (US-A15 "real-time")
  while the sales summary refreshes lazily — and keeps each handler single-purpose. Costs an
  extra request; negligible.
- **"Real-time" = polling.** MVP uses React Query `refetchInterval` (30s occupancy). No
  websockets/SSE — out of scope, matches the online-only MVP posture.
- **Out of scope guard.** Date-**range** commission reports, agent comparison, and CSV/PDF
  export are US-A17/A18/A20 (separate feature). This dashboard stays single-day + summary.
