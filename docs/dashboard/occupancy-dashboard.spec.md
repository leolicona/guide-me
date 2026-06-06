# Feature: Daily Operations Dashboard — US-A14, US-A15, US-A16, US-AG26

> Formerly "Occupancy visual dashboard." Renamed to reflect its real job: the admin's daily
> command center across **three pillars — Capacity, Sales, Cash position — plus an attention
> strip** of exceptions. US-A14/A15/A16 map onto Capacity and Sales; the Cash pillar and the
> attention strip realize the cash-drops spec's intent that *"the day becomes a reporting lens
> over folios + drops"* (`docs/cash-drops/agent-balance-cash-drops.spec.md`, scope table).

## Context

When the admin opens the app they are answering one question: **"Is my operation healthy
right now, and what needs me?"** Three sub-questions compose it, and the SPEC vision (prevent
overbooking, control commissions, **end untraceable cash**) lives entirely inside them:

- **Capacity** — *will I over/undersell today?* (US-A14 occupancy status, US-A15 remaining
  spots) — reframed commercially as **unrealized revenue**.
- **Sales** — *is the day performing?* (US-A16 total collected, folio count, per-agent) —
  with a single **comparison anchor** (vs. yesterday / same-weekday) so a number has meaning.
- **Cash position** — *where is my cash and what must I settle?* The intersection with
  cash-drops: today's collected cash is **new cash exposure** agents now owe; the per-agent
  view puts today's **flow** next to each agent's live **balance held** and **pending drops**.

Above all three sits an **attention strip**: the exceptions, pulled to the top, each
deep-linking into the feature that owns the action (no writes happen here).

This is a **read-only** surface. It introduces **no new tables, no migration, and no new
write paths**. Every number is **derived live** from existing data, the same
recompute-on-read discipline as the cash running balance. Crucially, it **composes existing
endpoints** rather than re-deriving owned data (see § Architecture).

### Architecture — composition over duplication

The dashboard's own backend touches only `slots` + `folios` (+ `services`/`users` for
labels). It does **not** re-derive cash balances or read `cash_drops`. Instead:

| Pillar | Source | Owner |
|---|---|---|
| Capacity (US-A14/A15) | `GET /api/dashboard/occupancy` *(new)* | this feature |
| Sales (US-A16) | `GET /api/dashboard/sales-summary` *(new)* | this feature |
| **Cash position** (the bridge) | **`GET /api/cash/balances`** *(existing, US-A19)* | **cash-drops feature** |
| Agent's own day | `GET /api/dashboard/me` *(new, agent)* | this feature |
| Agent's own balance / drop CTA | **`GET /api/cash/me`** *(existing)* + register-drop flow | **cash-drops feature** |

The **cash-exposure bridge** and the **attention strip** are assembled **client-side**: the
admin page fetches sales-summary + occupancy + `/api/cash/balances`, joins per-agent rows by
`agent_id`, and renders the exception signals. `deriveBalance` stays single-sourced in
`cash/handler.ts`; cash data stays owned by the cash feature.

### Scope boundary (hold this line)

| Concern | Owner |
|---|---|
| Daily occupancy grid, remaining spots, revenue potential (US-A14/A15) | **This feature** |
| Day's sales: total, folio count, per-agent, payment split, **one** comparison anchor (US-A16) | **This feature** |
| Agent's own single-day sales lens + balance CTA | **This feature** (composes cash `/me`) |
| Per-agent **balance / pending drops** numbers | **cash-drops** (US-A19) — dashboard reuses, never re-derives |
| Slot creation / capacity edits, schedules | Schedules feature — dashboard **links** to it |
| Confirming drops, payouts | cash-drops (US-A19/A25) — dashboard **deep-links** to it |
| **Date-range** reports, agent comparison over periods, CSV/PDF export | **US-A17/A18/A20** — separate feature. The dashboard is **single-day**; the comparison anchor is the *only* time element. |

**New endpoints (all read-only):**
- `GET /api/dashboard/occupancy?date=YYYY-MM-DD` — admin — US-A14, US-A15
- `GET /api/dashboard/sales-summary?date=YYYY-MM-DD` — admin — US-A16
- `GET /api/dashboard/me?date=YYYY-MM-DD` — agent — agent's own day

