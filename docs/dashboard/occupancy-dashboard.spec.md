# Feature: Daily Operations Dashboard — «Hoy» answers how today is going

> **Status: BUILT** — shipped in #103, read at 390 px in #104, **revised by the timeline pass**
> (Rev. 2026-08-14: D9 and D12 amended, D17–D22 added — the two departure cards became one axis),
> and **reduced to the occupancy reading** (Rev. 2026-08-17: D11, D19, D20 and the «Ahora» marker
> retired, D23–D27 added — the card now answers *how full* and *who showed up*, and nothing else).
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
| **D11** ~~*(retired — see D23)*~~ | Traffic light on capacity: **green < 80 % booked · amber ≥ 80 % · red at booked ≥ capacity**, with a small **«+N extra»** hint when a flexible service still has sellable margin. Thresholds computed client-side from the returned numbers. | One org-agnostic rule, stated once. Red-on-base-capacity is deliberate: a slot in its flex margin is the thing an ops admin most wants to notice, and the hint mirrors the POS's existing «Usando X cupos extra» vocabulary. Icon-paired per `DESIGN_TOKENS.md` §3 — state is never color-alone. **Retired 2026-08-17**: the chip and the number beside it said the same thing — «0 disponibles» *is* «Lleno» — and the number says it without colour, without an icon, and without a legend to learn. The «+N extra» hint survives as plain text (D25). |
| **D12** *(amended by D9-rev)* | The day strip re-scopes the **«Salidas» card only** — the whole card, since departed and upcoming are now one list reading one query. The pills and the sales summary stay pinned to today. | "Payments received tomorrow" is always $0 and pending work has no date — re-scoping them would blank or lie. The screen stays *Hoy* with a forward-looking departures peek. The card reading a *single* query is the structural half of the fix: there is no second data source that could still be showing today. |
| **D13** | One new admin-only endpoint, **`GET /api/dashboard/day?date=`**, returns occupancy + departed + sales summary in one payload. The pills keep `GET /api/folios/counts`. | One poll, one org-tz "today" resolution, one place for the query to be right. Splitting per block would re-create the N-reads pattern US-A84 just cleaned up; folding into `/counts` would couple a lean `COUNT(*)` every list hits to a heavy aggregate only *Hoy* needs. |
| **D14** | The per-seller list attributes money by **`folio_payments.collected_by`** (with the operator label via `operator_id` where present), sorted by amount descending. | It is the ledger's own attribution — a settle may differ from the original seller, and D10 chose the ledger's truth. Sale-attribution by `folios.agent_id` remains the commission report's view (US-A17/A18); the two answer different questions. |
| **D15** | The occupancy list is **chronological and flat** — one row per departure ordered by `start_time`, service name on the row. | "What leaves next" is the operational question *Hoy* answers; the POS already offers the grouped-by-service view, and status-grouped ordering would bury the actionable emptiest late slots under full ones that need nothing. |
| **D16** | Transfers still **pending verification count in "collected"**. | The ledger writes the payment row at confirm; verification (US-A67) gates QR and delivery, never the ledger. Excluding them would make *Hoy* disagree with Caja, and the *Por verificar* pill already surfaces them one centimetre above. |

### Timeline revision (Rev. 2026-08-14)

