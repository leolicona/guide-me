# Feature: One caja screen, three roles — the admin's own drawer stops being a copy

> Process: `docs/PROCESS.md`. Stories **US-A97** (the admin's own caja), **US-A98** (the team's
> caja, restructured), **US-UX08** (money forms are sheets).
> **Extends** `docs/cash-drops/agent-balance-ux-overhaul.spec.md` (US-AG29) and
> `docs/cash-drops/advanced-cash-collection.spec.md` (US-A34/A35) by applying their decisions to
> the surface that was written twice.
> **Applies** `docs/oversight/folio-surface-parity.spec.md` D1/D6 — *one component per screen,
> parameterized by `surface`* — to the caja. Same defect class, same remedy, one domain over.
> Closes the last open finding of `.design/balance/DESIGN_REVIEW.md` (Must Fix 4).

## Context

The caja is one payload — `GET /api/cash/me` — rendered by **two hand-written screens**:

| | seller & affiliate | admin |
|---|---|---|
| Route | `/balance` (`pages/BalancePage.tsx`, 390 lines) | `/cash` → *Mi caja* (`features/cash/components/TuCajaSection.tsx`, 300 lines) |
| Guard | `RoleGuard role={['agent','affiliate']}` | `RoleGuard role="admin"` on `/cash` |
| Endpoint | `GET /api/cash/me` | `GET /api/cash/me` — **the same one** |

They have already drifted, in ways nobody decided:

**1. The admin has no `/balance`, and is not told so.** `RoleGuard` bounces them to `/dashboard`
(`features/auth/components/RoleGuard.tsx:24`) with no message. Both screens then render `<h1>Caja</h1>`
and both nav rails label the entry *Caja* — one word, one heading, two routes, two implementations.

**2. An admin who hands in cash has no record of it.** `TuCajaSection` renders **no Entregas list**.
The seller's screen lists every drop with its status, its note, the admin's rejection reason and the
signature state. The admin files a self-authorized hand-in — born `confirmed`
(`routes/cash/handler.ts:717`, `selfAuthorized = user.role === 'admin'`) — and it vanishes from their
view. They are not in the *Equipo* list either: that list is other people, and the KPI
*«Efectivo en la calle»* sums the team's balances, not theirs.

**3. The admin's negative-balance card is a different, poorer card.** The seller's `CashBoxCard`
folds the full reconciliation behind *«¿Cómo se calcula?»* — `Saldo anterior`, `Efectivo cobrado`,
`Comisión ganada`, `Gastos`, `Pagos recibidos`. When the company owes the **admin**,
`TuCajaSection` renders a bespoke card with a **fixed two-row** breakdown (`Efectivo cobrado`,
`Comisión ganada`) and no disclosure at all. So the one person who can move money cannot see the
carry-forward that produced the figure they are about to pay themselves.

**4. The admin's breakdown offers a row for a capability the API denies them 403.**
`TuCajaSection` calls `<CashBoxCard balance={balance} onRegisterDrop={openDrop} />` without
`showExpenses`, which defaults to `true` — so the breakdown carries a `Gastos −$0.00` line forever.
`cash.post('/me/expenses', agent, …)` (`routes/cash/index.ts:66`) is **`agent`-only**: an admin gets
`403`, exactly like an affiliate. The affiliate got the fix (affiliate-portal **D4**, the
`showExpenses={!isAffiliate}` at `BalancePage.tsx:143`); the admin never did, because nobody
remembered there was a second caller.

**5. The two hand-in dialogs are near-copies that disagree.** The seller's carries a
**«Nota (opcional)»** field and a paragraph explaining the pending state; the admin's carries a chip
and **no note field**, so an admin cannot annotate their own hand-in while every agent can. Two
dialogs, one action, and the difference is an accident of transcription.

**6. Blocks appear conditionally on one surface and unconditionally on the other.** The admin's
sales and commissions cards render only when `sales.total !== 0 || commissions.total !== 0`
(`TuCajaSection.tsx:172`); the seller's always render. Defensible either way — but it was never
decided, and a quiet shift makes the two screens different lengths for the same reason.

