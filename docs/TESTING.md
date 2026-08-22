# Testing — what is tested where

This repository tests its backend well and its frontend not at all. This file states the strategy
that closes that gap: which layer owns which assertion, what the merge gate is, and what we
deliberately do not test.

**The rule everything else follows:** *a business rule is proven where it is enforced.* The API
enforces the rules (`docs/PROCESS.md` — "a rule the frontend enforces alone is not a rule"), so the
API's tests prove them. Frontend tests prove something different and equally real: that the number
the cashier reads in the sun is the number the API will charge.

---

## Where we are

| | `api-turistear` | `app-turistear` |
|---|---|---|
| Test files | **51** (`test/<domain>/*.test.ts`) | **1** (`e2e/settle-breakdown.spec.ts`) |
| Runner | Vitest 4 + `@cloudflare/vitest-pool-workers` | Playwright 1.62 |
| Source under test | — | 282 files · 65 hooks · 16 service clients · 3 stores |
| Runs in CI? | **Yes** — `pnpm test:api` in the `verify` job | **No** |
| Effective merge gate | 51 suites | `eslint` + `tsc -b` |

The single E2E spec is a **manual verification script, not a gate**: it `test.skip`s unless
`E2E_FOLIO_ID` names a live apartado someone created by hand, it needs two sets of live credentials,
and it drives `app-dev.turistearya.com` — a deployed environment, so it cannot run on a pull
request. It is well documented (`app-turistear/e2e/README.md`) and it did its job for US-LG03/LG08.
It just was never able to stop a regression.

So the whole frontend is protected by a type checker and a linter. `tsc` proves `cartSubtotal`
returns a `number`. Nothing proves it returns the *right* number — and this is a product where a
field agent reads that number aloud and takes cash for it.

---

## The routing rule — which layer owns which assertion

| Kind of logic | Tested where | Why there |
|---|---|---|
| Business rules — cancellation ladder, commissions, capacity, apartado expiry, money ledger | **API Vitest** | The rule is *enforced server-side*. A frontend test asserting a tier threshold creates a second source of truth for it. |
| Cross-org isolation | **API Vitest**, `seedTwoOrgs` (`CLAUDE.md`, hard requirement) | The frontend cannot prove isolation — it only ever sees one org's responses. A frontend test **never** satisfies this requirement. |
| Frontend pure functions — cart arithmetic, calendar/timezone math, message templates | **App Vitest — Tier 1** | No server involved. Wrong here means wrong on screen even when the API is right. |
| Service clients, the 401/suspended interceptor, hooks, query cache behaviour | **App Vitest + MSW — Tier 2** | This is where the app meets the API *contract*, which is hand-mirrored and therefore drifts. |
| Shared primitives, sheets, forms, accessibility | **App Vitest + RTL — Tier 3** | Presentation and interaction, including the design system's non-negotiables (money reads first, state is never colour-alone). |
| A journey crossing a real browser **and** a real API | **Playwright** | Reserved for what the tiers above structurally cannot see: cookies, redirects, SPA navigation, the camera/QR path. |

---

## The three frontend tiers

### Tier 1 — pure logic, no DOM

The highest value per line of test in this repo, because the modules are already extracted:

| Module | What must not silently break |
|---|---|
| `src/store/posCart.ts` | `cartLineTotal` · `cartExtrasTotal` · `cartSubtotal` · `cartDiscountTotal` · `toConfirmPayload` — the price shown to a cash-in-hand customer, and the payload the API is asked to charge |
| `src/features/pos/dates.ts` | `todayStr(tz)` · `addDays` · `addMonths` · `daysInMonth` · `firstWeekdayMondayBased` · `contextPills` — calendar and timezone arithmetic, the classic off-by-one. The API has `test/pos/timezone.test.ts`; the frontend owns a second copy of the same problem |
| `src/features/pos/delivery.ts` | `deliveryState` (a four-state machine) · `fillTemplate` · `ticketWhatsAppUrl` — a malformed URL means the tourist never gets the ticket |
| The 7 Zod modules — 5 × `features/<f>/schemas.ts`, `catalog/…/wizardSchema.ts`, and one declared inline in `ExtraDraftSheet.tsx` | Accept/reject at the boundaries. These gate every form in the product |

