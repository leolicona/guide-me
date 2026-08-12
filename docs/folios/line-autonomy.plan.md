# Implementation Plan — Line Autonomy (US-LG09, US-A22, US-AG54, US-A89)

> **Spec:** `docs/folios/line-autonomy.spec.md` — decisions cited as D1…D16, scenarios as S-1…S-17.
> **Stack (API):** Hono · Drizzle (D1/SQLite) · vitest (`@cloudflare/vitest-pool-workers`) — **the gate**
> **Stack (App):** React 18 · MUI v6 · TanStack Query · Zustand
> **Shape:** four phases (D16), each = one migration + one PR-stack + one deployable state.
> Worktrees from `origin/develop`, one per PR (`docs/PROCESS.md` § Local workflow); phases merge
> in order because each builds on the previous phase's schema.

**Standing gates, every PR:** `pnpm --filter api-turistear test` green; the scope-boundary files
pass **unedited** (`test/folios/folio-fulfillment.unit.test.ts`,
`test/cash-drops/agent-balance-cash-drops.test.ts`); frontend PRs additionally `tsc -b` +
`pnpm lint:app` + `pnpm build:app`. Every new route lands with its `seedTwoOrgs` test (S-14).

---

## Phase map

```
F1  the fact      PR-1  allocations util + migration 0062 (table + backfill) + shadow writes
                        [US-LG09 · S-1…S-4, S-15, S-16]
F2  US-A22        PR-2  line cancel backend (migration 0063 + refund debt + rotating PIN + events)
                        [S-5…S-7, S-14]
                  PR-3  frontend: detail per-line cancel + timeline line names + portal outcomes
F3  the gesture   PR-4  per-line settle + clock backend (migration 0064 + sweep per line)
                        [S-8…S-10, S-17]
                  PR-5  frontend: per-line Liquidar / Liquidar todo + checkout allocation echo
F4  cleanup       PR-6  derived status field server-side (the column still exists; readers next)
                  PR-7  QR gates + portal read the line
                  PR-8  lists/facets/search/counts read the line; card semaphore + per-line rows
                  PR-9  migration 0065 (drop columns) + delete derived-field plumbing + reports
                        + SPEC.md close + supersede annotations
                        [S-11…S-13]
```

