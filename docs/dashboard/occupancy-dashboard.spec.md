# Feature: Daily Operations Dashboard — «Hoy» answers how today is going

> **Status: BUILT** — shipped in #103, read at 390 px in #104, and **revised by the timeline pass**
> (Rev. 2026-08-14: D9 and D12 amended, D17–D22 added — the two departure cards became one axis).
> Delivers **US-A14**, **US-A16** and **US-A90**; delivers
> **US-A15 partially** (the count ships, the unrealized-revenue reading is deferred — D8, and the
> story carries the amendment in `SPEC.md`). Replaces the interim queue-card *Hoy*
> (`docs/navigation/role-based-ia-reorganization.md` Phase 2 / G3). US-AG26 (the agent's daily
> snapshot) is **split out** of the Phase-2 bundle into its own later story — D4.
>
> Process: `docs/PROCESS.md`.

## Context

The admin's *Hoy* is five pending-work cards and nothing else. It says who owes work
(*Cancelaciones · Entregas · Reembolsos · Vencidos · Boletos*) and stays silent on the two
questions a field operator actually opens the app with: **how full are today's departures**, and
**how much money has come in today**. `DashboardPage.tsx`'s own header comment calls itself
interim and points here.

The occupancy half has been registered since the MVP and never specced — `SPEC.md` carries
US-A14/A15/A16 under *Dashboard and Monitoring* and two *Features by Phase* entries reading
**"spec not written yet"**. Meanwhile the corpus keeps deferring *to* it:

- `api-turistear/src/routes/folios/handler.ts:406` — the folio list row is deliberately lean,
  *"not a sales dashboard (that is the occupancy-dashboard feature)"*.
- `docs/cancellation/total-folio-cancellation.spec.md:61` and
  `docs/cash-drops/agent-balance-cash-drops.spec.md:69` — both defer org-wide day reads here.
- `docs/folios/folio-state-machine.spec.md:685` — open question: *"Does the wasted-seat report
  belong on the dashboard rather than under Reports?"* (answered here by US-A90).

And the data read does not exist: slots are only readable **per service**
(`GET /api/services/:id/slots`), so "how full is today" costs one catalog navigation per service —
N round-trips for N services, none of them aggregated. There is also **no freshness convention**
anywhere in the app: zero `refetchInterval`, no SSE, no polling — a second seller's sale is
invisible until a mutation of your own happens to invalidate the cache.

## Scope boundary

Mechanically checkable:

- **No migration, no new column, no new mutation endpoint.** The feature is one new read
  (`GET /api/dashboard/day`) plus one page rewrite. Reverting it deletes a route and a page diff
  and changes not one row.
- **Every existing test passes unedited.** In particular the US-A84 counts tests: the
  `GET /api/folios/counts` response shape is untouched — the pills on *Hoy* consume it as-is.
- **`slots.booked` / `slots.capacity` remain written only by their existing mutation points**
  (confirm, cancel, void, expiry, zone reconcile). This feature only reads them.
- **POS sellability semantics are untouched** — the dashboard displays occupancy; it never
  decides what may be sold. Sales-cutoff offsets (US-A47) are deliberately not applied here.

## Design decisions

