# Implementation Plan — Frontend test harness (Tiers 1–3 + Playwright rework)

> **Strategy:** `docs/TESTING.md` — read it first; this file is only the order you type things in.
> **Stack (App):** React 19.2 · MUI 9 · TanStack Query 5 · Zustand 5 · Zod 4 · Vite 8 · TS 6
> **Adds:** Vitest 4 (matching the API) · jsdom · Testing Library · MSW 2
> **Touches no product code.** Every phase adds test files, config, or CI steps. If a phase needs a
> `src/` change to make something testable, that is a finding — record it, do not smuggle it in.

**Scope:** the merge-gate floor the frontend does not have (`docs/TESTING.md` — 282 files, 0 unit
tests), plus making the one existing Playwright spec able to run unattended.
**Deferred:** shared Zod contract package (`TECH_DEBT.md` #21) · visual regression · a local
full-stack `webServer` for Playwright (§ Deferred).

---

## Phases

```
Phase 0 → Harness: deps, vitest.config, setup, tsconfig, test:app, CI gate      [~½ day]
Phase 1 → Tier 1 — pure logic: posCart · dates · delivery · schemas             [~1 day]
Phase 2 → authService: the 401 / suspended / ServiceError interceptor           [~½ day]
Phase 3 → Tier 2 — MSW handlers + the money-path hooks                          [~2 days]
Phase 4 → Tier 3 — primitives, the settle/cancel sheets, axe                    [~2 days]
Phase 5 → Playwright: self-seeding fixtures + nightly workflow                   [~1–2 days]
```

Phases 0–2 have **no dependency on the API contract** and land first — they are the cheapest
protection and they prove the harness works before anyone writes an MSW handler. Phases 3–4 are the
bulk. Phase 5 is independent of 1–4 and can run in parallel if two people are on it.

**One PR per phase** (`docs/PROCESS.md` — a worktree and a PR per unit of work). Branch
`test/<slug>`; commits `test(pos):`, `test(auth):`, `chore(ci):` as the scope demands.

---

## Phase 0 — Harness

**Files:** `app-turistear/package.json` · `app-turistear/vitest.config.ts` *(new)* ·
`app-turistear/src/test/setup.ts` *(new)* · `app-turistear/tsconfig.test.json` *(new)* ·
`app-turistear/tsconfig.app.json` · `app-turistear/tsconfig.json` · `package.json` (root) ·
`.github/workflows/ci.yml`

1. **Install** into `app-turistear` devDependencies (let pnpm resolve versions; the constraints that
   matter are Vitest **4** to match `api-turistear`, and Testing Library React **≥16** for React 19):

   ```
   vitest jsdom @testing-library/react @testing-library/dom
   @testing-library/user-event @testing-library/jest-dom msw
   ```

2. **`vitest.config.ts` — a separate file, not `vite.config.ts`** (`TESTING.md` D3). The app's
   `vite.config.ts` loads `@cloudflare/vite-plugin`, which boots a Worker runtime; jsdom tests must
   not. Import **only** `@vitejs/plugin-react`:

   ```ts
   import { defineConfig } from 'vitest/config'
   import react from '@vitejs/plugin-react'

   export default defineConfig({
     plugins: [react()],
     test: {
       environment: 'jsdom',
       globals: false,                       // TESTING.md § Conventions
       setupFiles: ['./src/test/setup.ts'],
       include: ['src/**/*.test.{ts,tsx}'],
       exclude: ['e2e/**', 'node_modules/**'],
       restoreMocks: true,
     },
   })
   ```

3. **`src/test/setup.ts`.** With `globals: false`, Testing Library's automatic cleanup does **not**
   register — call it explicitly or state leaks between tests:

   ```ts
   import '@testing-library/jest-dom/vitest'
   import { afterEach } from 'vitest'
   import { cleanup } from '@testing-library/react'

   afterEach(cleanup)
   ```

   Also stub what jsdom lacks and MUI reaches for: `window.matchMedia`, `ResizeObserver`,
   `IntersectionObserver`. Add each only when a test actually fails without it — an unused stub is a
   lie about what the environment provides.

4. **`src/test/renderWithProviders.tsx`.** `ThemeProvider` (the real `config/theme.ts` — component
   tests must see real tokens) + `QueryClientProvider` with a **per-call** `QueryClient`
   (`retry: false`, `gcTime: 0`) + `MemoryRouter` with an `initialEntries` option. Re-export
   everything from `@testing-library/react` so tests import from one place.

5. **TypeScript.** Test files live in `src/` (D10) but must not enter the production build:
   - `tsconfig.app.json` → add
     `"exclude": ["src/**/*.test.ts", "src/**/*.test.tsx", "src/test/**"]`
   - new `tsconfig.test.json` → extends `tsconfig.app.json`, includes only those paths, adds
     `"types": ["vite/client"]`
   - `tsconfig.json` → add `{ "path": "./tsconfig.test.json" }` to `references`, so `tsc -b` still
     type-checks the tests.

   Verify `pnpm build:app` is unchanged after this — that is the check that the exclude worked.

6. **Scripts.** `app-turistear/package.json`: `"test": "vitest run"`, `"test:watch": "vitest"`
   (mirroring `api-turistear`). Root `package.json`: `"test:app": "pnpm --filter app-turistear test"`.

7. **CI.** In `.github/workflows/ci.yml`, insert between *Lint (app)* and *Test (api)*:

   ```yaml
   - name: Test (app)
     run: pnpm test:app
   ```

8. **One smoke test** so the phase is provably green rather than vacuously green — e.g.
   `src/components/MoneyText.test.tsx` rendering a single amount and asserting the formatted string.

**Gate:** `pnpm test:app` green · `pnpm lint:app` green · `pnpm build:app` byte-equivalent output ·
`verify` passes on the PR.

---

## Phase 1 — Tier 1: pure logic

**Files (new):** `src/store/posCart.test.ts` · `src/features/pos/dates.test.ts` ·
`src/features/pos/delivery.test.ts` · `src/features/<f>/schemas.test.ts` ×5 ·
`src/features/catalog/components/wizard/wizardSchema.test.ts`

No DOM, no mocks, no providers. Assert values.

**`posCart.test.ts`** — the money seam:
- `cartExtrasTotal` / `cartLineTotal` for both line kinds (`SlotCartLine`, `StayCartLine`), including
  a line with no extras and a line with several.
- `cartSubtotal` / `cartDiscountTotal` / `cartTotal` over an empty cart, one line, many lines.
  Note that `cartTotal === cartSubtotal` today — if that is intentional, the test documents it; if
  the discount is meant to subtract, this test is what finds out.
- `lineKey` uniqueness across two lines that differ only in slot/date.
- `toConfirmPayload` — the exact `ConfirmSaleInput` shape sent to the API. Assert keys and nesting,
  not just totals.
- Store actions (`usePosCart`): add → quantity clamp at both bounds (`clamp` is currently private —
  exercise it through the action, do not export it just for the test) → remove → clear.

**`dates.test.ts`** — pin the clock (`vi.setSystemTime`) so results are deterministic:
- `todayStr` with an explicit tz and across a UTC-day boundary (an agent in Mexico at 19:00 local is
  already "tomorrow" in UTC — that is the bug class).
- `addDays` / `addMonths` across month and year ends; `addMonths` onto a 31st landing in a 30-day
  month.
- `daysInMonth` for February in a leap and non-leap year.
- `firstWeekdayMondayBased` for a month starting on a Sunday (the value that is 6, not 0).
- `contextPills` — the three keys, and their behaviour when *today* is itself a weekend.

**`delivery.test.ts`**:
- `deliveryState` — all four states plus the precedence between them when several fields are set.
- `fillTemplate` — every `TEMPLATE_PLACEHOLDERS` entry substituted; an unknown placeholder left
  intact rather than replaced with `undefined`; both default templates rendered end to end.
- `ticketWhatsAppUrl` — a valid URL with the message percent-encoded (accents and newlines are the
  interesting inputs), and `null` on the missing-data path.

**Schemas** — the 5 `features/<f>/schemas.ts` plus `catalog/components/wizard/wizardSchema.ts`. For
each: one valid object, and one rejection per field with a boundary value (empty string, zero,
negative, over-max). Assert the *issue path*, not just that it threw. The seventh Zod schema is
declared **inline inside `ExtraDraftSheet.tsx`** and is therefore only reachable through a component
test — cover it in Phase 4, or extract it to `schemas.ts` in its own PR (the better fix; do not
extract it inside this one).

**Gate:** `pnpm test:app` green. Any behaviour that surprises you gets written up in `docs/BUGS.md`
and fixed in its own PR — **not patched inside this one**.

---

## Phase 2 — `authService`: the global interceptor

**Files (new):** `src/services/authService.test.ts`

Stub `global.fetch`; stub `window.location` (jsdom forbids assigning `.replace` directly — replace
the whole `location` with a configurable object in `beforeEach`). Spy on
`queryClient.removeQueries`.

- **Success:** `res.ok` → parsed JSON returned, `credentials: 'include'` present,
  `Content-Type: application/json` set **only** when a body is passed.
- **Error decoding:** a JSON error body → `ServiceError` with `code` and `status` from the body; a
  non-JSON body (HTML 502) → falls back to `code: 'UNKNOWN'` and `res.statusText` without throwing a
  parse error.
- **401 on a protected path** → `removeQueries(['me'])` and a redirect to
  `/login?redirect=<encoded path + search>`.
- **401 already on `/login`** → **no** redirect (the loop guard).
- **401 on `/api/auth/*`** → no redirect, `ServiceError` propagates. *This is the wrong-password
  case: it must surface as a form error, not a bounce.*
- **Suspended (US-A08)** → `/login?reason=suspended`, and idempotent when the URL already carries it.

**Gate:** `pnpm test:app` green. This phase is the one most likely to find something — BUG-017 lived
here.

---

## Phase 3 — Tier 2: MSW + the money-path hooks

**Files (new):** `src/test/handlers/*.ts` (one per service client) · `src/test/server.ts` ·
`src/features/<f>/hooks/*.test.ts`

1. **`src/test/server.ts`** — `setupServer(...handlers)`; wire `beforeAll(listen({ onUnhandledRequest: 'error' }))`,
   `afterEach(resetHandlers)`, `afterAll(close)` into `src/test/setup.ts`. `'error'` rather than
   `'warn'`: an unhandled request means the test is asserting against nothing.
2. **Handlers mirror `src/services/` one-to-one** — `posService.ts` → `handlers/pos.ts`. Fixtures
   copy shapes the **API tests** assert (`api-turistear/test/pos/*.test.ts`,
   `test/paid-ledger/*.test.ts`), not shapes invented here (`TESTING.md` § Conventions).
3. **Hooks, money path first:** `features/cash/hooks/useCash.ts`,
   `features/folios/hooks/useFolios.ts`, `features/bookings/hooks/useBookingActions.ts`,
   `features/pos/hooks/*`. Per hook: the success shape; the `ServiceError` path (loading → error,
   no unhandled rejection); for mutations, the cache invalidation actually firing — assert the
   refetch, not the `invalidateQueries` call.
4. Then the catalog/wizard hooks (`useCreateServiceFull`, `useCreateLodgingFull`) — multi-step
   orchestration, so assert **call order and payloads**, and the partial-failure path.

Remaining hooks land opportunistically: **a PR that touches a hook adds its test.** Do not schedule
a sweep of all 65; that produces low-value tests written by someone with no context on the feature.

**Gate:** `pnpm test:app` green; no `onUnhandledRequest` errors.

---

## Phase 4 — Tier 3: primitives, sheets, accessibility

**Files (new):** `src/components/*.test.tsx` · sheet tests under
`src/features/{folios,cash,bookings}/components/`

Everything via `renderWithProviders`, queried by **role and accessible name** (D5).

1. **Primitives:** `MoneyText` (formatting incl. zero and negative; semantic colour by variant; the
   screen-reader label present) · `StatusChip` (**every preset renders an icon** — the design
   system's "state is never colour-alone" rule, and this test is what enforces it) · `AlertCard` ·
   `SectionCard` · `ListRow` · `InfoPopover`.
2. **Overlay hosts:** `BottomSheet` (open/close, focus trap, Escape) · `FormSheet` (submit disabled
   while pending; footer stays fixed) · `ConfirmSheet` (confirm and cancel each fire exactly once —
   double-submit is a real risk on a phone).
3. **Flow sheets:** the settle sheet (method picker → reference field appears for
   Transferencia → submit payload), cancellation, cash drop. These are the components
   `e2e/settle-breakdown.spec.ts` drives; the labels asserted here must be the labels it queries.
4. **Accessibility:** add `axe` assertions inside these tests rather than as a separate suite.
   Touch targets ≥48px and AA contrast come from the theme and are verified in
   `.design/design-system/DESIGN_TOKENS.md` — do **not** re-assert token values here
   (`docs/PROCESS.md` § one source).

**Gate:** `pnpm test:app` green; axe clean on every sheet.

---

## Phase 5 — Playwright: self-seeding + nightly

**Files:** `app-turistear/playwright.config.ts` · `app-turistear/e2e/setup/seed.setup.ts` *(new)* ·
`app-turistear/e2e/helpers.ts` · `app-turistear/e2e/settle-breakdown.spec.ts` ·
`app-turistear/e2e/README.md` · `.github/workflows/e2e.yml` *(new)*

The blocker is D8: the spec skips unless a human hands it `E2E_FOLIO_ID`.

1. **A `setup` project** that runs before the specs: log in via the API, create the apartado with a
   cash deposit, save `storageState` to `e2e/.auth/`, and expose the folio id through a fixture.
   `e2e/create-apartado.mjs` and `save-auth.mjs` already do most of this by hand — fold them in
   rather than rewriting, and delete them once folded so there is one path, not two.
2. **Teardown** cancels or marks the seeded folio, so nightly runs do not accumulate junk in dev.
3. **Drop the `test.skip`.** With seeding, missing credentials should **fail loudly** — the existing
   `env()` helper already throws with a clear message. A suite that silently skips is a suite that
   reports green while testing nothing.
4. **`.github/workflows/e2e.yml`** — `schedule` (nightly) + `pull_request` gated on the `e2e` label
   + `workflow_dispatch`. Credentials from GitHub secrets under the existing `dev` environment
   (`docs/ci-cd.md`). Upload the HTML report as an artifact. **Not** part of `verify` (D7).
5. **Update `e2e/README.md`:** the deployment-prerequisite warning is now historical (the
   paid-ledger stack is on `develop`), `E2E_FOLIO_ID` becomes optional-override rather than
   required, and the new workflow gets documented.
6. Add the remaining four journeys (`TESTING.md` § Playwright) **one PR each**, only after the
   seeding harness is proven by the settle spec.

**Gate:** `pnpm test:e2e` green from a clean shell with credentials only — no hand-made fixture,
nothing skipped.

---

## Deferred, and why deferring is safe

| Deferred | Why it is safe for now |
|---|---|
| **Local full-stack `webServer` for Playwright** (spin up the API worker + local D1 + `vite preview`, so E2E runs on a PR) | The largest single lift here: fixed dev ports (BUG-008), local D1 migrations, and seeded auth all have to line up. Nightly-against-dev catches the same regressions roughly a day later, and Tiers 1–3 catch the fast ones in seconds. Revisit if a nightly-only regression ever reaches prod. |
| **Shared Zod contract package** | The real fix for hand-mirrored types. Fixtures copied from API tests hold the line meanwhile. `TECH_DEBT.md` #21. |
| **Visual regression / screenshot snapshots** | The design system is still moving; snapshots taken now would churn and get blind-approved. Worth revisiting once `DESIGN_TOKENS.md` settles. |
| **A sweep over all 65 hooks** | Phase 3 covers the money path; the rest arrive with the PRs that touch them, written by someone holding the context. |

---

## Definition of Done

- [ ] `pnpm test:app` exists and runs Tiers 1–3 with no browser, network, or deployed environment
- [ ] `test:app` is a step in the `verify` job — the app has a real merge gate
- [ ] `pnpm build:app` output unchanged by the tsconfig split
- [ ] `posCart`, `dates`, `delivery` and all 7 Zod schema modules have tests (Phase 1)
- [ ] `authService.request` covers 401-protected, 401-on-`/login`, 401-on-`/api/auth/*`, suspended,
      and non-JSON error bodies (Phase 2)
- [ ] MSW handlers exist for every module in `src/services/`, with `onUnhandledRequest: 'error'`
- [ ] Money-path hooks tested; the convention "a PR touching a hook adds its test" is in `TESTING.md`
- [ ] Every `components/` primitive tested; `StatusChip` proven icon-paired on every preset
- [ ] axe clean on the settle, cancellation and cash-drop sheets
- [ ] Playwright seeds its own fixtures; nothing skips; `e2e.yml` runs nightly and on the `e2e` label
- [ ] `e2e/README.md` reflects the seeded flow
- [ ] `TECH_DEBT.md` #21 (contract drift) recorded
- [ ] Anything Phase 1–2 uncovered is in `docs/BUGS.md`, fixed in its own PR