**`toConfirmPayload` is the seam.** It is the last thing the frontend decides before the API decides
everything else. Assert its shape hard.

### Tier 2 — service clients and hooks, against MSW

`src/services/authService.ts` first. Its `request` wrapper carries app-wide behaviour that no other
test can see:

- `AUTH_PUBLIC_PREFIX` exempting `/api/auth/*` from the session bounce — so a wrong password on
  `/login` shows an error instead of redirect-looping;
- `handleUnauthorized` building `?redirect=` from the current path;
- `handleSuspended` sending `?reason=suspended` (US-A08) with no return path;
- error-body decoding into `ServiceError { code, status }` — including the non-JSON fallback.

This is BUG-017's neighbourhood, it is global to every screen, and it is testable in jsdom.

Then the 65 feature hooks: each one asserted against MSW handlers, with a fresh `QueryClient`
(retries off) per test. Priority order = money path first (`useCash`, `useFolios`,
`useBookingActions`), then catalog/wizard, then the rest.

### Tier 3 — primitives and sheets

Not every component. These:

- `src/components/` — `MoneyText` (tabular figures, semantic colour, SR label), `StatusChip`
  (**icon-paired** — the design system forbids colour-alone state), `AlertCard`, `BottomSheet`,
  `FormSheet`, `ConfirmSheet`.
- The high-consequence flow sheets: settle, cancellation, cash drop.

Query by **role and accessible name**, never by test id or class. That does three jobs at once:
it asserts behaviour, it asserts accessibility, and it keeps the Playwright selectors honest —
`e2e/settle-breakdown.spec.ts` already queries `getByRole('button', { name: 'Cobrar y liquidar' })`,
so a rename should break a 20 ms test rather than a 90 s one against a deployed environment.

### Playwright — thin, self-seeding, out of the PR gate

Capped at roughly five journeys that genuinely cross the browser/API boundary:

1. login → POS sale → settle *(the existing spec)*
2. cancellation with refund
3. QR scan → redeem
4. cash drop → admin verify
5. affiliate wizard

Each seeds its own data through the API in a `setup` project and tears it down. Nothing waits on a
human to create an apartado and paste an id.

---

## Decisions

| | Decision | Why |
|---|---|---|
| **D1** | **Vitest**, not Jest | The API already runs Vitest 4. One runner, one config vocabulary, one thing to upgrade. |
| **D2** | **jsdom**, not happy-dom | MUI 9 + Emotion; jsdom is the compatible default. Revisit only if the suite gets slow, and say so here if it changes. |
| **D3** | A **separate `vitest.config.ts`**, not `vite.config.ts` | `vite.config.ts` loads `@cloudflare/vite-plugin`, which boots a Worker runtime. Component tests must not. |
| **D4** | **MSW**, not hand-rolled `fetch` stubs | One mock layer for every hook test. The handler file becomes the frontend's written record of the API contract — the thing that today exists only as hand-copied types. |
| **D5** | **Query by role/label**, never `data-testid` | Doubles as an accessibility assertion, and shares its selector vocabulary with Playwright. |
| **D6** | **No coverage threshold** | `pages/` is route assembly with no logic by architectural rule. A percentage target pushes effort into the layer that has the least to prove. |
| **D7** | **Playwright is nightly + label-triggered, not a PR gate** | 90 s timeouts and a real browser. Putting it on every PR buys little and costs the merge queue a lot. |
| **D8** | **Playwright seeds its own fixtures** | The current spec skips without a hand-made `E2E_FOLIO_ID`. A test that skips by default has never gated anything. |
| **D9** | **Frontend tests never assert a rule the API owns** | They assert the *mirror* is faithful, or they assert presentation. This is what stops the cancellation ladder from acquiring a third price. |
| **D10** | Test files **co-located** in `src/`, not a parallel `test/` tree | The frontend is organised by feature folder (`features/<Name>/`). A parallel tree drifts from it; the API's `test/<domain>/` layout works there because the API is organised by resource route. |