| # | Decision | Why |
|---|---|---|
| **D17** | The merge is **component-side**; `GET /api/dashboard/day` is untouched — same two arrays, same shape, same tests. The client concatenates `departed` then `occupancy`. | The server builds both arrays in ONE `ORDER BY start_time` pass, pushing each row into one or the other, so concatenating in that order restores the original chronology exactly — no re-sort, no endpoint change, no test edit. A display change must not re-open a merged API. |
| **D18** *(the marker retired by D26; the clock survives)* | The **client owns the past/upcoming split**, from one org-local `nowHM(tz)` ticking each wall-clock minute (`useOrgClock`). The server's classification is kept only for *what a row shows*, not *which side it is on*. | Anything shown at a finer resolution than its refresh interval must be derived on the display side, or the two visibly disagree. One fact, one owner. The clock is *computed during render*, never mirrored into state, so a late-arriving org `tz` is correct on the first render that has it. **The clock outlived the marker it used to draw**: it is not there to be displayed, it is there so `hasDeparted` reparts the list and re-renders on the minute — a slot crossing its hour still drops into the collapsed segment on its own. |
| **D19** ~~*(retired with the chips — see D23)*~~ | A departed row is de-emphasised in **text only**; its **chips keep full strength**. A row that crosses the marker between polls keeps its seat line but **loses its chip entirely** until boarding data arrives. | Dimming the whole row would dim the amber *sin usar* chip. **Retired 2026-08-17**: with no chips left, "past" is carried entirely by de-emphasised ink. The ≤60 s honesty rule survives in stronger form — the transient row no longer shows *any* availability figure (D23), because «N disponibles» on a service that has left is not merely a forward-looking claim, it is false. |
| **D20** ~~*(retired — see D26)*~~ | The rail **is the time column**: ONE absolutely-positioned 1px `grey.200` hairline behind the rows, with the «Ahora» marker as a 9px ink dot centered on that spine. *(Rev. 2026-08-16: the first cut drew the rail as per-row `borderLeft`, leaving a hole at the marker row, and «Ahora» as a 2px full-width crossbar.)* | Zero horizontal cost; structure-first. **Retired 2026-08-17**: the rail drew what the sequence already said. Twice revised and then deleted is the tell — each revision made the ornament *better* without ever asking whether it earned its pixels. |
| **D21** | The past segment is **collapsed by default** behind a ≥48 px button row carrying `N ya salieron` **and** the day's attendance, in the rows' own vocabulary («170 de 180 asistieron»). It **auto-expands only when nothing is upcoming**; an explicit tap always wins. Departures that sold nothing contribute no aggregate — «0 de 0 asistieron» is true and useless. | D9's argument survives every revision: what is still sellable keeps the top. But collapsing must not hide the day's attendance, so the summary carries it — and once the day is over there is no top left to protect, which is exactly when an admin reconciles. *(Rev. 2026-08-17: the icon-paired amber no-show count became the plain attendance figure; the shortfall is the subtraction, and stating it twice in two vocabularies was the noise, not the signal.)* |
| **D22** *(title superseded by D27)* | The card title is **day-agnostic**, and the picker's **past-day floor stays** (`PosDatePickerSheet` disables `date < today`). | The strip already names the day; a title changing under the user's thumb is noise. Past days stay out of *Hoy* because the server only computes boarding for today, so a past day would show exactly the numbers you opened it for as blanks; real history is the wasted-seats report's job. |

### Occupancy reduction (Rev. 2026-08-17)

The card had accumulated four vocabularies for one fact — a chip, a colour, an icon and a number,
all describing how full a departure was. This pass keeps the number.