**7. Both surfaces put money forms in a centred MUI `Dialog`.** `CLAUDE.md` is unambiguous:
*"`FormSheet` / `ConfirmSheet` — the BottomSheet hosts for **ALL** entity editing and confirmations
(no MUI Dialogs for these)"*. There are **four**: the seller's hand-in, the seller's dispute
(`PendingAcknowledgments.tsx`), the admin's hand-in and the admin's payout. Measured at 375px the
hand-in paper is 311×436 floating mid-screen (top 188, bottom 624) — the design system's third law
is *reach & repetition*, and the sheet pattern is what serves it.

**8. And `/cash` stacks three levels of horizontal navigation for one screen.**

```
Caja  (h1)
├── [ MI CAJA | EQUIPO ① ]                             ← level 1
      └── [ SALDOS | ENTREGAS ① ]                      ← level 2
            └── [Pendientes|Confirmadas|Rechazadas|En disputa]   ← level 3, the 4th clips at 375px
```

The admin's daily job on this screen — *«¿qué entregas necesitan que las confirme?»* — is **three
taps deep**, even though the badge announcing it is repeated on levels 1 and 2. The rest of the app
does not navigate this way: `/folios` is one list with multi-select facets **in the URL** and a
pending-work bar; the *Hoy* dashboard is a single scroll. `/cash` is organized by **object**
(my drawer / their balances / the events) when the admin arrives with a **job**.

This is the folio epic's thesis, one domain over: **one payload written twice by hand always
drifts.** It was proven at the folio detail (BUG-034), at the folio list (D15), and at the drop chip
(BUG-039, three byte-identical copies). This spec is the same remedy before the next divergence
ships, not after.

## Scope boundary

- **No migration, no new column, no new endpoint, no new error code.** Every field this feature
  renders is already in `GET /api/cash/me` and already read by one of the two screens — with one
  additive exception, `drops_truncated` (D12′), which is a boolean the response gains.
- **One bounded read is the only server change** (D12′: a `.limit()` on two existing queries plus
  that flag). Everything else in this feature is frontend. `api-turistear/test/cash/*.test.ts`
  still passes unedited — the seeded orgs are far below either cap.
- **Server authorization is untouched.** Every per-route role in `routes/cash/index.ts` stands as
  written — `agent` for expenses, `selfActor` for `/me` and `/me/drops`, `agentOrAffiliate` for
  cancel/acknowledge/dispute, `admin` for the review surface. **No role gains a capability.** The
  only guard that moves is the client-side `RoleGuard` on `/balance`, which admits the admin to a
  screen whose every call they were already authorized to make (`selfActor` includes `admin`).
