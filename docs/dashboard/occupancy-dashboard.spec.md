# Feature: Occupancy Visual Dashboard (admin) — US-A14, US-A15, US-A16

## Context

The admin needs a single **at-a-glance daily control panel** answering three questions for
the current operating day:

- **US-A14** — *the visual occupancy of all active schedules*: which slots are
  **available**, **close to capacity**, or **full**, so the admin can react (open more
  capacity, push a slot, reassign agents).
- **US-A15** — *real-time remaining spots* per service and schedule, kept fresh so the
  number on screen matches what agents see at POS.
- **US-A16** — *the day's sales summary*: total collected, number of folios, and a
  per-agent breakdown.

This is the first real content for `DashboardPage` (today a placeholder). It is a
**read-only, admin-only** surface — no writes, no new tables, no migration. Every number is
**derived live** from the existing `slots`, `folios`, and `users` tables, the same
recompute-on-read discipline already used by the cash running balance
(`docs/cash-drops/agent-balance-cash-drops.spec.md`).

**Builds on:**
- **Slots** (`src/db/schema.ts` → `slots`) — `capacity`, `booked`; `remaining = capacity −
  booked` is already the serializer convention in `services/slots.handler.ts`. Slot `date`
  is `'YYYY-MM-DD'` text, so occupancy filtering for a day is a timezone-free string match.
