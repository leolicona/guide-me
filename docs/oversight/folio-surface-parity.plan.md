# Implementation Plan — Folio Surface Parity (US-AG58, US-AG59, US-A93, US-UX07, BUG-034)

> **Spec:** `docs/oversight/folio-surface-parity.spec.md` — decisions cited as D1…D14, scenarios as S-1…S-13.
> **Stack (API):** Hono · Drizzle (D1/SQLite) · vitest (`@cloudflare/vitest-pool-workers`) — **the gate**
> **Stack (App):** React 18 · MUI v6 · TanStack Query
> **Shape:** four PRs, no migration, each a deployable state. Worktrees from `origin/develop`,
> one per PR (`docs/PROCESS.md` § Local workflow). PR-1 ships first because PR-3 renders its fields.

**Standing gates, every PR:** `pnpm --filter api-turistear test` green; the scope-boundary files pass
**unedited** (`test/folios/folio-lifecycle-unification.test.ts`, `test/folios/folio-cancellation.test.ts`,
`test/cash-drops/agent-balance-cash-drops.test.ts`); frontend PRs additionally `tsc -b` +
`pnpm lint:app` + `pnpm build:app` (a bare `tsc --noEmit` checks nothing here — solution-style tsconfig).

---

## PR map

```
PR-1  the payload    shared detail serializer + seller detail renders the money outcome
                     [US-AG59 · BUG-034 · S-1…S-3, S-12, S-13]
PR-2  the list       FolioListScreen(surface) + LIMIT 500 + desde/hasta
                     [US-AG58 · S-4…S-9]
PR-3  the detail     FolioDetailScreen(surface) + FolioWorkActions(surface) + admin QR
                     [US-A93 · S-10]
PR-4  the word       «Venta» across nav, titles, back buttons, empty states + glossary
                     [US-UX07 · S-11]
```

---

## PR-1 — the payload and the money *(US-AG59, BUG-034 · no migration)*

**1. Extract the serializer** — `api-turistear/src/utils/folioDetail.ts` *(new)*
   - `serializeFolioDetail(folio, lines, extras, payments, requests, portalLink, ctx)` — lifted
     verbatim from `routes/folios/handler.ts:270-340` so the admin's bytes do not move.
   - Both callers pass the same `fulfillmentCtx` (`tz`, `marginMinutes`, `nowEpoch`) the list read
     already builds — one clock, per D6.

**2. Rewire both handlers**
   - `routes/folios/handler.ts` → `getFolioDetail` returns `serializeFolioDetail(...)`; the response
     must be byte-identical (assert against a golden fixture in `folio-timeline.test.ts`'s org).
   - `routes/pos/handler.ts` → `getFolio` (line 2277) drops its own literal and calls the same
     function. It must keep reading through its **caller-scoped** query — the serializer formats,
     it never fetches (rule 1).

**3. Frontend types** — `app-turistear/src/features/pos/types.ts`
   - `Folio` gains `refund_status`, `refund_amount`, `refund_note`, `refunded_at`, `credit_amount`,
     `credit_expires_at`, `cancellation_reason`, `cancelled_by`, `fulfillment`, `folio_requests`,
     `commission_amount`. Prefer importing the admin's `FolioDetail` type and deleting the
     divergent one if the shapes are then identical — one type is the point of D6.

**4. Seller detail renders it** — `pages/FolioHistoryDetailPage.tsx` *(interim home; PR-3 moves it)*
   - The cancellation-outcome rows and the credit row, lifted from `FolioDetailPage.tsx:495-570`.
   - `FolioTimeline` now receives `fulfillment`, `requests`, `refundNote` — closing the
     `FolioTimeline.tsx:210` comment, which is deleted with the gap it documented.
   - The refund chips join the chip row in the admin's fixed order (money · clearance · debt · time).

**5. Tests** — `api-turistear/test/folios/folio-surface-parity.test.ts` *(new)*
   - S-1/S-2: seller detail payload carries refund + credit for a cancelled folio.
   - S-3: seller and admin detail payloads are **deep-equal** except `commission_amount`'s presence
     is asserted on both — the mechanical form of D6, and the test that makes the next drift fail.
   - S-12/S-13: cross-org and cross-seller `404`.

---

## PR-2 — the shared list *(US-AG58)*

**1. Server** — `routes/pos/handler.ts` `listAgentFolios` (line 3806)
   - `?date=` → `?desde=&hasta=`, org-local via `utils/tz.ts` (D11; no deprecation — no call sites).
   - `.limit(501)`, return the first 500 with `truncated: rows.length > 500` (D5).
   - `services/posService.ts`: `MyFolioFilters` loses `date`, gains `desde`/`hasta`; `listMyFolios`
     returns `{ folios, truncated }`.

**2. The shared screen** — `features/folios/components/FolioListScreen.tsx` *(new)*
   - Body lifted from `FoliosListPage.tsx`; `surface` decides: which hook (`useFolios` vs
     `useMyFolios`), the byline (`agent.name` vs `operator_name`), the detail route, whether the
     `PendingWorkBar` renders (**seller: no** — D3), and whether the server fallback + scope footer
     exist (**seller: no** — D4; the seller renders the truncation notice instead).
   - Search, `FolioStateSheet`, date pills and `?estado=/?q=/?desde=/?hasta=` are **shared verbatim**
     — including the empty state that names its filters (S-6).
   - `pages/FoliosListPage.tsx` / `pages/FolioHistoryPage.tsx` → wrappers (D2).

**3. Cache** — `features/pos/hooks/useMyFolios.ts`
   - `usePendingDeliveryCount` keys on `{}` like the list and selects from it (D12).

**4. Tests** — `pages/FoliosListPage.test.tsx` → `features/folios/components/FolioListScreen.test.tsx`
   - `describe.each(['admin','seller'])` over URL-as-state, the filter-naming empty state and search
     (S-4…S-7). Surface-specific: the bar renders only for admin, the fallback banner only for
     admin, the truncation notice only for the seller (S-8), no forbidden verb for the seller (S-9).

---

## PR-3 — the shared detail *(US-A93)*

**1.** `features/folios/components/FolioDetailScreen.tsx` *(new)* — from `FolioDetailPage.tsx`;
   `surface` gates the destructive verbs, `BookingActions`, and the refund `FormSheet`.
**2.** `FolioWorkActions` gains `surface` (it hardcodes `"admin"` at line 220); for `seller` only the
   delivery rung can render. The hand-rolled *Entregar boletos* `SectionCard` is deleted.
**3.** H1 = customer name on both; `SectionCard` replaces the raw `<Card>` on both.
**4.** *Boletos de acceso* becomes a shared collapsible section — expanded for the seller, collapsed
   for the admin (D8, S-10).
**5.** Both detail pages → wrappers. `FolioWorkActions.test.tsx` parameterized by surface.

---

## PR-4 — the word *(US-UX07)*

Back buttons → *Ventas*; the admin's empty state → *No hay ventas para mostrar*; sweep
`app-turistear/src` for user-visible *Historial* (the timeline card keeps its own name — it is the
*Historial del folio*, a different object) and *Folios*. `SPEC.md` glossary: «Venta» added, «Folio»
annotated as the domain term the UI no longer uses as a screen name. Close the DoD boxes.