| # | Decision | Why |
|---|---|---|
| **D1** | This **is** the Phase-2 Daily Operations Dashboard: it delivers US-A14/A16 (+ US-A90), replaces the interim queue-card `DashboardPage`, and lives at `/dashboard` as *Hoy*. | The feature has been registered since the MVP; a second dashboard beside *Hoy* would fragment the concept-named nav (US-UX02). |
| **D2** | **"Vendidos" is occupancy**: the primary numbers come from `slots.booked` / `capacity`, with a *vendidos / apartados* split shown alongside, derived from the lines' money state. | A held seat is genuinely unsellable, so `booked` is the availability truth the POS already obeys; the split keeps the admin honest about which of those seats are actually collected money. |
| **D3** | **"Real-time" = polling**: TanStack Query `refetchInterval` of 60 s on the dashboard read (and on `useFolioCounts` while *Hoy* is mounted), plus refetch on window focus. This is the codebase's **first polling convention**. | Seats change at human sales speed — a 30–60 s stale count is operationally identical to live. True push (SSE/Durable Objects) is a major architectural commitment a count does not justify on a Workers + D1 stack. |
| **D4** | **Admin-only.** Agents and affiliates keep landing on `/pos`; US-AG26 folds into the agent's Caja as **its own later story**, not this one. | Upholds the standing IA decision (`role-based-ia-reorganization.md` Q3); one worktree, one concern. |
| **D5** | Window: **org-tz today** by default, with the shipped quick-day strip (HOY + next 2 days + calendar sheet) to peek ahead. | Reuses the exact control agents already know (US-AG35/US-A45) and the 3-day window convention; "upcoming" beyond that lives in the POS calendar. |
| **D6** | **Slot-based departures only.** Zoned services appear as their reconciled slot totals; **lodging occupancy is a named deferral**. | `slots.capacity/booked` are already reconciled as the SUM over active `slot_zones` (`zones.reconcile.ts`), so zoned services cost nothing. Stays have no slots at all — a "rooms occupied tonight" model is its own feature, not a forced fit. |
| **D7** | Pending-task shortcuts = the **`PendingWorkBar` pills**, reused from `/folios`, fed by `GET /api/folios/counts`; the five `QueueCard`s are **deleted**. | One component models "pending work" everywhere, so the count and the destination can never disagree — the US-A84 rule. Pills free the screen's prime space for the occupancy list. |
| **D8** | **US-A15's unrealized-revenue reading is deferred.** The remaining-spots count ships; the money reading (`remaining × base_price`) does not. The story is amended openly in `SPEC.md`. | Product call from the design interview. It is one multiplication away when wanted (see *Deferred*), and naming the deferral is what PROCESS.md demands — silence is how the index rots. |
| **D9** ~~*(superseded — see D9-rev)*~~ | Today's **departed** slots move out of the occupancy list into a separate **«Ya partieron»** section, showing *abordaron / vendidos / sin usar* from `folio_lines.redeemed_count` (the US-A85 fulfilment math — derived, never stored). | A no-show discovered at 2 PM is actionable — the seller can call, the admin can resell tomorrow's hold; one discovered in next week's wasted-seats report is trivia. Separating the sections keeps what is still sellable on top. |
| **D9-rev** | The two sections become **one chronological timeline** in a single card titled **«Salidas»**: departed rows sit above an **«Ahora» marker**, upcoming below. The boarding data and the collapse behaviour of D9 are unchanged — only the container is. | "Already departed" is not a category a slot belongs to, it is a **relation between the slot and now**; modelling it as an axis rather than a second card is what makes the relation visible. It also removed a whole bug class rather than patching one: the shipped page fed the departed card from the *today* query unconditionally, so peeking at tomorrow rendered today's departures under tomorrow's list with nothing saying so. On an axis, a future day has nothing above the marker **by construction** — there is no state left to get wrong. |
| **D10** | Sales summary = **money received today**: the net SUM of signed `folio_payments` rows with `entry_type IN ('payment','refund')` whose `created_at` falls in the org-tz day. The count of **folios created today** is shown separately, labeled as such. | `folio_payments.created_at` is the money's *own* date by design (deposit=confirm, balance=settle, refund=hand-back), so this figure can never disagree with Caja — a settle today of last week's apartado is today's money, and a refund handed back today subtracts. Summing folio totals instead would count money not yet collected and miss today's settles. |
| **D11** | Traffic light on capacity: **green < 80 % booked · amber ≥ 80 % · red at booked ≥ capacity**, with a small **«+N extra»** hint when a flexible service still has sellable margin. Thresholds computed client-side from the returned numbers. | One org-agnostic rule, stated once. Red-on-base-capacity is deliberate: a slot in its flex margin is the thing an ops admin most wants to notice, and the hint mirrors the POS's existing «Usando X cupos extra» vocabulary. Icon-paired per `DESIGN_TOKENS.md` §3 — state is never color-alone. |
| **D12** *(amended by D9-rev)* | The day strip re-scopes the **«Salidas» card only** — the whole card, since departed and upcoming are now one list reading one query. The pills and the sales summary stay pinned to today. | "Payments received tomorrow" is always $0 and pending work has no date — re-scoping them would blank or lie. The screen stays *Hoy* with a forward-looking departures peek. The card reading a *single* query is the structural half of the fix: there is no second data source that could still be showing today. |
| **D13** | One new admin-only endpoint, **`GET /api/dashboard/day?date=`**, returns occupancy + departed + sales summary in one payload. The pills keep `GET /api/folios/counts`. | One poll, one org-tz "today" resolution, one place for the query to be right. Splitting per block would re-create the N-reads pattern US-A84 just cleaned up; folding into `/counts` would couple a lean `COUNT(*)` every list hits to a heavy aggregate only *Hoy* needs. |
| **D14** | The per-seller list attributes money by **`folio_payments.collected_by`** (with the operator label via `operator_id` where present), sorted by amount descending. | It is the ledger's own attribution — a settle may differ from the original seller, and D10 chose the ledger's truth. Sale-attribution by `folios.agent_id` remains the commission report's view (US-A17/A18); the two answer different questions. |
| **D15** | The occupancy list is **chronological and flat** — one row per departure ordered by `start_time`, service name on the row. | "What leaves next" is the operational question *Hoy* answers; the POS already offers the grouped-by-service view, and status-grouped ordering would bury the actionable emptiest late slots under full ones that need nothing. |
| **D16** | Transfers still **pending verification count in "collected"**. | The ledger writes the payment row at confirm; verification (US-A67) gates QR and delivery, never the ledger. Excluding them would make *Hoy* disagree with Caja, and the *Por verificar* pill already surfaces them one centimetre above. |