- **Folios** (`folios`) — `amountPaid`, `status`, `paymentMethod`, `agentId`, `createdAt`.
  The day's sales reuse the same aggregation style as `cash/handler.ts` (`coalesce(sum(...),
  0)` rollups, `ne(status, 'cancelled')`).
- **Users** (`users`) — agent `name` for the per-agent breakdown; org-scoped.
- **Admin router conventions** — mirror `routes/cash/index.ts`: `authMiddleware` on every
  route, then `requireRole('admin')` per route; org scope from `c.get('user')`.

### Scope boundary

| Concern | Owner |
|---|---|
| **Daily occupancy grid + remaining spots** (US-A14, US-A15) | **This feature** |
| **Day's sales summary: total collected, folio count, per-agent** (US-A16) | **This feature** |
| Slot creation / capacity edits | Schedules feature (existing) — dashboard only **reads** |
| Real-time inventory decrement on sale | POS / cancellation (existing) — dashboard reflects it |
| Commission **report** over a date range, agent comparison, CSV/PDF export | US-A17/A18/A20 — separate SHOULD-HAVE feature (`Commission report by period`), **not here**. This dashboard is single-day and summary-only. |
| Agent's own balance / cash | `docs/cash-drops/...` (existing) |

**Two new read endpoints, no new write paths:**
- `GET /api/dashboard/occupancy?date=YYYY-MM-DD` — US-A14, US-A15
- `GET /api/dashboard/sales-summary?date=YYYY-MM-DD` — US-A16

They are split (rather than one composite) so the occupancy view can poll on a short
interval for "real-time" freshness (US-A15) without re-running the sales aggregation.

---

## Data Model

**No new tables. No new columns. No migration.** All data already exists:

- `slots`: `id`, `service_id`, `date`, `start_time`, `capacity`, `booked`, `status`
- `services`: `id`, `name`, `status` — to label and group the occupancy grid
- `folios`: `id`, `agent_id`, `amount_paid`, `total`, `status`, `payment_method`, `created_at`
- `users`: `id`, `name`, `role` — agent names for the per-agent breakdown

---

## The operating-day boundary (read carefully)

Two clocks meet in this feature and they must agree on what "today" means:

- **Occupancy** filters `slots.date` — a `'YYYY-MM-DD'` **calendar string**. Timezone-free:
  `where date = :date`.
- **Sales summary** filters `folios.created_at` — a **unix timestamp** written in UTC by
  the Worker. Converting a calendar date to a `[start, end)` timestamp window is
  **timezone-dependent**.

To keep both views on the *same* calendar day the admin sees, the server interprets `:date`
in a **fixed organization timezone offset**:

```ts
// America/Mexico_City — UTC−06:00, no DST (Mexico abolished it in 2022). MVP single market.
const ORG_TZ_OFFSET_MINUTES = -360
// [start, end) epoch-second bounds for the local calendar day `date`:
//   startUtc = date 00:00 local → epoch ; endUtc = startUtc + 24h
```

`amountPaid`/`created_at` folios with `created_at ∈ [start, end)` count toward that day.
This is a **documented MVP limitation** (single fixed offset, no per-org timezone) tracked
in `docs/TECH_DEBT.md`; the action-if-revisited is an `organizations.timezone` column.

---

## Business Rules (enforced server-side)

1. **Admin-only, org-scoped.** Both endpoints require `requireRole('admin')`; every query is
   filtered by `organization_id` from the JWT (`c.get('user').organizationId`). An agent
   calling either endpoint gets `403 FORBIDDEN`. Cross-org rows are never returned (B3/B4).

2. **`date` defaults to today, validated.** `?date` is optional `YYYY-MM-DD`
   (`z.string().regex(/^\d{4}-\d{2}-\d{2}$/)`); when omitted, the server uses the current
   day in `ORG_TZ_OFFSET_MINUTES`. A malformed `date` → `400 VALIDATION_ERROR`.

3. **Occupancy lists active slots for the day, grouped by service.** Only `slots.status =
   'active'` slots whose `date = :date` are returned, joined to their service for the name,
   ordered by `service name, start_time`. Inactive slots and inactive services are excluded
   (they cannot be sold today). `remaining = capacity − booked` (never negative in practice;
   clamp to `0` defensively).

4. **Occupancy status classification (US-A14).** Each slot is tagged from its fill ratio:
   - `full` — `remaining === 0`
   - `almost_full` — `remaining > 0` **and** `remaining / capacity ≤ 0.2`
     (`ALMOST_FULL_RATIO = 0.2`, i.e. ≤20% of seats left)
   - `available` — otherwise

   A `capacity === 0` slot (degenerate) is treated as `full`. The ratio is computed
   server-side so the UI and any future alerting agree on a single threshold.

5. **Occupancy per-service rollup.** Alongside each service's slots, return a per-service
   summary (`capacity`, `booked`, `remaining`, slot counts by status) so the UI can show a
   header chip without re-summing on the client.

6. **Sales summary excludes cancelled folios (US-A16).** `total_collected = Σ amount_paid`
   and `folio_count = count(*)` over folios with `status != 'cancelled'` whose `created_at`
   is in the day window. A folio created **and** cancelled the same day is excluded from
   both (its spots are already released, its cash is not "collected"). `cancelled_count` is
   reported **separately** for visibility, not folded into the totals.

7. **Payment-method split.** `total_collected` is also broken into `cash_collected` and
   `card_collected` (US-AG25 distinction) — cheap to compute, useful for the admin and
   consistent with how cash debt is derived elsewhere.

8. **Per-agent breakdown (US-A16).** One row per agent who sold that day: `agent_id`,
   `agent_name`, `folio_count`, `total_collected`, ordered by `total_collected` desc. Agents
   with no sales that day are omitted (the list answers "who sold today", not a roster).
   Built from a single `GROUP BY agent_id` over the day's non-cancelled folios, then joined
   to `users` for names (org-scoped).

9. **Empty day is a valid `200`.** A day with no active slots and/or no folios returns
   `200` with empty arrays and zeroed totals — never `404`. The dashboard renders an empty
   state, not an error.

10. **Read-only & cheap.** No writes. Aggregations are bounded by one org's single day;
    `coalesce(sum(...), 0)` / `count(*)` rollups mirror `cash/handler.ts`. Acceptable at MVP
    scale; no new index required (slot/folio org-scoped scans on a single date are small).

---

## Endpoints

### `GET /api/dashboard/occupancy?date=YYYY-MM-DD` — US-A14, US-A15

Active slots for the day, grouped by service, each with `remaining` and `status`.

**Response `200`:**
```jsonc
{
  "date": "2026-06-06",
  "services": [
    {
      "service_id": "svc_…",
      "service_name": "Canyon Sunrise Tour",
      "summary": {
        "capacity": 30, "booked": 27, "remaining": 3,
        "slot_count": 3, "full": 1, "almost_full": 1, "available": 1
      },
      "slots": [
        { "slot_id": "slt_…", "start_time": "06:00", "capacity": 10,
          "booked": 10, "remaining": 0, "status": "full" },
        { "slot_id": "slt_…", "start_time": "08:00", "capacity": 10,
          "booked": 9,  "remaining": 1, "status": "almost_full" },
        { "slot_id": "slt_…", "start_time": "10:00", "capacity": 10,
          "booked": 8,  "remaining": 2, "status": "available" }
      ]
    }
  ],
  "totals": { "capacity": 30, "booked": 27, "remaining": 3 }
}
```

### `GET /api/dashboard/sales-summary?date=YYYY-MM-DD` — US-A16

The day's collected total, folio count, payment-method split, and per-agent breakdown.

**Response `200`:**
```jsonc
{
  "date": "2026-06-06",
  "total_collected": 184500,
  "cash_collected": 120000,
  "card_collected": 64500,
  "folio_count": 12,
  "cancelled_count": 1,
  "per_agent": [
    { "agent_id": "usr_…", "agent_name": "María", "folio_count": 7, "total_collected": 110000 },
    { "agent_id": "usr_…", "agent_name": "José",  "folio_count": 5, "total_collected": 74500 }
  ]
}
```

All money is integer **minor units** (consistent with the rest of the API).

---

## Error responses

| Code | HTTP | When |
|---|---|---|
| `VALIDATION_ERROR` | 400 | `date` present but not `YYYY-MM-DD` |
| `FORBIDDEN` | 403 | non-admin (agent) caller |
| `UNAUTHORIZED` | 401 | missing/invalid JWT (authMiddleware) |

---

## Scenarios

### US-A14 / US-A15 — Occupancy

#### Scenario 1 — Slots for the day are grouped by service with remaining & status
**Given** an org with a service "Canyon Sunrise" having three active slots today
(capacities 10/10/10, booked 10/9/8)
**When** the admin calls `GET /api/dashboard/occupancy?date=<today>`
**Then** the response groups the three slots under the service, each with the correct
`remaining` (0/1/2) and `status` (`full`/`almost_full`/`available`), plus a per-service
summary `{capacity:30, booked:27, remaining:3}`.

#### Scenario 2 — Status thresholds
**Given** a slot with `capacity:10`
**When** `booked` is 10, 9, and 5
**Then** `status` is `full`, `almost_full` (1/10 = 10% ≤ 20%), and `available` (5/10 = 50%)
respectively.

#### Scenario 3 — Inactive slots and inactive services are excluded
**Given** the day has one active slot and one `status:'inactive'` slot, and an inactive
service with active slots
**When** the admin loads occupancy
**Then** only the active slot of the active service appears.

#### Scenario 4 — `date` defaults to today
**Given** no `date` query param
**When** the admin calls `GET /api/dashboard/occupancy`
**Then** the server uses the current day in `ORG_TZ_OFFSET_MINUTES` and returns that day's
slots; the response echoes the resolved `date`.

#### Scenario 5 — Empty day → 200 with empty arrays
**Given** an org with no active slots on the requested date
**When** the admin loads occupancy
**Then** the response is `200` with `services: []` and zeroed `totals` (not `404`).

#### Scenario 6 — Malformed date → 400
**Given** `?date=06-06-2026`
**When** the admin loads occupancy
**Then** the response is `400 VALIDATION_ERROR`.

### US-A16 — Sales summary

#### Scenario 7 — Totals, count, and payment split for the day
**Given** today: a 1200 cash folio, a 600 card folio, both `paid`
**When** the admin calls `GET /api/dashboard/sales-summary?date=<today>`
**Then** `total_collected = 1800`, `cash_collected = 1200`, `card_collected = 600`,
`folio_count = 2`.

#### Scenario 8 — Cancelled folios excluded from totals, surfaced as count
**Given** today: one `paid` 1000 folio and one `cancelled` 500 folio
**When** the admin loads the sales summary
**Then** `total_collected = 1000`, `folio_count = 1`, `cancelled_count = 1`.

#### Scenario 9 — Per-agent breakdown ordered by collected desc
**Given** today: agent María sold 2 folios (1100 total), agent José sold 1 (400)
**When** the admin loads the sales summary
**Then** `per_agent` lists María then José with their `folio_count` and `total_collected`;
agents with no sales today are absent.

#### Scenario 10 — Day boundary respects the org offset
**Given** a folio created at `2026-06-06T05:00:00Z` (i.e. `2026-06-05` 23:00 local at
UTC−06:00)
**When** the admin requests `?date=2026-06-06`
**Then** that folio is **not** counted (it belongs to the previous local day); a folio at
`2026-06-06T07:00:00Z` (01:00 local) **is** counted.

#### Scenario 11 — Empty day → 200 zeros
**Given** an org with no folios on the date
**When** the admin loads the sales summary
**Then** the response is `200` with all totals `0`, `per_agent: []`.

### Roles

#### Scenario 12 — Agent is forbidden
**Given** an authenticated **agent**
**When** they call either dashboard endpoint
**Then** the response is `403 FORBIDDEN`.

### Multitenancy isolation (required — `seedTwoOrgs`)

#### Scenario 13 — B3/B4: cross-org slots and folios are invisible
**Given** org A has slots and folios today, org B's admin queries the same date
**When** org B's admin loads both endpoints
**Then** none of org A's slots, totals, or agents appear; org B sees only its own data
(empty if it has none).

---

## Definition of Done

### Backend
- [ ] `src/routes/dashboard/` created: `index.ts` (admin router, `authMiddleware` +
      `requireRole('admin')` per route), `handler.ts`, `schema.ts` (`dateQuerySchema`)
- [ ] Router mounted at `app.route('/api/dashboard', dashboardRouter)` in `src/index.tsx`
- [ ] `getOccupancy` handler: active slots for `:date` joined to active services, grouped,
      with `remaining`, per-slot `status` (Rule 4), per-service + grand `totals` (Rules 3, 5)
- [ ] `getSalesSummary` handler: `coalesce(sum(amount_paid),0)` + `count(*)` over
      non-cancelled folios in the day window, cash/card split (Rule 7), `cancelled_count`,
      and `GROUP BY agent_id` per-agent rollup joined to `users` (Rules 6, 8)
- [ ] Day window derived via `ORG_TZ_OFFSET_MINUTES` shared helper (documented Rule)
- [ ] `date` defaults to today, `YYYY-MM-DD`-validated → `400` on malformed (Rule 2)
- [ ] Empty day returns `200` with empty arrays / zeros (Rule 9)
- [ ] Scenarios 1–13 covered in `test/dashboard/occupancy-dashboard.test.ts`, including the
      role `403` (Scenario 12) and the `seedTwoOrgs` B3/B4 isolation (Scenario 13)
- [ ] `pnpm --filter api-guideme test` green

### Frontend
- [ ] `services/dashboardService.ts`: `getOccupancy(date?)`, `getSalesSummary(date?)`
- [ ] `features/dashboard/`: `types.ts`, `hooks/` (`useOccupancy`, `useSalesSummary` with
      `refetchInterval ≈ 30s` for the "real-time" US-A15 feel), `components/`
      (`OccupancyGrid`, `ServiceOccupancyCard`, `OccupancyStatusChip`, `SalesSummaryCard`,
      `AgentSalesTable`, `DashboardDatePicker`), `index.ts`
- [ ] `DashboardPage.tsx` rebuilt for **admins**: date selector (default today), occupancy
      grid (US-A14/A15) + sales summary card with per-agent table (US-A16); agents keep the
      existing lightweight welcome (these are admin stories)
- [ ] Status chips follow the design system: `available` neutral/teal accent, `almost_full`
      amber, `full` muted/error — restrained, `elevation={0}` cards with `1px` divider border
- [ ] Empty/loading/error states handled; money via existing `formatMoney`
- [ ] `pnpm build:app` clean; `pnpm lint:app` 0 errors

### Docs
- [ ] `docs/SPEC.md` SHOULD-HAVE item ticked: **Occupancy visual dashboard (admin)**
      *(US-A14, US-A15, US-A16)* → link to this spec
- [ ] `docs/TECH_DEBT.md`: new entry for the **fixed single timezone offset**
      (`ORG_TZ_OFFSET_MINUTES`) — acceptable at MVP (single market), action if revisited:
      add an `organizations.timezone` column and derive the day window per org