Backend PRs ship before their frontend sibling so the UI builds against real endpoints
(the bookings plan's rule). F4's split is by **reader surface**, per D11.

---

## F1 — the fact *(PR-1 · migration `0062` · no behaviour change)*

**1. The pure allocation engine** — `api-turistear/src/utils/folioAllocations.ts` *(new)*
   - `seedAndCascade(lines, minPct, amount)` → `{ folioLineId, amount }[]` — D2 seed (org min %
     of each `line_total`, floor-rounded, largest-remainder so Σ seeds = the folio minimum) then
     D3 cascade by earliest departure (reuse the departure ordering already in
     `utils/cancellationPolicy.ts`'s per-line evaluation; stay lines order by `check_in`).
   - `allocateFull(lines)` → one allocation per line at `line_total`.
   - `lineMoneyState(line, allocatedSum)` → `'pagada' | 'apartada'` (rule 3).
   - Pure: no db, no clock. Unit tests beside it (S-2/S-3 arithmetic, rounding edges: 3 lines,
     odd cents, zero-surplus, deposit = total).

**2. Migration** — `api-turistear/migrations/0062_folio_payment_allocations.sql`
   - Table + indexes exactly as spec § Data Model (including `backfilled`).
   - Backfill blocks, 0061-style (deterministic ids `'alc_' || payment_id || '_' || line_id`,
     `NOT EXISTS` guards, source-row `created_at`):
     a. **paid** folios: cascade payments oldest-first across lines to `line_total` each.
     b. **booking** folios: the D2/D3 rule in SQL over `amount_paid` (window functions; the
        oracle test is what proves this SQL — write it after step 3's oracle exists).
     c. **cancelled** folios: allocations for payment AND refund rows, signed, balancing to the
        folio's snapshots.

**3. Migration verification tests** — `api-turistear/test/folios/allocations-backfill.test.ts` *(new)*
   - **S-15**: insert pre-feature-shaped folios (all three classes, no allocations), execute the
     migration's backfill statements (read from the `.sql`, split on `statement-breakpoint`),
     assert the three conservation invariants over everything, assert `backfilled = 1`, re-run →
     zero new rows.
   - **S-16 (the oracle)**: for a grid of booking fixtures, run the SQL blocks AND
     `seedAndCascade` over the same rows — allocations must match exactly.

**4. Schema + shadow writes**
   - `api-turistear/src/db/schema.ts`: `folioPaymentAllocations` table + `FolioPaymentAllocation`
     types, comment pointing at the spec.
   - `api-turistear/src/routes/pos/handler.ts`:
     - `confirmSale` (~L899): in the existing `db.batch`, after the payment row — `allocateFull`
       on the paid path, `seedAndCascade` on the booking path. The idempotency replay path
       (US-AG45 D21) returns before writing — S-4 is free, but test it.
     - `settleBooking` (~L2287): the settle payment allocates each line's remaining balance
       (still all-or-nothing in F1 — behaviour unchanged).
     - `voidExpressSale` (~L3028): the void's refund row allocates negatively against the line.
   - `api-turistear/src/routes/folios/handler.ts`: `cancelFolioPriced` (~L965) and
     `confirmRefund` (~L1513) — refund rows gain matching negative allocations.
   - Write-path invariant assertions live in the tests, not runtime — except rule 1's
     `ALLOCATION_MISMATCH` guard: a tiny `assertAllocations(payment, allocations)` in
     `folioAllocations.ts`, called before every batch.

**5. Fixtures + rehearsal**
   - `api-turistear/scripts/seed-local.mjs`: mixed fixtures — a 2-line mixed folio, a folio with
     two debts, an express void.
   - New tests: `api-turistear/test/folios/folio-allocations.test.ts` (S-1…S-4 through the real
     endpoints).
   - **Prod rehearsal (before merging):** `wrangler d1 export` the production DB, apply 0062 to
     the copy locally, run the S-15 invariant queries against it. A real organization is live —
     this is the step that proves the backfill against the folios that actually exist.

---

## F2 — US-A22: cancel one line *(PR-2 backend, PR-3 frontend · migration `0063`)*

**PR-2 — backend**

**1. Migration** — `api-turistear/migrations/0063_line_cancellation.sql`
   - Columns + outbox index swap per spec § Data Model (mind the `COALESCE` expression index).
   - Backfill: cancelled folios' lines copy `cancelled_at/by/source` verbatim; `refund_amount`
     pro-rata by allocated money, largest-remainder; `refund_status` copied.
   - Extend `allocations-backfill.test.ts` with the 0063 assertions.

**2. Schema** — `src/db/schema.ts`: the five `folioLines` columns; `folioLineId` on
   `folioPayments`, `folioEvents`, `notifications`.

**3. The pricing commit goes per-line** — `api-turistear/src/routes/folios/handler.ts`
   - Extract from `cancelFolioPriced` (~L965) a `cancelLines(folio, lines[], ctx)` that prices
     an arbitrary subset via the existing `LineOutcome` split (`utils/cancellationPolicy.ts:167`)
     and writes, per line: `cancelled_*`, inventory release (slot/zone/stay — the release code
     already iterates lines), commission reversal rows **with `folio_line_id`** (D9), refund
     rows + negative allocations, `refund_status`/`refund_amount` on the line, one
     `cancelled` folio_event with `folio_line_id` (D13), one outbox row per channel keyed by
     line. Total cancel = `cancelLines(all)` — the old path becomes a call of the new one,
     **one commit, still** (rule 6).
   - New handler + route: `POST /api/folios/:id/lines/:lineId/cancel`
     (`routes/folios/index.ts`, `routes/folios/schema.ts`; agent apartado variant beside
     `cancelBooking` at `routes/pos/handler.ts:~2943`). Error codes per spec table.
   - Folio-level `status` write: while the column lives (until F4), `cancelLines` sets
     `folios.status = 'cancelled'` only when **all** lines are cancelled — the worst-case rule
     (D11) applied at write time so every existing reader stays truthful.

**4. Refund debt + rotating PIN**
   - `confirmRefund` (~L1513): iterate the folio's `refund_status='pending'` **lines**, one
     signed refund row + allocations each, mark lines `refunded`, then rotate `refund_pin`
     (crypto-random 6 digits) + reset `refund_pin_attempts` (D7). Portal read
     (`routes/portal/`) serves the current PIN and per-line outcomes.

**5. Events util** — `src/utils/folioEvents.ts`: `folioEventRow` gains optional
   `folioLineId`; payload of `cancelled`/`payment` names the line
   (`service_name`, `slot_date`) so the timeline renders without joins.

**6. Tests** — `test/folios/line-cancellation.test.ts` *(new)*: S-5, S-6, S-7 + S-14 cross-org
   (`test/helpers/tenancy.ts`); `test/folios/folio-cancellation.test.ts` keeps passing (total
   cancel through the new path).

**PR-3 — frontend**

- `app-turistear/src/features/folios/types.ts`: line gains `money_state`, `allocated`,
  `pending_balance`, `cancelled_*`, `refund_status`/`refund_amount`; `FolioEvent` payload types.
- `services/foliosService.ts`: `cancelFolioLine(folioId, lineId, reason?)`.
- `pages/FolioDetailPage.tsx` + `features/folios/components/`: per-line `SectionCard` row —
  state chip (`FolioStatusChip` presets extended), `MoneyText` balance, *Cancelar* via
  `ConfirmSheet` (quote → confirm, reusing the existing cancellation quote sheet per line).
- `FolioTimeline.tsx`: line-scoped events render the line name from the payload.
- Portal page (served by `api-turistear/src/routes/ticket/handler.tsx`): per-line outcome list +
  current PIN.

---

## F3 — the gesture *(PR-4 backend, PR-5 frontend · migration `0064`)*

**PR-4 — backend**

**1. Migration** — `migrations/0064_line_booking_clock.sql`: column + copy-not-recalculate
   backfill (S-17 test in `allocations-backfill.test.ts`).

**2. Per-line clock at birth** — `routes/pos/handler.ts`: the booking path of `confirmSale`
   stamps each line's `booking_expires_at` via `bookingExpiryEpoch` (~L735) against **that
   line's** departure; the folio column (until F4) holds `MIN(line clocks)` so every existing
   reader — reminder urgency, overdue facet — stays truthful.

**3. Per-line settle** — new `POST /api/pos/folios/:id/lines/:lineId/settle`
   (`routes/pos/handler.ts` beside `settleBooking` ~L2287, `routes/pos/schema.ts`):
   payment row + explicit allocation (D4), that line's QR via `signLineTickets` (~L768) when
   rule 5 clears, fixed commission books at *pagada* (D9), `payment` event with the line.
   `settleBooking` becomes the *Liquidar todo* shortcut: one payment row, N allocations
   (§ Open resolved: the ledger's grain is the money event).

**4. Sweep per line** — `routes/pos/sweep.ts`: select **lines** whose clock fired; call
   `cancelLines` per folio with just those lines; ladder + US-A87 credit per line (credit still
   accrues on the folio, D12). `src/index.tsx` `scheduled` unchanged.

**5. Reminder** — `claimReminder` (~L3186) stays folio-level; the template's `{itinerary}` and
   `{pending_balance}` itemize apartada lines only (D12).

**6. Tests** — `test/folios/line-settle.test.ts` *(new)*: S-8, S-9, S-10, Liquidar-todo,
   cross-org; `test/folios/folio-timeline.test.ts` extended for line payloads.

**PR-5 — frontend**

- `services/foliosService.ts` + pos service: `settleFolioLine`; detail page per-line *Liquidar*
  (`FormSheet` with method/reference per US-AG41/US-A88) + *Liquidar todo* button;
  `FolioReceiptPage.tsx` shows per-line states; countdown chips per line
  (`folioCardState.ts` countdown moves to the line row).

---

## F4 — cleanup *(PR-6…PR-9 · migration `0065` last)*

**PR-6 — the derived field, server-side.** `routes/folios/handler.ts` + `routes/pos/handler.ts`
list/detail serializers compute `status` worst-case from lines (one shared
`deriveFolioStatus(lines)` in `utils/folioListRows.ts`); writes to `folios.status` stop being
read anywhere server-side except the five gates (next PR). API responses byte-identical (S-11).

**PR-7 — the gates + portal read the line.**
`routes/tickets/handler.ts:~108` (scanner redemption), `routes/ticket/handler.tsx:~161`
(portal SSR), `routes/pos/handler.ts:~2523/2873/2918`: each gate answers from the **line**
(`money_state === 'pagada'` + rule 5 clearance + line not cancelled). S-13 test:
`test/tickets/` gains the half-cancelled-folio case.

**PR-8 — lists, facets, search, counts, card.**
- API: `utils/folioListRows.ts`, `utils/folioSearch.ts`, `utils/folioPendingWork.ts` (extended
  per line — feeds pills AND the semaphore), `listFolioCounts` (~L605) any-line semantics (D15).
- App: `features/folios/folioCardState.ts` — the rail becomes the attention roll-up (D14;
  derive from the shared pending-work shape, not its own inputs); `folioFacets.ts` any-line;
  `FolioCard.tsx` per-line icon+state rows (customer header stays); `FolioStateSheet.tsx`,
  `PendingWorkBar.tsx`, `FoliosListPage.tsx`, `FolioHistoryPage.tsx`. Tokens cited, not
  restated (`DESIGN_TOKENS.md` §3).
- `app-turistear/e2e/folio-ladder.spec.ts` updated for the new card reading.

**PR-9 — the drop.**
- `migrations/0065_retire_folio_status.sql` per spec (decide `settled_at/By` here — § Open).
- Delete the derived-field plumbing where no longer consumed; `reports/` queries move to line
  states; remove `folios.status` from `schema.ts`, Zod schemas, `features/folios/types.ts`.
- Close the epic (`PROCESS.md` step 7): tick spec DoD + `SPEC.md` boxes, annotate the
  superseded decisions in `folio-state-machine.spec.md` (scope boundary 1–2),
  `folio-list-scanability.spec.md` (D4), `bookings-down-payments.spec.md` (one-shot settle +
  single clock); move `Deferred` rows to `TECH_DEBT.md` if still open.

---

## Deploy notes

- Each phase's release PR (`develop → main`) carries its migration; `wrangler d1 migrations
  apply` runs it against prod during `deploy:api` (`docs/ci-cd.md`). **F1's release is gated on
  the prod-export rehearsal** (F1 step 5).
- F2 and F3 change customer-visible behaviour (per-line cancellation messages, partial holds) —
  their release notes name the Known-behaviour-change bullets from the spec.
- Rollback story: F1–F3 are additive; reverting the code leaves unused columns/rows, harmless.
  F4/0065 is the point of no return — hence last, after every reader is migrated and green.