| # | Decision | Why |
|---|---|---|
| **D23** | A row says **one line, in one of four readings**: upcoming → «60 disponibles · 90 vendidos» · departed → «85 asistentes de 90 vendidos» · departed having sold nothing → «Sin ventas» · departed but not yet re-polled → «90 vendidos · asistencia en conteo». The semáforo chips (D11) and the amber no-show chip (D19) are **deleted**. | The chip and the number were the same claim in two notations, and the number is the one that survives translation, colour-blindness and sunlight. The fourth reading is the ≤60 s window where the client's clock has moved a row past its hour but the poll has not returned its boarding numbers: «N disponibles» there is a **lie**, not merely stale, so the row reports only what is still true and waits. |
| **D24** | The sold figure on an upcoming row is **`booked`, not `vendidos`** — held seats count as sold for this reading. `apartados` stays in the payload for the future detail view. | Product call. It makes `disponibles + vendidos === capacity` hold always, so the admin never sees seats vanish without explanation. The cost is named: the label "vendidos" includes seats that are held but not paid, which the detail view (deferred) is where that distinction belongs. |
| **D25** | **`+N extra`** survives the chip cull as plain text, shown only when `booked >= capacity`. | It is the one fact a bare «0 disponibles» would hide — a flexible service can still take N more. Removing it would have been deletion dressed as simplification. |
| **D26** | The time axis is **implicit**: rows are chronological, the hour leads each row inline, and the rail (D20), the fixed time column and the «Ahora» marker are all **removed**. Grouping is whitespace alone — 4 px within a row against 24 px between, a 6:1 ratio. | Order already *is* the timeline; a drawn spine adds no information the sequence does not carry. The eye groups by proximity before it groups by strokes, so the rail was paying pixels for work the spacing did for free — and the marker, having no spine to sit on, had nothing left to mark that the collapsed segment and the muted ink do not already say. |
| **D27** | The card is titled **«Ocupación»**, not «Salidas»; the collapsed segment reads **«ya salieron»**, not «ya partieron». | «Salidas» names the objects — an inventory of departures. «Ocupación» names the question the card answers, in both tenses: it is the only word that survives a row crossing from «60 disponibles» to «85 asistentes», and it matches the feature's own name (US-A14). «Partir» sounds like boats; «salir» fits any service with a departure hour. |

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
3. **«Ocupación»** (`DeparturesTimeline.tsx`, D9-rev + D27): the quick-day strip (reusing the
   US-AG35 pieces: `FilterStrip` + `PosDatePickerSheet` + `GET /api/pos/availability/days`) above
   one `SectionCard` holding the whole day in chronological order (D15) — the collapsed
   «ya salieron» summary (D21) on top, then departed rows, then upcoming. Each row is two lines:
   **«HH:MM · Nombre del servicio»**, then its single occupancy reading (D23). No chips, no
   functional colour, no icons, no rail, no marker (D26) — the leading figure carries `fontWeight`
   600 in primary ink and everything else stays secondary.

Nothing truncates: the service name wraps to as many lines as it needs, because a departure the
admin cannot name is the one thing this screen exists to prevent. Removing the fixed time column
handed the full card width back to that name.

**Pure module** `features/dashboard/timeline.ts` — `timelineItems(day)` (the D17 concatenation)
and `hasDeparted(item, now, isToday)` (the D18 predicate that decides whether a row is past).
Kept out of the component so the rule is testable and stated once. What the row then *says* is
pinned separately by the render tests in `DeparturesTimeline.test.tsx` — the two are different
questions and neither test file can answer the other's.

**New hook** `features/dashboard/hooks/useDashboardDay.ts` — `refetchInterval: 60_000` +
`refetchOnWindowFocus`; the same interval is applied to `useFolioCounts` while *Hoy* is mounted.
This is the app's first polling convention; the spec, not the code comment, is its record.

## Scenarios

### US-A14 — the occupancy reading

**S-1 — a row states its occupancy in numbers** *(rewritten by D23 — was the traffic light)*
Given today has slots booked 5/20, 17/20 and 20/20
When the admin opens *Hoy*
Then the rows read «15 disponibles · 5 vendidos», «3 disponibles · 17 vendidos» and «0 disponibles
· 20 vendidos», in `start_time` order, each led by the availability figure in primary ink.
No chip, no functional colour, no icon carries any of it.

**S-14 — held seats never go missing from the arithmetic** *(D24)*
Given a slot of capacity 150 with 100 booked, of which 10 are apartados and 90 are paid
When the dashboard is read
Then the row reads «50 disponibles · 100 vendidos» — never «50 · 90», which would leave 10 seats
unaccounted for on screen. The sold figure is `booked`; `apartados` rides in the payload for the
deferred detail view.

**S-2 — a flexible slot full on base capacity shows its margin**
Given a service with `flex_capacity_pct = 10` and a slot booked 20/20
When the dashboard is read
Then the row reads «0 disponibles · 20 vendidos · +2 extra» (D25) — full on base, honest about the
margin, which is the one fact a bare «0 disponibles» would hide.

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

### US-A90 — the departed segment (collapsed «ya salieron»)

**S-9 — a departed slot reports attendance, not availability**
Given today's 07:00 slot sold 18 paid seats of which 16 were redeemed, and it is now 09:30 org
time
When the dashboard is read
Then the slot appears in `departed[]` — not `occupancy[]` — as `vendidos 18 · abordaron 16 ·
sin_usar 2`, and the row reads **«16 asistentes de 18 vendidos»** (D23). The shortfall is the
subtraction; no amber chip states it a second time.