---

## What we deliberately do not test

- **MUI internals.** Assert our behaviour, not that a `Dialog` opens.
- **Whole-tree snapshots.** With `createTheme({ cssVariables: true })` every token change churns
  them, and churning snapshots get blind-approved — which is worse than no snapshot.
- **`pages/`.** Route assembly. If a page grows logic worth asserting, that logic belongs in a hook.
- **A coverage number.** See D6.
- **Cross-org isolation from the frontend.** See the routing rule. It is an API-layer proof.

---

## The gate

```
ci.yml · verify:   install → lint:app → test:app → test:api → build:api → build:app
                                        ▲ new
```

`test:app` is `vitest run` in `app-turistear` — Tiers 1–3, no browser, no network, no deployed
environment. It must be a merge gate from the day it exists, or it rots the way the index did.

Playwright runs in its own workflow: nightly against `app-dev`, and on demand when a PR carries the
`e2e` label. It never blocks the merge queue.

---

## Conventions

| Thing | Rule |
|---|---|
| Location | Co-located: `src/store/posCart.test.ts`, `src/features/pos/dates.test.ts` (D10) |
| Naming | `<module>.test.ts` for logic · `<Component>.test.tsx` for RTL |
| Globals | **Off.** Import `describe/it/expect` explicitly, so `tsc` sees the same thing Vitest does |
| Shared render | One `renderWithProviders` in `src/test/` — `ThemeProvider` + `QueryClientProvider` (retries off) + `MemoryRouter`. Never reach for a raw `render` in a component test |
| MSW handlers | `src/test/handlers/<resource>.ts`, mirroring `src/services/<resource>Service.ts` one-to-one |
| Fixtures | Response fixtures copy the shapes the **API tests** assert, not shapes invented for convenience. A fixture that no API test would produce is a test that passes against a fiction |
| Type-checking tests | A `tsconfig.test.json` in the project references, so `tsc -b` covers test files while `tsconfig.app.json` excludes them from the production build |
| E2E secrets | Environment variables only, never committed — the existing `e2e/helpers.ts` `env()` pattern is the standard |
| Timeouts | `testTimeout: 15_000` in `vitest.config.ts`, not the 5 s default. The slowest component tests measure **2.8–8.7 s** (a screen render with MSW + TanStack Query, sometimes typing into a debounced field), so 5 s left no headroom and the suite failed on a different test each parallel run (BUG-036). A test that needs more than 15 s is **hung, not slow** — which is what the timeout is for. Measure with `vitest run --reporter=json` before changing it |

---

## The known gap: contract drift

`app-turistear/src/features/*/types.ts` are hand-mirrored from the API's response shapes. Nothing
detects when the API changes and the mirror does not — and MSW makes this *slightly worse* before it
makes it better, because a handler written from a stale type will happily prove the frontend agrees
with itself.

- **Mitigation now (in the conventions above):** fixtures are copied from what API tests assert.
- **Real fix, deferred:** a shared package exporting the Zod schemas both sides validate against,
  so the mirror cannot drift without a type error. Tracked as `docs/TECH_DEBT.md` #21.

Naming this here rather than pretending MSW solves it, per `docs/PROCESS.md`: *"deferred" alone
reads as forgotten.*

---

## Files

| Purpose | Path |
|---|---|
| Rollout plan for everything above | `docs/testing/frontend-testing.plan.md` |
| API test suites | `api-turistear/test/<domain>/*.test.ts` |
| API runner config | `api-turistear/vitest.config.ts` |
| App runner config *(to be created — Phase 0)* | `app-turistear/vitest.config.ts` |
| E2E config + specs | `app-turistear/playwright.config.ts` · `app-turistear/e2e/` |
| E2E runbook | `app-turistear/e2e/README.md` |
| Merge gate | `.github/workflows/ci.yml` |
| Pipeline & environments | `docs/ci-cd.md` |
| Process the tests serve | `docs/PROCESS.md` |