### Timeline revision (Rev. 2026-08-14)

| # | Decision | Why |
|---|---|---|
| **D17** | The merge is **component-side**; `GET /api/dashboard/day` is untouched — same two arrays, same shape, same tests. The client concatenates `departed` then `occupancy`. | The server builds both arrays in ONE `ORDER BY start_time` pass, pushing each row into one or the other, so concatenating in that order restores the original chronology exactly — no re-sort, no endpoint change, no test edit. A display change must not re-open a merged API. |
| **D18** | The **client owns both the marker's clock and the past/upcoming split**, from one org-local `nowHM(tz)` ticking each wall-clock minute (`useOrgClock`). The server's classification is kept only for *what a row shows*, not *which side it is on*. | The marker displays minutes; the poll refreshes every 60 s. Anything shown at a finer resolution than its refresh interval must be derived on the display side, or the two visibly disagree — a 14:30 departure sitting below a marker reading 14:31. One fact, one owner. The clock is *computed during render*, never mirrored into state, so a late-arriving org `tz` is correct on the first render that has it. |
| **D19** | A departed row is de-emphasised in **text only** (name and time to secondary ink); its **chips keep full strength**. A row that crosses the marker between polls keeps its seat line but **loses its chip entirely** until boarding data arrives. | Dimming the whole row would dim the amber *sin usar* chip — the one actionable thing on a finished departure. And an availability chip is a forward-looking claim: a slot that has left may never read "Disponible", not even greyed, so the honest render is no chip at all for the ≤60 s gap. |
| **D20** | The rail **is the time column**: a 1px `grey.200` hairline on the content block's left border, joining across rows into one unbroken spine. No dots. The «Ahora» marker is a 2px ink crossbar starting exactly at the rail's x. | Zero horizontal cost — dots and a separate rail would have taken ~20 px back from the service names #104 just un-truncated. Structure-first (`DESIGN_TOKENS.md` §Elevation): the spine is a border, not ornament, and the marker earns its extra weight by being the only line that must read at a glance in sunlight. |
| **D21** | The past segment is **collapsed by default** behind a ≥48 px button row carrying `N ya partieron` **and** the no-show count, icon-paired amber. It **auto-expands only when nothing is upcoming**; an explicit tap always wins. Rows not yet re-polled contribute no boarding claim — with none known the summary says nothing rather than "todos abordaron". | D9's argument survives the merge: what is still sellable keeps the top. But collapsing must not hide the miss, so the summary carries it — and once the day is over there is no top left to protect, which is exactly when an admin reconciles. |
| **D22** | The card title is the day-agnostic **«Salidas»**, and the «Ahora» marker does not render for a non-today date. The picker's **past-day floor stays** (`PosDatePickerSheet` disables `date < today`). | The strip already names the day; a title changing under the user's thumb is noise. With one card the D9 noun-vs-verb pairing problem simply dissolves — there is no pair left to mismatch. Past days stay out of *Hoy* because the server only computes boarding for today, so a past day would show exactly the numbers you opened it for as blanks; real history is the wasted-seats report's job. |