**S-15 — a departure that sold nothing says so** *(D23/D21)*
Given today's 13:00 slot has left having sold no seats at all
When the dashboard is read
Then the row reads **«Sin ventas»**, not «0 asistentes de 0 vendidos», and it contributes nothing
to the collapsed summary's attendance figure — which is suppressed entirely if no departure of the
day sold anything. True and useless is still useless.

**S-10 — a late boarder stops being a no-show**
Given S-9, and the scanner redeems one more pass at 09:40
When the next poll fires
Then the row reads `abordaron 17 · sin_usar 1` — nothing stored was reversed (US-A85: fulfilment
is derived).

**S-11 — a future day has no past segment at all**
Given the admin selects tomorrow on the day strip
When the dashboard is read with that date
Then `departed` is empty, the card renders **no «ya salieron» segment**, and the summary/pills
remain today's (D12). Regression guard: before D9-rev the departed card was fed from the *today*
query unconditionally, so tomorrow's list carried today's departures beneath it, unlabelled.

**S-13 — a slot that departs between two polls**
Given today's 14:30 slot is still in `occupancy[]` because the last poll ran at 14:29
When the org-local clock reaches 14:31
Then the row moves into the **collapsed past segment** and greys immediately (D18), and reads
**«N vendidos · asistencia en conteo»** — it must NOT keep showing «N disponibles», which is false
the instant the service leaves (D23, strengthening the retired D19). The collapsed summary counts
it but makes no attendance claim about it (D21). On the next poll it gains its «N asistentes de N
vendidos».

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

### Occupancy reduction (Rev. 2026-08-17)

- [x] `RowChip` (5 branches), `NowMarker`, the rail and the fixed time column **deleted**; the
      component drops from 296 to ~215 lines and from 6 icon imports to 1
- [x] The four readings of D23, incl. «Sin ventas» and the ≤60 s «asistencia en conteo»
- [x] S-1 rewritten, S-14 and S-15 added; render tests in
      `app-turistear/src/features/dashboard/components/DeparturesTimeline.test.tsx`
- [x] `timeline.ts` and its 8 unit tests **unedited** — the split is logic, the chips were paint
- [x] `GET /api/dashboard/day` untouched again; `apartados` and `sin_usar` stay in the payload
      for the deferred detail view
- [x] `SPEC.md`: glossary entry re-titled «Ocupación», US-A90 and the Features-by-Phase line
      re-worded

## Deferred — and why each is safe to defer

| What | Why it can wait |
|---|---|
| US-A15's unrealized-revenue reading (D8) | One multiplication (`remaining × base_price`) and one `MoneyText` away; the count already carries the operational signal. The story stays amended, not silently dropped. |
| Lodging occupancy («ocupación esta noche») | Stays have no slots; a per-unit-type date-range-overlap model is its own feature. Lodging orgs still see slot-based tours; the exclusion is named on the screen's empty state. |
| Per-zone rows | `slots` totals are already reconciled from `slot_zones`; the zone breakdown exists in the service detail for the admin who needs it. |
| US-AG26 — the agent's daily snapshot in Caja | A different role, screen and read; the Phase-2 bundle names it, this spec splits it out (D4). |
| Any seller-facing *Hoy* | Upholds `role-based-ia-reorganization.md` Q3; revisiting it is a product decision, not a gap. |
| Push infrastructure (SSE / Durable Objects) | The 60 s poll is operationally equivalent for seat counts; push is a stack-level commitment to make once something needs sub-second truth. |
| **The row's detail view** (Rev. 2026-08-17) | Named at the reduction: tapping a row would open the full picture — the vendidos/apartados split D24 folds together, the per-folio attendance behind «85 de 90», and who has not shown up. The list's job is *monitoring*; drilling in is a second job with its own navigation question (sheet vs. route vs. deep-link into `/folios?slot=`), so it gets its own story rather than riding along. Everything it needs is **already in the payload** — `apartados` and `sin_usar` are returned and deliberately left unrendered. |

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
