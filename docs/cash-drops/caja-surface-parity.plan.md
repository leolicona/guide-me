# Implementation Plan — Caja Surface Parity (US-A97, US-A98, US-UX08)

> **Spec:** `docs/cash-drops/caja-surface-parity.spec.md` — decisions cited as D1…D18, scenarios as S-1…S-21.
> **Stack (App):** React 18 · MUI **v9** · TanStack Query · vitest + jsdom + MSW + RTL
> **Shape:** five PRs. Four are frontend; **PR-4 is the one server change** — a `.limit()` on two
> existing reads plus an additive flag (D12′). No migration, no new endpoint, no new error code.
> Worktrees from `origin/develop`, one per PR (`docs/PROCESS.md` § Local workflow).

**Standing gates, every PR:**
`pnpm lint:app` 0 errors · `pnpm test:app` green · `pnpm build:app` clean ·
`pnpm test:api` green — **nothing server-side may move**, and `api-turistear/test/cash/*.test.ts`
must pass **unedited** (spec § Scope boundary) ·
and the screen **booted and read at 375 px in all three roles**. Every finding in
`.design/balance/DESIGN_REVIEW.md` was invisible in a diff; measure with `playwright-cli eval`
(computed colours, heading tags, box sizes), never by judging a PNG.

Local boot (`docs/DEVELOPMENT.md`, and the recipe this epic used):
`cp api-turistear/.dev.vars.example api-turistear/.dev.vars` → `pnpm db:migrate:local` →
`pnpm seed:local` → `pnpm dev`. Logins: admin `admin@local.test`, agent `ana@local.test`, both
`Local1234!`. **The seed has no affiliate** — this epic created one by hand
(`affiliate_companies` + a `users` row with `role='affiliate'` reusing the admin's password hash,
then re-pointing two folios' `agent_id` and their `folio_payments.collected_by`). Fold that into
`scripts/seed-local.mjs` in PR-2 if it is needed a third time.

---

## PR map

```
PR-1  the spec        this document + SPEC.md registration
                      [no code]
PR-2  the screen      BalanceScreen(surface) · CashBoxCard negative branch · canExpense ·
                      admin gets Entregas · sales/commissions unconditional
                      [US-A97 · D1, D3–D9, D11–D13 · S-1…S-7, S-11…S-14]
PR-3  the team        /balance admits the admin · nav collapses to one «Caja» ·
                      TuCajaSection deleted · /cash restructured by job, no tabs ·
                      /cash/entregas · inline Confirmar · the oversight block
                      [US-A98 · D2′, D14–D18 · S-15…S-21]
PR-4  the read        drops capped at 50 (+drops_truncated); listDrops at 500 (+truncated)
                      [D12′ · the ONLY server change in this epic]
PR-5  the sheets      four MUI Dialogs → FormSheet / ConfirmSheet
                      [US-UX08 · D10 · S-8, S-9, S-10]
```

Order matters twice. **PR-2 before PR-3**: the admin cannot be routed to `/balance` until the
component behind it serves them. **PR-3 before PR-4**: the sheets are then rewritten **once**,
inside the merged component, instead of twice in two doomed copies.

---

## PR-1 — the spec *(no code)*

1. `docs/cash-drops/caja-surface-parity.spec.md` + this plan.
2. `docs/SPEC.md`:
   - **US-A97**, **US-A98** under *Admin*; **US-UX08** under *Cross-cutting UX*.
   - A *Features by Phase* line linking the spec (unchecked until PR-4 merges).
   - Glossary: **Caja**, **Auto-confirmado**.
3. Nothing else. The registration ships in the feature's own first PR, never "later"
   (`CLAUDE.md`, and how the index rotted before).

---

## PR-2 — `BalanceScreen({ surface })` *(US-A97)*

**1. Extract the screen** — `app-turistear/src/features/cash/components/BalanceScreen.tsx` *(new)*

Lift `pages/BalancePage.tsx` wholesale — it is already the richer of the two — then parameterize:

```ts
type CajaSurface = 'self' | 'admin'          // D3

const isAdmin = surface === 'admin'
const canExpense = surface === 'self' && user.role !== 'affiliate'   // D6, mirrors the API's
                                                                     // agent-only guard
```

`canExpense` is the ONLY place either role is named. A second role test anywhere in this file is the
bug that produced finding 4.

**2. What `surface` gates** — and nothing else (D4)

| Gate | `self` | `admin` |
|---|---|---|
| *Gastos* card + breakdown row | `canExpense` | never (S-3) |
| `Cancelar` on a pending drop | yes | never — an admin drop is born `confirmed` |
| `PendingAcknowledgments` (Firmar / Disputar) | yes | never — an admin owes no signature |
| `Registrar pago` | never (would 403) | on a negative balance (D13) |
| «Auto-confirmado» chip + `InfoPopover` | never | yes (D5) |
| Hand-in copy | "pending until an admin confirms" | "confirms instantly" |

Everything else — the shift caption, the cash box, *Ventas del turno*, *Comisiones ganadas*,
*Entregas* — renders on **both**, unconditionally (D7, D9).

**3. `CashBoxCard` grows the negative branch** — `features/cash/components/CashBoxCard.tsx`

- Add `onRegisterPayout?: () => void`. When `balance < 0`: heading «La empresa te debe» (already
  there), the same collapsible *«¿Cómo se calcula?»* breakdown (D8 — this is finding 3), and
  `Registrar pago` in place of `Entregar efectivo` when the handler is passed.
- `showExpenses` stays the prop; the callers stop defaulting it to `true` by omission.
- Keep the BUG-040 guard: the hand-in CTA renders only when `available > 0`.

**4. Reduce the hosts**

- `pages/BalancePage.tsx` → `<BalanceScreen surface="self" />` and nothing else (~8 lines).
- `features/cash/components/TuCajaSection.tsx` → the *Mi caja* tab chrome only (the
  «Auto-confirmado» chip + `InfoPopover` + the shift caption if it stays there), wrapping
  `<BalanceScreen surface="admin" />`.
- **Delete** its bespoke negative card, its hand-in dialog, and both `total !== 0` conditions.

**5. The parity test** — `features/cash/components/BalanceScreen.test.tsx` *(new)*

```ts
describe.each(['self', 'admin'] as const)('BalanceScreen — %s', (surface) => { … })
```

- S-11: the five shared blocks render on both, with the same figures.
- S-12: the difference set is **exactly** the six rows of the table above — assert both presence
  and absence, or the test proves only half of parity.
- S-13: `expectHeadingOutline('Caja')` (`src/test/axe.ts`) — the screen-level guard BUG-040 could
  only pin per-card, and the one TECH_DEBT #30 asks for.
- S-14: every rendered amount carries `.numeric`.
- S-1…S-7 as the surface-specific cases.

Fixtures: extend `src/test/handlers/cash.ts` (`anAgentBalance`) rather than inventing shapes — a
fixture no API test would produce proves the frontend agrees with itself (`docs/TESTING.md` D4).
Note the existing `anAgentBalance` omits `sales.by_method` / the counts; add them from what
`api-turistear/test/cash/*.test.ts` asserts.

**6. Verify in the browser, all three roles** — the admin's Entregas list (S-1), the vanished
`Gastos` row (S-3), an affiliate's absent expenses (S-4), and a seeded **negative** admin balance
for S-2 (a `payouts` row, or an expense/commission that overshoots).

---

## PR-3 — the team's caja *(US-A98)*

**1. Route the admin to their own caja** *(D2′)*
- `App.tsx` — `RoleGuard role={['agent','affiliate','admin']}` on `ROUTES.BALANCE`.
- `layout/AppLayout.tsx:56-57` — the two «Caja» entries become **one** pointing at
  `ROUTES.BALANCE` for every role. The badge resolver (`:117-119`) keeps
  `pendingDropCount` for an admin and `pendingAckCount` for the others: the number still means
  *your* pending work, it just no longer names the route it came from.
- `pages/BalancePage.tsx` — `surface={user.role === 'admin' ? 'admin' : 'self'}`.
- **Delete `features/cash/components/TuCajaSection.tsx`.** Its chip + `InfoPopover` moved into
  `BalanceScreen` in PR-2; nothing else in it has a successor.

**2. The oversight block** *(D17)* — in `BalanceScreen`, `surface="admin"` only:
`usePendingDropCount(true)` → an `AlertCard tone="warning"` reading *«N entregas del equipo esperan
tu confirmación»* with a link to `/cash`. Renders only when `N > 0`. This is the **fourth** gate on
the D4 list — add it to that list in the component's own comment, or the next reader will read a
violation.

**3. `/cash` → Caja del equipo** *(D14, D18)* — `pages/CashBalancesPage.tsx`
- `h1` becomes *Caja del equipo*. **Both `Tabs` blocks and every `TabPanel` wrapper are deleted** —
  including the `tabA11y` / `panelA11y` helpers BUG-040 added, which exist only to name tabs.
- Order: `PendingConfirmationsBlock` → `DisputesBlock` → *Efectivo en la calle* + the `BalanceRow`
  list → the history link. The first two render only when non-empty (S-17).
- `KpiHeader` collapses: drop the *Por confirmar* and *En disputa* stats (they are now the blocks);
  *Efectivo en la calle* becomes an `h2` + `MoneyText` above the list.
- `BalanceRow` is untouched (scope boundary).

**4. `/cash/entregas`** *(D15)* — `pages/CashDropsHistoryPage.tsx` *(new)* + `ROUTES.CASH_DROPS`
- The old `DropsTab` body, minus its `ToggleButtonGroup`, plus the multi-select `FilterStrip` from
  `features/filters` with state in the URL — the same grammar `/folios` uses.
- Keep the `disputed` pseudo-filter (it queries by acknowledgment across statuses).

**5. Inline confirm** *(D16)*
- Each pending row: **[Confirmar]** → `ConfirmSheet` naming the amount and the person → the
  existing `useReviewDrop` with `{ decision: 'confirmed' }` and **no `amount`**; **[Revisar]** →
  `/cash/drops/:id`.
- Assert the absent `amount` in the test (S-18): sending it turns a plain confirm into an
  **adjusted** one, which by US-A28 owes the agent a signature. A default of `drop.amount` would
  look harmless and silently mint acknowledgment obligations.

**6. Tests** — `CashBalancesPage.test.tsx`
- S-15 the hard one: `expect(screen.queryAllByRole('tab')).toHaveLength(0)` — the screen's whole
  point.
- S-16…S-21, plus `expectHeadingOutline('Caja del equipo')`.

**7. In the browser** — confirm a hand-in inline as the admin and watch it leave the block; check
`/cash/entregas` survives a round-trip through a drop detail with its facets intact; and read
`/balance` as all three roles at 375 px.

---

## PR-4 — the bounded read *(D12′ — the only server change)*

`getMyBalance` returns the agent's **entire** hand-in history: no `LIMIT`, no `since`, while the
`expenses` read three lines above it *is* shift-scoped. Measured: **386 B per drop row**, 54 % of a
2,128 B payload at three drops, re-fetched on every mount and window focus.

1. `routes/cash/handler.ts` — `.limit(DROPS_PAGE + 1)` on the `getMyBalance` drops query
   (`DROPS_PAGE = 50`), slice to 50, and add `drops_truncated: boolean` to the response.
2. Same shape on `listDrops` (`LIMIT 500 + 1` → `truncated`), matching the seller folio list.
3. `features/cash/types.ts` — the flag, and fix the lying comment: `drops` is **not** "recent".
4. The UI **says when it capped**. A silent truncation reads as "everything is here" when it is not
   (`folio-surface-parity` learned this once already).
5. API tests: seed 60 drops → 50 rows + `drops_truncated: true`; seed 3 → 3 rows + `false`.
   `test/cash/*.test.ts` must still pass **unedited** — its orgs are far below both caps.

---

## PR-5 — the sheets *(US-UX08, D10)*

Four `MuiDialog`s, all inside the merged component after PR-2:

| Dialog | Becomes | Notes |
|---|---|---|
| Entregar efectivo | `FormSheet` | Monto + «Todo» adornment + **Nota (opcional) on both surfaces** — the seller's field reaches the admin, ending finding 5. Footer submit is the sheet's, not `DialogActions`. |
| Disputar (`PendingAcknowledgments`) | `FormSheet` | Motivo required; empty submit refused (S-9). |
| Registrar pago | `ConfirmSheet` | States the amount owed; stacked confirm / cancel (S-10). |
| *(admin hand-in)* | — | Deleted in PR-2; there is only one hand-in sheet. |

Watch for: the drop sheet's error branch (`DROP_EXCEEDS_BALANCE`) and the delete-expense `CONFLICT`
copy must survive; `FormSheet` bodies scroll while the footer is fixed, so the helper text under
Monto must stay in the scroll region.

Test note: sheets portal to `document.body` — query `document`, not `container`. A
`container.querySelectorAll('.MuiDrawer-root')` returned 0 for **both** surfaces in the folio epic
and the test passed vacuously; a deliberate presence assertion is what caught it.

---

## Rollback

Each PR is independently revertible. PR-2 is the only structural one; reverting it restores two
files that are still in git history unchanged. No data, no migration, no server behaviour is
touched by any of the three, so a revert cannot leave the live org in a half-state.