- **The admin gets `/balance`** (D2′, which withdraws this spec's original D2). No other role's
  routing changes, and no guard is loosened anywhere else.
- `api-turistear/test/cash/*.test.ts` must pass **unedited**. No server behaviour changes.
- **The team's balance ROWS are not redesigned.** `BalanceRow` — the name, the affiliate chip, the
  money, the disclosure, *Registrar cobro directo* — is the best-built surface in this area and
  keeps its anatomy. What changes is the navigation around it (D14), not the row.
- **No inline capability is invented.** Inline confirm (D16) calls the same
  `POST /api/cash/drops/:id/review` an admin reaches today through the detail, with the same body.
  Adjusting and rejecting stay on the detail.
- **Self-authorization stays visible.** The «Auto-confirmado» chip and its `InfoPopover` are a real
  capability difference (US-A34) and must survive the merge unchanged (D5).

## Design decisions

| # | Decision | Why |
|---|---|---|
| **D1** | **One `BalanceScreen({ surface })` in `features/cash/components/`; `pages/BalancePage.tsx` and `TuCajaSection` become thin hosts.** | The move this codebase has now made three times — `FolioCard` (US-A82 D13), `FolioTimeline` (US-A24 D6), `FolioListScreen`/`FolioDetailScreen` (folio-surface-parity D1) — and every time the drift came from the fork, never from the route. `pages/` is route assembly by architectural rule (`CLAUDE.md`), which is also why the screen's test can finally live beside the screen. |
| **D2 (withdrawn)** | ~~Two routes stay; the admin does not get `/balance`.~~ | Withdrawn while writing D14. The argument was that the admin's caja *is* one tab of a larger screen — but it was one tab only because it had been **written** there. Once the component is one, that tab is the last thing keeping two meanings of the word «Caja» alive, and it is what forces the third level of tabs. |
| **D2′** | **The admin gets `/balance`, like every other role.** `RoleGuard` becomes `['agent','affiliate','admin']`, the nav's «Caja» points there for all three, and **`/cash` stops being anyone's own drawer**: it becomes *Caja del equipo*, oversight only. | One word, one meaning. It also deletes the *Mi caja* tab — the whole first level — without moving a single number, because the component behind it is already shared by D1. |
| **D3** | `surface` is **`'self' \| 'admin'`**, not the folio epic's `'seller' \| 'admin'`. | The seller surface here serves agent **and** affiliate, and the distinguishing fact is not who is selling but **whether the caller authorizes their own money moves**. Naming it `self` says what it decides. |
| **D4** | **`surface` decides three things only: which verbs render, whether a move is self-authorized, and whether expenses exist.** Never which numbers are shown. | The rule the server already states for folios — *"the line between the two audiences is capability, never information"* (`pos/handler.ts:3866`). Findings 2 and 3 are what happens when a surface silently decides information too. |
| **D5** | **Self-authorization is stated, not implied.** `surface="admin"` keeps the «Auto-confirmado» `StatusChip` + `InfoPopover`, and its hand-in copy says the move confirms instantly; `surface="self"` keeps the pending-confirmation copy. | US-A34 made admin moves immediate. A screen that looks identical but behaves differently is worse than two screens; the badge is what makes one screen honest for both. |
| **D6** | **Expenses are driven by a capability prop, not by a role test.** `canExpense = role !== 'affiliate'`, mirrored from the API's guard — `agentOrAdmin` since **US-A99** answered this spec's Open question; it read `agent`-only when this was written. | Finding 4 is exactly the bug a role test produces: the affiliate branch was added and the admin was forgotten. One derived flag has one place to be wrong, and D11's test asserts it against the two roles the API denies. |
| **D7** | **The admin gets the Entregas list.** Same component, same rows. | Finding 2. There is no argument for an actor being able to file a hand-in and not see it; it is the audit record of their own money. Their drops are simply always `confirmed`, which the existing `DropStatusChip` already renders. |
| **D8** | **`CashBoxCard` grows the negative branch; `TuCajaSection`'s bespoke card is deleted.** The card renders «La empresa te debe» with the same collapsible breakdown, plus a `Registrar pago` action when `surface="admin"`. | Finding 3. One card already handles the positive case for both; the negative case was forked only because the admin needed a different verb — which is a `surface` concern, not a second card. |
| **D9** | **Sales and commissions render unconditionally on both surfaces.** The admin's `total !== 0` condition is withdrawn. | Finding 6. A zero shift is information — *«no he vendido nada hoy»* — and the seller has always been shown it. Two screens of different length for the same state is precisely the drift this spec exists to end. |
| **D10** | **All four money dialogs become `FormSheet` / `ConfirmSheet`.** | Finding 7 and `CLAUDE.md`'s explicit rule. The hand-in and the dispute are entity editing; the payout is a confirmation with an amount. Doing it during the merge costs one rewrite instead of two. |
| **D11** | **The parity guard is a parameterized screen test, not a convention.** One `describe.each(['self','admin'])` asserting the invariants, plus `expectHeadingOutline('Caja')` per surface. | The folio epic's deep-equal payload test is what made parity structural there. There is no payload to compare here — both surfaces already call the same endpoint — so the honest equivalent is asserting that everything except the three D4 capabilities renders identically. |
| **D12 (withdrawn)** | ~~No `LIMIT`, no window, no new query — the payload is bounded by construction.~~ | **Wrong, and measured wrong.** The settlement watermark bounds the balance *derivation* and the `expenses` read (`gt(agentExpenses.createdAt, derived.since)`), but `drops` has **neither a `LIMIT` nor a `since`**: `getMyBalance` returns the agent's **entire hand-in history** on every read. The frontend type calls it *«recent drops»*; it is not. Replaced by D12′. |
| **D12′** | **`drops` is capped at 50, newest first, with a `drops_truncated` flag.** The admin's `listDrops` gets `LIMIT 500 + truncated`, matching `folio-surface-parity.spec.md`'s seller list. | Measured on the running app: **386 bytes per drop row**, 54 % of today's 2,128-byte payload at three drops. A seller handing in daily reaches **~96 KB/year of drops alone**, ~193 KB at 500, and it never stops growing — re-fetched on **every mount and every window focus** (`useMyBalance` sets no `staleTime`, and `queryClient.ts` is a bare `new QueryClient()`). 50 covers weeks of a rolling audit list; the flag is what stops a cap from silently reading as «everything». |
| **D13** | **The admin's «Registrar pago» stays admin-only and self-targeted** (`POST /api/cash/payouts` with `agent_id = own userId`). | It is the existing US-A34 behaviour and the endpoint is `admin`-guarded. The merge must not make it reachable from `surface="self"`, where it would 403. |
| **D14** | **`/cash` is organized by JOB, not by object, and has no tabs at all.** In order: **Necesitan tu confirmación** → **En disputa** → **Efectivo en la calle** (the people list) → a link to the history. The first two render only when non-empty. | Finding 8. The admin arrives with a job, not with an object; three levels of tabs existed to reconcile «my drawer / their balances / the events», and D2′ deletes the first of those three. What remains — people and events — stops needing a tab because the events that need a human are **the top of the page** and the rest is history (D15). |
| **D15** | **The drop history moves to its own route, `/cash/entregas`,** with the existing multi-select `FilterStrip` and its state in the URL. | Confirmed and rejected drops are **audit**, not daily work: they were sharing a tab with the pending ones and dragging a four-value exclusive filter (whose fourth value clips at 375px) onto the main screen. A separate route is also what makes «Ver historial de entregas →» an honest link instead of a tab-in-disguise. |
| **D16** | **Confirming a hand-in AS REQUESTED is inline on `/cash`**, through a `ConfirmSheet` naming the amount and the person. **Adjusting or rejecting still opens the detail.** | The common case is *«sí, recibí esos $200»* and it costs three taps today. The uncommon cases need a corrected amount or a written reason, and those belong on a screen with room for them — which is also where US-A28's «adjusted confirm owes a signature» rule is explained. One-tap money still gets a confirmation sheet; it is money. |
| **D17** | **The admin's `/balance` carries one oversight block** — «N entregas del equipo esperan tu confirmación → Ver caja del equipo» — and this **extends D4 from three gates to four**: the fourth is *whether the team's pending work is surfaced*. | Stated rather than smuggled. Once «Caja» means *my* caja for the admin too, their oversight work needs a door, and their own screen is where they already are. It is a capability (only an admin may confirm a drop), so it belongs on the capability list — but D4 said "three things only", and a rule you quietly extend is a rule you have stopped enforcing. |
| **D18** | **The KPI strip collapses to one figure.** «Por confirmar» and «En disputa» become the blocks themselves; «Efectivo en la calle» survives as the heading of the people list. | A count above a list of the same things it counts is a number the reader has to reconcile with what follows. The blocks carry their own counts. |

## Authorization — who may do this

Unchanged. Restated so the frontend's capability flags can be checked against it:

| Action | Endpoint | Roles | On the merged screen |
|---|---|---|---|
| Read own caja | `GET /api/cash/me` | agent · admin · affiliate | both surfaces |
| Add / delete expense | `POST` · `DELETE /api/cash/me/expenses[/:id]` | **agent only** | `canExpense` (D6) |
| File a hand-in | `POST /api/cash/me/drops` | agent · admin · affiliate | both surfaces |
| Cancel a pending hand-in | `DELETE /api/cash/me/drops/:id` | agent · affiliate | `surface="self"` only — an admin's drop is never pending (D5) |
| Sign / dispute | `POST /api/cash/me/drops/:id/{acknowledge,dispute}` | agent · affiliate | `surface="self"` only |
| Register a payout to self | `POST /api/cash/payouts` | **admin only** | `surface="admin"` only (D13) |

Client routing after D2′:

| Route | Who | What |
|---|---|---|
| `/balance` | agent · affiliate · **admin** | your own caja — `BalanceScreen({ surface })` |
| `/cash` | admin | *Caja del equipo* — oversight only, no drawer of your own |
| `/cash/entregas` | admin | the drop history, faceted (D15) |
| `/cash/drops/:id` | admin | one drop — adjust, reject, resolve a dispute |

A cross-org attempt returns `404`, never `403` — unchanged, and already covered by
`test/cash/*.test.ts`.

## API surface

**No change.** The screen consumes what exists:

- `GET /api/cash/me` → `AgentBalance` (`features/cash/types.ts:115`) — balance, the shift breakdown,
  `expenses`, `drops`, `pending_acknowledgments`, `sales`, `commissions`.
- The six mutations in the table above.

The admin surface has always received `expenses: []` and `pending_acknowledgments: []` from this
endpoint; it simply never rendered the containers. That is why finding 2 costs no server work.

## Frontend

**New:** `features/cash/components/BalanceScreen.tsx` — `BalanceScreen({ surface })`.

**Reduced to a host:** `pages/BalancePage.tsx` — `<BalanceScreen surface={isAdmin ? 'admin' : 'self'} />`,
for all three roles (D2′).

**Deleted outright:** `features/cash/components/TuCajaSection.tsx`. Its «Auto-confirmado» chip and
`InfoPopover` move into `BalanceScreen` under `surface="admin"` (D5); its bespoke negative-balance
card, its hand-in dialog and its `total !== 0` conditions have no successor.

**Restructured:** `pages/CashBalancesPage.tsx` → *Caja del equipo* (D14): no tabs, blocks ordered by
job. **New:** `pages/CashDropsHistoryPage.tsx` at `/cash/entregas` (D15) — the old *Entregas* tab
plus the multi-select `FilterStrip`, state in the URL.

**Nav:** `layout/AppLayout.tsx` — the two «Caja» entries collapse to one pointing at
`ROUTES.BALANCE` for every role. Its badge stays `pendingDropCount` for the admin (their pending
work is still what the number means) and `pendingAckCount` for the others.

### `/cash` — Caja del equipo (D14)

```
Caja del equipo                       h1
┌─ Necesitan tu confirmación ── 3 ──┐   AlertCard tone="warning", only when > 0
│ $200.00 · Ana Ramírez · hace 2 h  │   MoneyText + the person + when
│         [Confirmar]  [Revisar]    │   D16: Confirmar → ConfirmSheet; Revisar → the detail
└───────────────────────────────────┘
┌─ En disputa ───────────────── 1 ──┐   AlertCard tone="error", only when > 0
└───────────────────────────────────┘
Efectivo en la calle                  h2 + MoneyText — the only surviving KPI (D18)
$2,684.00 · 2 personas
┌───────────────────────────────────┐
│ BalanceRow … (unchanged anatomy)  │
└───────────────────────────────────┘
        Ver historial de entregas →    → /cash/entregas
```

**Grows:** `CashBoxCard` — the negative branch and the `onRegisterPayout` action (D8).

**Primitives:** `SectionCard`, `MoneyText`, `StatusChip`, `AlertCard`, `FormSheet`, `ConfirmSheet`,
`InfoPopover`. Design system: `.design/design-system/DESIGN_TOKENS.md`.

**Sheets replacing dialogs (D10):**

| Action | Host | Fields |
|---|---|---|
| Entregar efectivo | `FormSheet` | Monto (+ «Todo»), Nota (opcional) — **both surfaces**, ending finding 5 |
| Disputar un movimiento | `FormSheet` | Motivo (required) |
| Registrar pago | `ConfirmSheet` | the amount the company owes, stated; confirm / cancel |

## Scenarios

### US-A97 — the admin's caja is the team's caja

**S-1 — The admin sees their own hand-ins**
Given an admin with one self-authorized hand-in
When they open `/cash` → *Mi caja*
Then an **Entregas** section lists it, with a `Confirmado` chip — the state an admin drop is born in.

**S-2 — The admin's negative balance carries the full breakdown**
Given an admin whose balance is negative and whose `carry_forward` is non-zero
When they expand *«¿Cómo se calcula?»*
Then `Saldo anterior`, `Efectivo cobrado`, `Comisión ganada` and `Pagos recibidos` all render
And `Registrar pago` is offered.

**S-3 — The admin is never offered expenses**
Given any admin balance
When the screen renders
Then no *Gastos* card is present **and** the breakdown carries **no `Gastos` row** — the API answers
`403` to that role, and a row for a denied capability is a lie the affiliate was already spared.

**S-4 — An affiliate is never offered expenses either**
Given an affiliate balance
Then the same two absences hold — one flag, both roles (D6).

**S-5 — A seller still is**
Given an agent balance
Then the *Gastos* card renders, and the breakdown carries the `Gastos` row.

**S-6 — Self-authorization is stated on the admin surface only**
Given the two surfaces
Then `surface="admin"` shows «Auto-confirmado» and hand-in copy that says the move confirms
instantly; `surface="self"` shows neither, and its copy says the hand-in stays pending until an
admin confirms.

**S-7 — A zero shift renders the same on both surfaces**
Given a balance whose `sales.total` and `commissions.total` are both `0`
Then *Ventas del turno* and *Comisiones ganadas* render on **both** surfaces (D9).

### US-A98 — the team's caja is organized by the job

**S-15 — The admin's own caja is no longer on `/cash`**
Given an admin
When they open `/cash`
Then the `h1` reads *Caja del equipo*, there is **no** *Mi caja* tab and **no tablist anywhere on
the screen**
And `/balance` renders their own caja (S-1…S-7 apply there).

**S-16 — Pending confirmations lead the page**
Given three hand-ins awaiting confirmation
When the admin opens `/cash`
Then *Necesitan tu confirmación* is the first block, carries the count, and each row names the
amount, the person and how long it has waited.

**S-17 — Empty blocks do not render**
Given no pending drops and no disputes
Then neither block appears, and *Efectivo en la calle* is the first thing under the `h1`.

**S-18 — Confirming as requested never leaves the page**
Given a pending hand-in of $200.00 from Ana
When the admin presses *Confirmar* and confirms the sheet
Then `POST /api/cash/drops/:id/review` is called with `decision: 'confirmed'` and **no `amount`**
And the row leaves the block without a navigation.

**S-19 — Adjusting or rejecting still goes to the detail**
When the admin presses *Revisar*
Then they land on `/cash/drops/:id`, where a corrected amount and a rejection reason exist.

**S-20 — History is a route, not a tab**
When the admin follows *Ver historial de entregas*
Then `/cash/entregas` lists every drop with a multi-select state facet whose selection lives in the
URL and survives opening a drop and coming back.

**S-21 — The admin's own caja carries the door to the team's**
Given an admin with three team hand-ins awaiting confirmation
When they open `/balance`
Then one block reads *3 entregas del equipo esperan tu confirmación* and links to `/cash` (D17)
And `surface="self"` renders no such block.

### US-UX08 — money forms are sheets

**S-8 — The hand-in is a sheet, and both surfaces can annotate it**
Given either surface
When the hand-in opens
Then it is a `FormSheet` — not a `MuiDialog` — and it carries the **Nota (opcional)** field on both.

**S-9 — The dispute is a sheet with a required reason**
Given an outstanding signature
When *Disputar* opens
Then it is a `FormSheet`, and submitting empty is refused.

**S-10 — The payout is a confirmation, not a form**
Given `surface="admin"` and a negative balance
When *Registrar pago* opens
Then it is a `ConfirmSheet` stating the amount, with stacked confirm / cancel.

### Parity invariants (D11) — asserted for **both** surfaces

**S-11 — Every block except the three capabilities renders on both**
Given the same `AgentBalance`
When rendered as `self` and as `admin`
Then the cash box, the shift caption, *Ventas del turno*, *Comisiones ganadas* and *Entregas* are all
present in both, with the same figures.

**S-12 — Only the capabilities differ**
Then the set of differences is exactly: the *Gastos* card + breakdown row (self, non-affiliate),
`Cancelar` on a pending drop (self), `Firmar`/`Disputar` (self), `Registrar pago` (admin), and the
«Auto-confirmado» badge (admin). Nothing else.

**S-13 — The heading outline holds on both**
Then `expectHeadingOutline('Caja')` passes for each surface — no level skipped, one `h1`, and every
card a named region (the guard BUG-040 could only pin per-card).

**S-14 — No money figure escapes the primitive**
Then every rendered amount carries `.numeric`, on both surfaces.

> **Multitenancy isolation** is not restated here: this feature adds no endpoint and no query. The
> `/me` surface keys strictly on `user.userId` and is already covered by `test/cash/*.test.ts`,
> which this spec's scope boundary requires to pass unedited.

## Definition of Done

**PR 1 — the spec** *(this document)*
- [ ] `docs/cash-drops/caja-surface-parity.spec.md` + `.plan.md`
- [ ] `SPEC.md`: US-A97, US-UX08, the Features-by-Phase line, glossary («Caja», «Auto-confirmado»)

**PR 2 — `BalanceScreen({ surface })`**
- [ ] `features/cash/components/BalanceScreen.tsx`; `pages/BalancePage.tsx` and `TuCajaSection`
      reduced to hosts
- [ ] `CashBoxCard` grows the negative branch + `onRegisterPayout` (D8); the bespoke card deleted
- [ ] `canExpense` (D6); the admin's `Gastos` breakdown row gone (S-3/S-4/S-5)
- [ ] The admin gets Entregas (D7, S-1); sales/commissions unconditional (D9, S-7)
- [ ] `BalanceScreen.test.tsx` — S-1…S-7, S-11…S-14, `describe.each(['self','admin'])`

**PR 3 — the team's caja**
- [ ] `/balance` admits the admin (D2′); the nav's two «Caja» entries become one; `TuCajaSection`
      deleted
- [ ] `/cash` restructured by job, **no tablist** (D14, D18); `/cash/entregas` with the
      multi-select `FilterStrip` (D15)
- [ ] Inline *Confirmar* via `ConfirmSheet`; *Revisar* to the detail (D16)
- [ ] The oversight block on the admin's `/balance` (D17)
- [ ] S-15…S-21 covered

**PR 4 — the bounded read** *(D12′)*
- [ ] `getMyBalance`: `drops` capped at 50 + `drops_truncated`; `listDrops` at 500 + `truncated`
- [ ] The caps stated in the UI when they bite — never a silent truncation
- [ ] API tests for both caps and both flags; `test/cash/*.test.ts` unedited

**PR 5 — sheets**
- [ ] Four dialogs → `FormSheet` / `ConfirmSheet` (D10); the seller's Nota reaches both (S-8)
- [ ] S-8, S-9, S-10 covered

**Standing gates, every PR:** `pnpm lint:app` 0 errors · `pnpm test:app` green ·
`pnpm build:app` clean · `pnpm test:api` green (nothing server-side may move) · and the screen
**booted and read at 375 px in all three roles** — this epic's findings were all invisible in a diff.

## Deferred — and why each is safe to defer

| What | Why it can wait |
|---|---|
| The drop detail's «Confirmar recibo» (green filled) and «Rechazar» (red outlined) — functional colour spent on an **action**, which the system reserves for teal | A different screen (`CashDropDetailPage`) and a different rule. Noted in BUG-039; it needs its own decision about how a destructive/confirming pair should read, which will apply to more than the caja. |
| The admin's caja is absent from *Equipo* and from the *«Efectivo en la calle»* KPI | Arguably correct — that list is other people — but it means no single view shows all the company's cash. A product question, not a parity defect; and after D2′ the admin's own figure is one tap away on their own screen. |
| A `staleTime` on `useMyBalance` (today it re-fetches on every mount and window focus) | A caching policy is app-wide — `queryClient.ts` carries no defaults at all — and picking one for the caja alone would hide the question rather than answer it. D12′ removes the size problem; the frequency one wants its own look at every screen. |
| A *Caja del equipo* summary on the **Hoy** dashboard | D17 gives the oversight work a door from the screen the admin is already on. Whether *Hoy* should carry a second one is a question about that dashboard's composition, and it wants the D17 link to be observed in use first. |
| `/balance` at 1280 px is one 680 px column | Deliberate (mobile-first) and shared with every other screen. A desktop pass is its own piece of work. |

## Known behaviour change

**The admin's «Caja» now opens their own caja** (`/balance`), not the team's. The team's is one tap
away — from the block D17 puts on that screen, and from the same nav badge, which still counts the
hand-ins waiting for them. `/cash` keeps working as a URL; it simply stops holding a *Mi caja* tab
and is titled *Caja del equipo*.

Three further changes on the admin's own caja:

1. An **Entregas** list appears, listing hand-ins that were always being recorded and never shown.
2. The `Gastos −$0.00` line **disappears** from the breakdown. No figure moves — the row was always
   zero, because the API answered `403` to an admin creating an expense. *(Superseded by US-A99,
   which grants the capability: the row returns, and is now true.)*
3. *Ventas del turno* and *Comisiones ganadas* now render **on a quiet shift too**, so the screen is
   longer when there is nothing to report.

On the team's screen the tabs are gone: pending confirmations and disputes are the top of the page,
the drop history moves to `/cash/entregas`, and confirming a hand-in *as requested* no longer
requires opening it.

Sellers and affiliates see **no numeric change and no routing change at all**; their screen gains
the sheet-based forms and nothing else. No balance, no commission and no drop is recalculated by
this feature.

## Open

| Question | The smallest change that answers it |
|---|---|
| Should the admin's own row appear in *Efectivo en la calle*, so one figure covers all the company's cash? | Add the caller's own row to `GET /api/cash/balances` behind a flag and read whether the total becomes more useful or merely larger. A reporting decision, so it wants a number before an opinion. |
| Is 50 the right cap for a seller's Entregas, and 500 for the admin's history? | The same query the folio spec left open, one table over: `SELECT agent_id, COUNT(*) FROM cash_drops GROUP BY agent_id` in production. Until it runs, both numbers are honest guesses that say so on screen. |
| Should *Necesitan tu confirmación* cap at N rows, with the rest behind *Ver todas*? | Seed an org with 30 pending hand-ins and read the screen. Until that org exists the cap is a guess, and a silent truncation reads as «covered everything» when it did not. |
| ~~Should an **admin** be able to record an expense at all?~~ | **Answered: yes** (US-A99). It cost exactly what this row predicted — one role in `routes/cash/index.ts` (onto `agentOrAdmin`, a guard that had been declared and left unused) and one flag flipped. The UI needed no other change, which is the point of D6. |
| Does the affiliate **manager** read as `self` here, or does an affiliate with shift operators want its own surface? | The same question `folio-surface-parity.spec.md` left open for the folio list. Answer both at once, or neither. |