## Data model

**None.** No migration. Every number derives from tables that exist:

- Occupancy: `slots` (`capacity`, `booked` — for zoned services already reconciled as the SUM over
  active `slot_zones` by `zones.reconcile.ts`), `services` (`is_flexible`, `flex_capacity_pct`).
- The vendidos/apartados split and the departed rows' boarding: `folio_lines` (non-cancelled lines joined by
  `slot_id`; money state *pagada/apartada* derived per `docs/folios/line-autonomy.spec.md`;
  `redeemed_count` for boarded seats).
- Sales summary: `folio_payments` (signed amounts, `entry_type`, `collected_by`, `operator_id`,
  `created_at` = the money's own date).

## Business rules (enforced server-side)

1. **The day resolves in the organization's time zone** (`utils/tz.ts` — `orgToday`, US-A66).
   `?date=` is validated `YYYY-MM-DD`; absent means the org's today. The frontend mirrors the
   default only.
2. **Occupancy rows** are the org's `slots` with `status='active'` on the requested date, joined to
   their service, ordered by `start_time`. Per row: `capacity`, `booked`,
   `remaining = max(0, capacity − booked)`, and for flexible services
   `flex_extra = max(0, floor(capacity × flex_capacity_pct / 100) − max(0, booked − capacity))`.
3. **The split** counts seats on non-cancelled `folio_lines` of the slot: a line whose money state
   derives *pagada* contributes its `quantity` to `vendidos`; *apartada* to `apartados`
   (line-autonomy derivation — never `folios.status`). `vendidos + apartados` may be less than
   `booked` only transiently mid-mutation; `booked` stays the authority for `remaining`.
4. **Departed** — a slot whose `naiveEpoch(date, start_time)` ≤ now (org tz) — is returned in
   `departed[]`, not `occupancy[]`, **only when the requested date is the org's today**; for a
   future date `departed` is empty. Per departed row: `vendidos` (paid seats),
   `abordaron = SUM(redeemed_count)` over its paid lines, `sin_usar = vendidos − abordaron`.
   Sales-cutoff offsets are **not** consulted (scope boundary).
5. **Collected today** = net SUM of `folio_payments.amount` where
   `entry_type IN ('payment','refund')` and `created_at` falls in the requested org-tz day.
   Commission accrual rows (`commission`, `commission_reversal`) are excluded. Verification state
   is ignored (D16).
6. **`folios_created`** = COUNT of the org's folios with `created_at` in the same org-tz day,
   regardless of current status.
7. **Per-seller rows** group rule 5's sum by `collected_by` (label: the user's name; appending the
   operator name when `operator_id` is set), sorted by amount descending. Sellers netting $0 are
   omitted.