Split so Capacity can poll on a short interval for "real-time" freshness (US-A15) without
re-running the sales aggregation.

---

## Data Model

**No new tables. No new columns. No migration.** Reads only:

- `slots`: `service_id`, `date`, `start_time`, `capacity`, `booked`, `status`
- `services`: `name`, `base_price`, `status` — label, group, and **revenue potential**
- `folios`: `agent_id`, `amount_paid`, `status`, `payment_method`, `commission_amount`, `created_at`
- `users`: `id`, `name`, `role` — agent names (org-scoped)
- *(cash position is read via the existing `/api/cash/*` endpoints, not from this schema)*

---

## The operating-day boundary (read carefully)

Two clocks meet and must agree on "today":

- **Occupancy** filters `slots.date` — a `'YYYY-MM-DD'` calendar string. Timezone-free.
- **Sales / comparison** filter `folios.created_at` — a UTC unix timestamp. Converting a
  calendar date to a `[start, end)` window is timezone-dependent.

The server interprets `:date` in a **fixed organization timezone offset** so both pillars sit
on the same calendar day:

```ts
// America/Mexico_City — UTC−06:00, no DST (Mexico abolished it in 2022). MVP single market.
const ORG_TZ_OFFSET_MINUTES = -360
```

Documented MVP limitation tracked in `docs/TECH_DEBT.md`; action-if-revisited: an
`organizations.timezone` column. The day-bucket math also powers the comparison anchor
(SQL: `cast((created_at + :offsetSec) / 86400 as integer)` → local epoch-day).

---

## Business Rules (enforced server-side)

1. **Admin-only / agent-self, org-scoped.** `occupancy` and `sales-summary` require
   `requireRole('admin')`; `me` requires `requireRole('agent')` and is scoped to the caller.
   Every query filters `organization_id` from the JWT. Wrong role → `403 FORBIDDEN`. Cross-org
   rows never returned (B3/B4).

2. **`date` defaults to today, validated.** Optional `?date=YYYY-MM-DD`
   (`z.string().regex(/^\d{4}-\d{2}-\d{2}$/)`); absent → current day in `ORG_TZ_OFFSET_MINUTES`.
   Malformed → `400 VALIDATION_ERROR`.

3. **Occupancy lists active slots for the day, grouped by service.** Only `slots.status =
   'active'` with `date = :date`, joined to **active** services, ordered `service name,
   start_time`. `remaining = max(0, capacity − booked)`.

4. **Occupancy status (US-A14).** Per slot, from fill ratio:
   - `full` — `remaining === 0` (or `capacity === 0`)
   - `almost_full` — `remaining > 0` and `remaining / capacity ≤ 0.2` (`ALMOST_FULL_RATIO = 0.2`)
   - `available` — otherwise

   Classification is server-side so UI, attention strip, and any future alerting share one threshold.

5. **Revenue potential (commercial occupancy, US-A15).** Each slot carries
   `potential_revenue = remaining × service.base_price` (minor units) — the unrealized upside
   of empty seats. Rolled up per service and grand-total. `full` slots contribute `0` (sold
   out = realized, surfaced as a win, not a gap). This reframes "remaining spots" from an
   operational count into a commercial signal.

6. **Per-service & grand rollups.** Each service returns `{capacity, booked, remaining,
   potential_revenue, slot_count, full, almost_full, available}`; grand `totals` mirror it +
   `full_count` / `almost_full_count` (the attention strip reads these — no client re-sum).

7. **Sales summary excludes cancelled folios (US-A16).** `total_collected = Σ amount_paid`,
   `folio_count = count(*)`, over `status != 'cancelled'` in the day window. A same-day-cancelled
   folio is excluded from both (spots released, cash not "collected"); `cancelled_count` is
   reported **separately**, never folded in.

8. **Payment split = new cash exposure.** `total_collected` splits into `cash_collected` and
   `card_collected`. `cash_collected` is the **new cash agents now owe** (it grows their
   running balance and must eventually be dropped, per cash-drops Rule 1); `card_collected`
   earns commission but adds no cash debt (US-AG24). The UI labels it as such.

