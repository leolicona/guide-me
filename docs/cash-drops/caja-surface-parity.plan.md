# Implementation Plan — Caja Surface Parity (US-A97, US-UX08)

> **Spec:** `docs/cash-drops/caja-surface-parity.spec.md` — decisions cited as D1…D13, scenarios as S-1…S-14.
> **Stack (App):** React 18 · MUI **v9** · TanStack Query · vitest + jsdom + MSW + RTL
> **Shape:** three PRs, **frontend only** — no migration, no endpoint, no server file touched.
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
                      [US-A97 · D1–D9, D11–D13 · S-1…S-7, S-11…S-14]
PR-3  the sheets      four MUI Dialogs → FormSheet / ConfirmSheet
                      [US-UX08 · D10 · S-8, S-9, S-10]
```

PR-2 before PR-3: the sheets are rewritten **once**, inside the merged component, instead of twice
in two doomed copies.

---

## PR-1 — the spec *(no code)*

1. `docs/cash-drops/caja-surface-parity.spec.md` + this plan.
2. `docs/SPEC.md`:
   - **US-A97** under *Admin*, **US-UX08** under *Cross-cutting UX*.
   - A *Features by Phase* line linking the spec (unchecked until PR-3 merges).
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

## PR-3 — the sheets *(US-UX08, D10)*

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