8. Every aggregate is **scoped to the caller's organization**; nothing in the payload may derive
   from another org's rows.

## Authorization — who may do this

`requireRole('admin')` on the router, like `/api/folios` and `/api/reports`. Agents, affiliates
and operators receive `403 FORBIDDEN` from the existing middleware. There is no per-record id in
the surface, so the cross-org posture is isolation of the aggregates themselves (S-9).

## API surface

### `GET /api/dashboard/day?date=YYYY-MM-DD`

`date` optional; default = the org's today. All money in minor units (cents).

```jsonc
{
  "date": "2026-08-13",
  "occupancy": [
    {
      "slot_id": "…", "service_id": "…", "service_name": "Tour Amanecer Cañón",
      "start_time": "09:00",
      "capacity": 20, "booked": 17, "remaining": 3,
      "vendidos": 14, "apartados": 3,
      "is_flexible": true, "flex_extra": 2
    }
  ],
  "departed": [        // only when date = org today; chronological
    {
      "slot_id": "…", "service_name": "Tour Amanecer Cañón", "start_time": "07:00",
      "vendidos": 18, "abordaron": 16, "sin_usar": 2
    }
  ],
  "sales": {
    "collected_cents": 1845000,
    "folios_created": 23,
    "per_seller": [
      { "user_id": "…", "name": "Laura", "operator_name": null, "collected_cents": 902000 }
    ]
  }
}
```

Server-derived, therefore no request body at all: this surface is a pure read.

### Error responses

| Code | HTTP | When |
|---|---|---|
| `VALIDATION_ERROR` | 400 | `date` present but not `YYYY-MM-DD` *(400, not 422 — the routers' shared `validationHook` convention for malformed params; 422 is reserved for semantic rejections)* |
| `FORBIDDEN` | 403 | caller is not `admin` (existing role middleware) |

## Frontend

**`pages/DashboardPage.tsx` is rewritten** (the interim version's five stacked cards go away;
`QueueCard` and its usages are deleted). Top to bottom:

1. **`PendingWorkBar`** (reused from `features/folios`) — pills apply nothing in place here;
   each deep-links to its `/folios?estado=` facet exactly as the QueueCards did. Only non-zero
   counts render.
2. **Sales summary** — `SectionCard` with `MoneyText` for *Cobrado hoy*, the *folios de hoy*
   count, and the compact per-seller list (D14).
3. **«Salidas» — the departures timeline** (`DeparturesTimeline.tsx`, D9-rev): the quick-day strip
   (reusing the US-AG35 pieces: `FilterStrip` + `PosDatePickerSheet` +
   `GET /api/pos/availability/days`) above one `SectionCard` holding the whole day on one axis —
   collapsed past summary (D21) · departed rows · **«Ahora» crossbar** (D18, today only) ·
   upcoming rows, all chronological (D15). Traffic light per D11 on upcoming rows only, suppressed
   once a row is past (D19): functional colors, icon-paired, cited from `DESIGN_TOKENS.md` §3 —
   never restated as hex.

Nothing truncates: the name wraps and the semáforo chip drops below the numbers when the width
runs out, because a departure the admin cannot name is the one thing this screen exists to
prevent. The rail costs no width because it *is* the time column (D20).

**Pure module** `features/dashboard/timeline.ts` — `timelineItems(day)` (the D17 concatenation)
and `hasDeparted(item, now, isToday)` (the D18 predicate that decides which side of the marker a
row lands on). Kept out of the component so the rule is testable and stated once.

**New hook** `features/dashboard/hooks/useDashboardDay.ts` — `refetchInterval: 60_000` +
`refetchOnWindowFocus`; the same interval is applied to `useFolioCounts` while *Hoy* is mounted.
This is the app's first polling convention; the spec, not the code comment, is its record.

## Scenarios

### US-A14 — occupancy traffic light

**S-1 — the three states render from the numbers**
Given today has slots booked 5/20, 17/20 and 20/20
When the admin opens *Hoy*
Then the rows read green (available), amber (≥ 80 %), red (full), in `start_time` order, each
state icon-paired.

**S-2 — a flexible slot full on base capacity shows its margin**
Given a service with `flex_capacity_pct = 10` and a slot booked 20/20
When the dashboard is read
Then the row is red with `flex_extra = 2` («+2 extra») — full on base, honest about the margin.

**S-3 — a zoned service shows reconciled totals**
Given a zoned service whose slot totals are reconciled from `slot_zones` (18 booked of 26 across
zones)
When the dashboard is read
Then the row shows 18/26 — one row, no per-zone breakdown (D6).

### US-A15 — spots remaining (count; revenue deferred by D8)

**S-4 — remaining is the sellable truth**
Given a slot with capacity 20, booked 17 (14 paid seats + 3 apartado seats on its lines)
When the dashboard is read
Then `remaining = 3` and the split reads `vendidos 14 · apartados 3` — a held seat never counts
as available.

**S-5 — a fresher read within a minute**
Given the admin keeps *Hoy* open and another seller confirms a 2-seat sale
When the 60 s poll fires
Then the row's `booked`/`remaining` reflect the sale with no interaction from the admin.

### US-A16 — the day's money

**S-6 — a settle today of last week's apartado is today's money**
Given a folio created six days ago as an apartado with a $300 deposit on a $1,000 total
When its balance is settled today via *Liquidar* and the dashboard is read
Then `collected_cents` includes exactly 700 00 from that folio — the settle alone, never the
deposit and never the folio's total — and `folios_created` does **not** count it. *(An
implementation that sums today's folios' totals fails this scenario twice.)*