9. **Comparison anchor (US-A16, the *only* time element).** `sales-summary` returns a
   `comparison` block: `previous_day_total`, `weekday_avg` (mean `total_collected` of the
   prior 4 same-weekday days, cancelled excluded), and `spark` (last 7 local days'
   `[{date, total}]`) for a sparkline. One bounded `GROUP BY local-epoch-day` query over a
   trailing 28-day window. This is the ceiling — **date-range reports / agent comparison /
   export are US-A17/A18/A20**, not here.

10. **Per-agent breakdown is the day lens only (US-A16).** One row per agent who sold that
    day: `agent_id`, `agent_name`, `folio_count`, `total_collected`, `cash_collected`,
    ordered by `total_collected` desc; no-sale agents omitted. The **balance / pending-drops
    columns are joined client-side** from `/api/cash/balances` — this endpoint does **not**
    re-derive them (composition, § Architecture).

11. **Agent `me` day lens.** `GET /api/dashboard/me` returns the caller's own
    `{folio_count, total_collected, cash_collected, commission_earned}` for the day. Balance,
    expenses, drops, and the register-drop CTA come from the existing `/api/cash/me` — not
    duplicated here.

12. **Empty day is a valid `200`.** No slots / no folios → `200` with empty arrays and zeroed
    totals (comparison `spark` may be all-zero), never `404`.

13. **Read-only & cheap.** No writes. Org-scoped single-day scans + one bounded 28-day rollup;
    no new index required.

---

## Endpoints

### `GET /api/dashboard/occupancy?date=YYYY-MM-DD` — US-A14, US-A15

```jsonc
{
  "date": "2026-06-06",
  "services": [
    {
      "service_id": "svc_…",
      "service_name": "Canyon Sunrise Tour",
      "base_price": 60000,
      "summary": { "capacity": 30, "booked": 27, "remaining": 3,
                   "potential_revenue": 180000,
                   "slot_count": 3, "full": 1, "almost_full": 1, "available": 1 },
      "slots": [
        { "slot_id": "slt_…", "start_time": "06:00", "capacity": 10, "booked": 10,
          "remaining": 0, "potential_revenue": 0,      "status": "full" },
        { "slot_id": "slt_…", "start_time": "08:00", "capacity": 10, "booked": 9,
          "remaining": 1, "potential_revenue": 60000,  "status": "almost_full" },
        { "slot_id": "slt_…", "start_time": "10:00", "capacity": 10, "booked": 8,
          "remaining": 2, "potential_revenue": 120000, "status": "available" }
      ]
    }
  ],
  "totals": { "capacity": 30, "booked": 27, "remaining": 3,
              "potential_revenue": 180000, "full_count": 1, "almost_full_count": 1 }
}
```

### `GET /api/dashboard/sales-summary?date=YYYY-MM-DD` — US-A16

```jsonc
{
  "date": "2026-06-06",
  "total_collected": 184500,
  "cash_collected": 120000,
  "card_collected": 64500,
  "folio_count": 12,
  "cancelled_count": 1,
  "comparison": {
    "previous_day_total": 150000,
    "weekday_avg": 172000,
    "spark": [ { "date": "2026-05-31", "total": 90000 }, { "date": "2026-06-01", "total": 0 },
               { "date": "2026-06-02", "total": 120000 }, "…7 days total" ]
  },
  "per_agent": [
    { "agent_id": "usr_…", "agent_name": "María", "folio_count": 7,
      "total_collected": 110000, "cash_collected": 90000 },
    { "agent_id": "usr_…", "agent_name": "José",  "folio_count": 5,
      "total_collected": 74500,  "cash_collected": 30000 }
  ]
}
```
The admin page joins each `per_agent` row with `/api/cash/balances` by `agent_id` to add the
**balance held** and **pending drops** columns (cash-exposure bridge).

### `GET /api/dashboard/me?date=YYYY-MM-DD` — agent's own day

