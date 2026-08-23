# Feature: One caja screen, three roles — the admin's own drawer stops being a copy

> Process: `docs/PROCESS.md`. Stories **US-A97** (admin), **US-UX08** (money forms are sheets).
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

This is the folio epic's thesis, one domain over: **one payload written twice by hand always
drifts.** It was proven at the folio detail (BUG-034), at the folio list (D15), and at the drop chip
(BUG-039, three byte-identical copies). This spec is the same remedy before the next divergence
ships, not after.

## Scope boundary

- **No migration, no new column, no new endpoint, no new error code.** Every field this feature
  renders is already in `GET /api/cash/me` and already read by one of the two screens.
- **Authorization is untouched.** The route guards stand exactly as written:
  `/balance` = `['agent','affiliate']`, `/cash` = `admin`, and the router's per-route roles
  (`agent` for expenses, `selfActor` for `/me` and `/me/drops`, `agentOrAffiliate` for
  cancel/acknowledge/dispute, `admin` for the review surface). **No role gains a capability.**
- **The admin does NOT get `/balance`.** The bounce stays; `/cash` → *Mi caja* remains the admin's
  route (D2). This feature unifies the component, never the route.
- `api-turistear/test/cash/*.test.ts` must pass **unedited**. No server behaviour changes.
- **The *Equipo* tab is out of scope** — it is a different screen (other people's balances) and it
  is the best-built surface in this area. Its `role="tabpanel"` wiring, landed with BUG-040, stands.
- **Self-authorization stays visible.** The «Auto-confirmado» chip and its `InfoPopover` are a real
  capability difference (US-A34) and must survive the merge unchanged (D5).

## Design decisions

| # | Decision | Why |
|---|---|---|
| **D1** | **One `BalanceScreen({ surface })` in `features/cash/components/`; `pages/BalancePage.tsx` and `TuCajaSection` become thin hosts.** | The move this codebase has now made three times — `FolioCard` (US-A82 D13), `FolioTimeline` (US-A24 D6), `FolioListScreen`/`FolioDetailScreen` (folio-surface-parity D1) — and every time the drift came from the fork, never from the route. `pages/` is route assembly by architectural rule (`CLAUDE.md`), which is also why the screen's test can finally live beside the screen. |
| **D2** | **Two routes stay.** `/balance` for agent + affiliate, `/cash` → *Mi caja* for the admin. | Merging them would mean removing `requireRole('admin')` from `/cash` — a route whose *other* tab is org-wide team money — for zero user-visible gain. The routes are already disjoint by role, and the admin's caja is genuinely one tab of a larger screen. |
| **D3** | `surface` is **`'self' \| 'admin'`**, not the folio epic's `'seller' \| 'admin'`. | The seller surface here serves agent **and** affiliate, and the distinguishing fact is not who is selling but **whether the caller authorizes their own money moves**. Naming it `self` says what it decides. |
| **D4** | **`surface` decides three things only: which verbs render, whether a move is self-authorized, and whether expenses exist.** Never which numbers are shown. | The rule the server already states for folios — *"the line between the two audiences is capability, never information"* (`pos/handler.ts:3866`). Findings 2 and 3 are what happens when a surface silently decides information too. |
| **D5** | **Self-authorization is stated, not implied.** `surface="admin"` keeps the «Auto-confirmado» `StatusChip` + `InfoPopover`, and its hand-in copy says the move confirms instantly; `surface="self"` keeps the pending-confirmation copy. | US-A34 made admin moves immediate. A screen that looks identical but behaves differently is worse than two screens; the badge is what makes one screen honest for both. |
| **D6** | **Expenses are driven by a capability prop, not by a role test.** `canExpense = surface === 'self' && role !== 'affiliate'`, mirrored from the API's `agent`-only guard. | Finding 4 is exactly the bug a role test produces: the affiliate branch was added and the admin was forgotten. One derived flag has one place to be wrong, and D11's test asserts it against the two roles the API denies. |
| **D7** | **The admin gets the Entregas list.** Same component, same rows. | Finding 2. There is no argument for an actor being able to file a hand-in and not see it; it is the audit record of their own money. Their drops are simply always `confirmed`, which the existing `DropStatusChip` already renders. |
| **D8** | **`CashBoxCard` grows the negative branch; `TuCajaSection`'s bespoke card is deleted.** The card renders «La empresa te debe» with the same collapsible breakdown, plus a `Registrar pago` action when `surface="admin"`. | Finding 3. One card already handles the positive case for both; the negative case was forked only because the admin needed a different verb — which is a `surface` concern, not a second card. |
| **D9** | **Sales and commissions render unconditionally on both surfaces.** The admin's `total !== 0` condition is withdrawn. | Finding 6. A zero shift is information — *«no he vendido nada hoy»* — and the seller has always been shown it. Two screens of different length for the same state is precisely the drift this spec exists to end. |
| **D10** | **All four money dialogs become `FormSheet` / `ConfirmSheet`.** | Finding 7 and `CLAUDE.md`'s explicit rule. The hand-in and the dispute are entity editing; the payout is a confirmation with an amount. Doing it during the merge costs one rewrite instead of two. |
| **D11** | **The parity guard is a parameterized screen test, not a convention.** One `describe.each(['self','admin'])` asserting the invariants, plus `expectHeadingOutline('Caja')` per surface. | The folio epic's deep-equal payload test is what made parity structural there. There is no payload to compare here — both surfaces already call the same endpoint — so the honest equivalent is asserting that everything except the three D4 capabilities renders identically. |
| **D12** | **No `LIMIT`, no window, no new query.** The screen keeps reading `GET /api/cash/me` exactly as both screens do today. | The payload is already shift-scoped by the settlement watermark (`deriveBalance`), so it is bounded by construction. Adding a cap would be inventing a problem. |
| **D13** | **The admin's «Registrar pago» stays admin-only and self-targeted** (`POST /api/cash/payouts` with `agent_id = own userId`). | It is the existing US-A34 behaviour and the endpoint is `admin`-guarded. The merge must not make it reachable from `surface="self"`, where it would 403. |

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

**Reduced to hosts:** `pages/BalancePage.tsx` (≈8 lines, `surface="self"`) and
`features/cash/components/TuCajaSection.tsx` (the *Mi caja* tab chrome — the «Auto-confirmado» chip
and the shift caption — wrapping `<BalanceScreen surface="admin" />`).

**Deleted:** `TuCajaSection`'s bespoke negative-balance card, its hand-in dialog, and its
`total !== 0` conditions.

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

**PR 3 — sheets**
- [ ] Four dialogs → `FormSheet` / `ConfirmSheet` (D10); the seller's Nota reaches both (S-8)
- [ ] S-8, S-9, S-10 covered

**Standing gates, every PR:** `pnpm lint:app` 0 errors · `pnpm test:app` green ·
`pnpm build:app` clean · `pnpm test:api` green (nothing server-side may move) · and the screen
**booted and read at 375 px in all three roles** — this epic's findings were all invisible in a diff.

## Deferred — and why each is safe to defer

| What | Why it can wait |
|---|---|
| The drop detail's «Confirmar recibo» (green filled) and «Rechazar» (red outlined) — functional colour spent on an **action**, which the system reserves for teal | A different screen (`CashDropDetailPage`) and a different rule. Noted in BUG-039; it needs its own decision about how a destructive/confirming pair should read, which will apply to more than the caja. |
| The three stacked tab rows on `/cash` (*Mi caja \| Equipo*, then *Saldos \| Entregas*, then four drop filters — the fourth clips at 375 px) | The *Equipo* tab is out of scope (scope boundary), and the nesting is a navigation question about the whole screen, not about the admin's drawer. |
| The admin's caja is absent from *Equipo* and from the *«Efectivo en la calle»* KPI | Arguably correct — that list is other people — but it means no single view shows all the company's cash. A product question, not a parity defect. |
| `/balance` at 1280 px is one 680 px column | Deliberate (mobile-first) and shared with every other screen. A desktop pass is its own piece of work. |

## Known behaviour change

An organization will notice three things, all on the **admin's** *Mi caja*:

1. An **Entregas** list appears, listing hand-ins that were always being recorded and never shown.
2. The `Gastos −$0.00` line **disappears** from the breakdown. No figure moves — the row was always
   zero, because the API has always answered `403` to an admin creating an expense.
3. *Ventas del turno* and *Comisiones ganadas* now render **on a quiet shift too**, so the screen is
   longer when there is nothing to report.

Sellers and affiliates see **no numeric change at all**; their screen gains the sheet-based forms and
nothing else. No balance, no commission and no drop is recalculated by this feature.

## Open

| Question | The smallest change that answers it |
|---|---|
| Should the admin's own caja be folded into *Equipo* — one list, everyone who holds company cash, the admin included? | Add the caller's own row to `GET /api/cash/balances` behind a flag and read whether the KPI *«Efectivo en la calle»* becomes more useful or merely larger. It is a reporting decision, so it wants a number before an opinion. |
| Should an **admin** be able to record an expense at all? | Today `403`, and this spec mirrors that faithfully. If the answer is yes, the change is one role in `routes/cash/index.ts:66` plus flipping `canExpense` — the UI is already parameterized for it, which is the point of D6. |
| Does the affiliate **manager** read as `self` here, or does an affiliate with shift operators want its own surface? | The same question `folio-surface-parity.spec.md` left open for the folio list. Answer both at once, or neither. |