**S-7 — a refund handed back today subtracts today**
Given $500 collected today and a $200 refund row (`entry_type='refund'`, amount −200 00)
stamped today for a folio sold last month
When the dashboard is read
Then `collected_cents` nets to 300 00 — the summary agrees with Caja, not with the sale dates.

**S-8 — attribution follows who took the money**
Given agent Laura took a $300 deposit and admin Marco collected the $700 settle of the same folio
today
When the dashboard is read
Then the per-seller list shows Laura 300 00 and Marco 700 00 (D14 — `collected_by`, not
`folios.agent_id`).

### US-A90 — the departed segment (above the «Ahora» marker)

**S-9 — a departed slot reports boarding, not availability**
Given today's 07:00 slot sold 18 paid seats of which 16 were redeemed, and it is now 09:30 org
time
When the dashboard is read
Then the slot appears in `departed[]` — not `occupancy[]` — as `vendidos 18 · abordaron 16 ·
sin_usar 2`.

**S-10 — a late boarder stops being a no-show**
Given S-9, and the scanner redeems one more pass at 09:40
When the next poll fires
Then the row reads `abordaron 17 · sin_usar 1` — nothing stored was reversed (US-A85: fulfilment
is derived).

**S-11 — a future day has nothing above the marker**
Given the admin selects tomorrow on the day strip
When the dashboard is read with that date
Then `departed` is empty, the timeline renders **no past segment and no «Ahora» marker** (D22),
and the summary/pills remain today's (D12). Regression guard: before D9-rev the departed card was
fed from the *today* query unconditionally, so tomorrow's list carried today's departures beneath
it, unlabelled.

**S-13 — a slot that departs between two polls**
Given today's 14:30 slot is still in `occupancy[]` because the last poll ran at 14:29
When the org-local clock reaches 14:31
Then the row moves **above** the marker and greys immediately (D18), keeps its seat line because
no boarding data exists yet, and shows **no chip** — never a greyed "Disponible" (D19); the
collapsed summary counts it but makes no boarding claim about it (D21). On the next poll it gains
`abordaron / sin usar`.