```jsonc
{ "date": "2026-06-06",
  "today": { "folio_count": 7, "total_collected": 110000,
             "cash_collected": 90000, "commission_earned": 8800 } }
```
The agent page pairs this with `/api/cash/me` (balance + register-drop CTA).

All money is integer **minor units**.

---

## Error responses

| Code | HTTP | When |
|---|---|---|
| `VALIDATION_ERROR` | 400 | `date` present but not `YYYY-MM-DD` |
| `FORBIDDEN` | 403 | wrong role (agent → admin route, admin → `/me`) |
| `UNAUTHORIZED` | 401 | missing/invalid JWT |

---

## Scenarios

### US-A14 / US-A15 — Capacity (occupancy + revenue potential)

#### Scenario 1 — Slots grouped by service with remaining, status, and revenue potential
**Given** a service "Canyon Sunrise" (`base_price 60000`) with three active slots today
(cap 10/10/10, booked 10/9/8)
**When** the admin `GET /api/dashboard/occupancy?date=<today>`
**Then** the three slots group under the service with `remaining` 0/1/2, `status`
`full`/`almost_full`/`available`, `potential_revenue` 0/60000/120000, and a per-service
`summary.potential_revenue = 180000`.

#### Scenario 2 — Status thresholds
**Given** `capacity:10` **When** `booked` is 10, 9, 5 **Then** `status` is `full`,
`almost_full` (10%≤20%), `available` (50%).

#### Scenario 3 — Inactive slots and inactive services excluded
Only active slots of active services appear.

#### Scenario 4 — `date` defaults to today
No `?date` → server uses current day in `ORG_TZ_OFFSET_MINUTES`; response echoes resolved `date`.

#### Scenario 5 — Empty day → `200` empty arrays
No active slots → `200`, `services: []`, zeroed `totals` (incl. `potential_revenue: 0`), not `404`.

#### Scenario 6 — Malformed date → `400`
`?date=06-06-2026` → `400 VALIDATION_ERROR`.

### US-A16 — Sales summary + comparison

#### Scenario 7 — Totals, count, payment split
Today: a 1200 cash + a 600 card folio, both `paid` → `total_collected 1800`,
`cash_collected 1200`, `card_collected 600`, `folio_count 2`.

#### Scenario 8 — Cancelled excluded from totals, surfaced as count
Today: one `paid` 1000 + one `cancelled` 500 → `total_collected 1000`, `folio_count 1`,
`cancelled_count 1`.

#### Scenario 9 — Per-agent breakdown, day lens, ordered desc
María 2 folios/1100, José 1/400 → `per_agent` lists María then José with `cash_collected`;
no-sale agents absent. (Balance/pending columns are *not* in this payload — joined client-side.)

#### Scenario 10 — Day boundary honors the offset
A folio at `2026-06-06T05:00:00Z` (23:00 local prev day) is **not** counted for
`?date=2026-06-06`; one at `2026-06-06T07:00:00Z` (01:00 local) **is**.

#### Scenario 11 — Comparison anchor
**Given** known daily totals across the trailing week/4 same-weekdays
**When** the admin loads the sales summary
**Then** `comparison.previous_day_total`, `comparison.weekday_avg`, and a 7-entry
`comparison.spark` are returned, each computed from non-cancelled folios in the local-day
buckets.

#### Scenario 12 — Empty day → `200` zeros
No folios → all totals `0`, `per_agent: []`, `spark` entries `0`.

### Agent day lens (US-AG26)

#### Scenario 13 — Agent sees only their own day
**Given** an agent with 7 folios today (110000 collected, 90000 cash)
**When** they `GET /api/dashboard/me?date=<today>`
**Then** `today.folio_count = 7`, `total_collected = 110000`, `cash_collected = 90000`,
`commission_earned` = Σ their `commission_amount` that day; no other agent's data appears.

### Roles

#### Scenario 14 — Wrong role → `403`
An agent calling `occupancy`/`sales-summary`, or an admin calling `/me`, → `403 FORBIDDEN`.

### Multitenancy isolation (required — `seedTwoOrgs`)