### Multitenancy isolation (required)

**S-12 — another org's day is invisible**
Given two organizations seeded with `seedTwoOrgs`, each with today-slots and today-payments
When org A's admin reads `GET /api/dashboard/day`
Then every occupancy row, departed row, and cent in the payload derives from org A alone, and
org B's numbers appear nowhere.

## Definition of Done

- [x] `GET /api/dashboard/day` + validation, admin-only, org-tz day resolution
- [x] Scenarios S-1…S-11 covered in `api-turistear/test/dashboard/dashboard-day.test.ts` *(folder path per the test-layout convention, not the flat name first drafted)*
- [x] Cross-org isolation test (S-12, `seedTwoOrgs`)
- [x] `DashboardPage.tsx` rewritten: pills + summary + departures; `QueueCard` deleted
- [x] Polling convention in place (`useDashboardDay` + `useFolioCounts` at 60 s on *Hoy*)
- [x] `SPEC.md`: US-A90 story, US-A15 amendment, both Features-by-Phase lines updated, glossary terms

### Timeline revision (Rev. 2026-08-14)

- [x] `DeparturesTimeline.tsx` replaces `OccupancyCard` + `DepartedCard` (both deleted)
- [x] `timeline.ts` — `timelineItems` (D17) + `hasDeparted` (D18), with unit tests for the split
- [x] `nowHM(tz)` in `features/pos/dates.ts` + `useOrgClock` ticking on the wall-clock minute
- [x] S-11 regression (future day) and S-13 (departs between polls) covered
- [x] `GET /api/dashboard/day` and its 13 tests **unedited** — the D17 proof
- [x] `SPEC.md`: glossary pair entry replaced, US-A90 + both Features-by-Phase lines re-worded and
      ticked (the boxes mean merged code, which #103/#104 delivered)

## Deferred — and why each is safe to defer

| What | Why it can wait |
|---|---|
| US-A15's unrealized-revenue reading (D8) | One multiplication (`remaining × base_price`) and one `MoneyText` away; the count already carries the operational signal. The story stays amended, not silently dropped. |
| Lodging occupancy («ocupación esta noche») | Stays have no slots; a per-unit-type date-range-overlap model is its own feature. Lodging orgs still see slot-based tours; the exclusion is named on the screen's empty state. |
| Per-zone rows | `slots` totals are already reconciled from `slot_zones`; the zone breakdown exists in the service detail for the admin who needs it. |
| US-AG26 — the agent's daily snapshot in Caja | A different role, screen and read; the Phase-2 bundle names it, this spec splits it out (D4). |
| Any seller-facing *Hoy* | Upholds `role-based-ia-reorganization.md` Q3; revisiting it is a product decision, not a gap. |
| Push infrastructure (SSE / Durable Objects) | The 60 s poll is operationally equivalent for seat counts; push is a stack-level commitment to make once something needs sub-second truth. |

## Known behaviour change

Admins lose the five stacked QueueCards and gain the pending-work pills plus everything below
them. The exchange is not one-for-one, and the build made it precise: the pills add **Por
verificar** (which the cards never showed) and drop the **Entregas** card — the pending cash-drop
queue is not a folio facet, and its count already lives on the **Caja** nav badge, which is where
that work is resolved. No agent- or affiliate-visible change. No stored data changes at all.

## Open

- Should departed rows deep-link into the wasted-seats report filtered to the day? (Smallest
  change: a `Link` per row; deferred until someone asks.)
- Reviewing a **past** day on *Hoy* stays closed (D22). Opening it properly means teaching
  `GET /api/dashboard/day` to compute boarding for any date, not just today — a server change with
  its own story, not a picker-floor tweak.
- Does the 60 s interval ever need an org knob? Assumed no — it is a UX constant, not policy.