#### Scenario 15 — B3/B4: cross-org slots/folios invisible
Org A has slots+folios today; org B's admin loads all endpoints → none of org A's slots,
totals, agents, or comparison data appear; org B sees only its own (empty if none).

---

## Definition of Done

### Backend
- [ ] `src/routes/dashboard/` (`index.ts`, `handler.ts`, `schema.ts`) mounted at
      `/api/dashboard`; `authMiddleware` on `*`, `requireRole('admin')` on occupancy &
      sales-summary, `requireRole('agent')` on `/me`; `dateQuerySchema` validates `?date`
- [ ] `getOccupancy`: active slots for `:date` × active services, grouped, `remaining`,
      per-slot `status` (Rule 4) + `potential_revenue` (Rule 5), per-service & grand rollups
      incl. `full_count`/`almost_full_count` (Rule 6)
- [ ] `getSalesSummary`: non-cancelled day totals, cash/card split (Rule 8), `cancelled_count`,
      `GROUP BY agent_id` per-agent day lens (Rule 10), and the `comparison` block from one
      bounded 28-day local-epoch-day rollup (Rule 9)
- [ ] `getMyDay` (agent): caller-scoped day `{folio_count, total_collected, cash_collected,
      commission_earned}` (Rule 11)
- [ ] **No** cash-balance derivation or `cash_drops` reads in this router (composition, § Architecture)
- [ ] Day window + comparison buckets via shared `ORG_TZ_OFFSET_MINUTES` helper; `date`
      defaults to today, validated; empty day → `200` zeros (Rules 2, 12)
- [ ] Scenarios 1–15 in `test/dashboard/occupancy-dashboard.test.ts`, incl. role `403` (14)
      and `seedTwoOrgs` B3/B4 (15)
- [ ] `pnpm --filter api-guideme test` green

### Frontend
- [ ] `services/dashboardService.ts`: `getOccupancy`, `getSalesSummary`, `getMyDay`
- [ ] `features/dashboard/`: `types.ts`; hooks (`useOccupancy` `refetchInterval≈30s` for
      US-A15, `useSalesSummary` ≈60s, `useMyDay`); components — `AttentionStrip`,
      `OccupancyGrid`/`ServiceOccupancyCard`/`OccupancyStatusChip`, `SalesSummaryCard`
      (with `SalesSparkline` + comparison delta), `AgentSalesTable`, `DashboardDatePicker`,
      and agent `MyDayCard`
- [ ] **Cash-exposure bridge:** admin `AgentSalesTable` joins `/api/cash/balances`
      (reuse `useBalances`) by `agent_id` to show **balance held** + **pending drops** columns
- [ ] **Attention strip:** composed client-side from occupancy (`full_count`/`almost_full_count`),
      `/api/cash/balances` (pending-drops total/count, negative-balance agents), each chip
      **deep-linking** to `/cash/drops`, `/catalog` (schedules), etc. — no writes
- [ ] **Commercial occupancy:** show `potential_revenue` per service/total; `full` framed as a win
- [ ] **Comparison anchor:** sparkline + "vs. yesterday / weekday avg" delta on the sales card
- [ ] `DashboardPage` for **admin**: date picker (default today) → attention strip + Capacity
      grid + Sales card + per-agent table (with cash bridge)
- [ ] `DashboardPage` for **agent** (US-AG26): `MyDayCard` (today's sales) + running balance
      (`/api/cash/me`) + one-tap **register cash drop** CTA (reuses existing drop flow) — replaces
      the placeholder
- [ ] Status/attention chips follow the design system (restrained palette, `elevation={0}`,
      `1px` divider); empty/loading/error states; money via `formatMoney`
- [ ] `pnpm build:app` clean; `pnpm lint:app` 0 errors

### Docs
- [ ] `docs/SPEC.md` SHOULD-HAVE **Occupancy visual dashboard (admin)** *(US-A14/A15/A16)*
      ticked → link to this spec (note the broadened "Daily Operations Dashboard" scope)
- [ ] `docs/TECH_DEBT.md`: fixed `ORG_TZ_OFFSET_MINUTES` (single-market MVP) → action:
      `organizations.timezone` column + per-org day window
