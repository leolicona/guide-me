# Implementation Plan — Bookings / Down-payments (Apartados) (US-AG07, US-AG07.1–.5, US-A46)

> **Spec:** `docs/bookings/bookings-down-payments.spec.md`
> **Stack (API):** Hono · Drizzle (D1/SQLite) · vitest (`@cloudflare/vitest-pool-workers`) — **the gate**
> **Stack (App):** React 18 · MUI v6 · TanStack Query · Zustand
> **Refines:** `POST /api/pos/folios` (confirmSale) splits into create-booking vs settle; the
> existing **full paid path is byte-unchanged** when no `down_payment` is supplied.

**Scope (this phase):** org-level policy only (cascade-ready resolver), booking create, one-shot
settle, manual cancel, reminder, auto-expiry sweep, **reactivation only** of US-AG07.5, adaptive
checkout, and apartado recovery **integrated into the existing Ventas list + folio detail** (D9 —
no dedicated dashboard/route). **Deferred:** per-service overrides, B2B `scan_allowed_unpaid`,
reschedule + coupon (§1.2 of the spec).

The data model is **already provisioned** for the core (`folios.status:'booking'`,
`folios.amount_paid`). Net-new is additive columns + a handler branch + 4 small endpoints + the
repo's first scheduled Worker.

---

## Phases

```
Phase 0 → Migration + schema (org policy cols, folio booking cols)
Phase 1 → Policy resolver + confirmSale booking mode + apartado email          [US-AG07, AG07.1]
Phase 2 → Settle endpoint (deferred QR/portal/email + commission top-up)        [US-AG07]
Phase 3 → Manual cancel + reminder endpoints                                    [US-AG07.4, AG07.3]
Phase 4 → Auto-expiry sweep (wrangler cron + scheduled handler)                 [US-AG07 P3]
Phase 5 → Reactivate endpoint                                                   [US-AG07.5]
Phase 6 → Org policy edit (PUT /organizations/me) + admin settings UI           [US-A46]
Phase 7 → Frontend: adaptive amount-driven checkout                             [US-AG07.2]
Phase 8 → Frontend: Ventas-list recovery (urgency + WhatsApp + dim), no dashboard [US-AG07.3, D9]
Phase 9 → Frontend: folio-detail expiry banner + Liquidar/Cancelar/Reactivar      [US-AG07/.4/.5, D9]
Phase 10 → Cash-drawer carve-out coordination + review against spec + gates
```

Phases 0–5 are backend (each ends green on `pnpm --filter api-guideme test`). 6 is full-stack.
7–9 are frontend (`tsc -b` + `lint:app` + `build:app` per boundary). The backend ships first so
the UI builds against real endpoints.

---

## Phase 0 — Migration + schema

**Files:** `api-guideme/src/db/schema.ts`, a new migration under `api-guideme/migrations/`.

1. `organizations` += `bookingMinDownPaymentPct` (default 0), `bookingHoldDays` (default 7),
   `sameDayBufferMinutes` (default 15).
2. `folios` += `bookingExpiresAt` (ts, null), `settledAt` (ts, null), `settledBy` (text→users, null),
   `reminderStatus` (enum `none|sent`, default `none`), `reminderSentAt` (ts, null),
   `reminderSentBy` (text→users, null).
3. `folio_lines` += `commissionType` (enum `percent|fixed`, default `percent`), `commissionValue`
   (int, default 0) — **confirmed**: snapshot the service's commission inputs per line at sale so
   settle re-derives commission without re-reading a possibly-edited service.
4. Hand-write the SQL migration (additive `ALTER TABLE … ADD COLUMN`). **Do NOT** add the deferred
   `services.*Override` / `folios.scan_allowed_unpaid` columns.
4. Regenerate types if needed; run the suite (existing 325 tests stay green — additive only).

---

## Phase 1 — Policy resolver + booking creation

**Files:** `api-guideme/src/routes/pos/handler.ts`, `…/pos/schema.ts`, `api-guideme/src/services/resend.ts`.

1. **Schema:** `confirmSaleSchema` += `down_payment: z.number().int().min(1).optional()`. Bounds stay
   in the handler (depend on server-computed `total` + org policy), mirroring the discount floor.
2. **Resolver** (new, cascade-ready): `resolveBookingPolicy(service, org)` → `{ minDownPaymentPct,
   holdDays, sameDayBufferMinutes }` = `service.override ?? org.global` (this phase: returns org
   globals; the `service` arg is accepted but unused). `resolveBookingExpiry(policy, createdAt,
   earliestSlotStart)` → `min(createdAt + holdDays·86400, earliestSlotStart − tourBuffer)` where
   `tourBuffer = sameDay ? sameDayBufferMinutes·60 : 86400` (§4.2). `earliestSlotStart` from the
   cart's min `slot_date`+`slot_start_time` (naive-calendar, mirroring `utcToday`/`addDays`).
3. **confirmSale branch** (after `total`/`commission` are computed, before decrement is fine; the
   branch only changes the persisted folio + the post-commit side effects):
   - `down_payment == null` → unchanged paid path.
   - `down_payment != null` → require `customer_phone` present + dialable (else `400`); guard
     `down_payment < total` (else `400`); `minRequired = ceil(total·pct/100)`,
     `down_payment ≥ minRequired` (else `400 DOWN_PAYMENT_BELOW_MINIMUM`). Persist `status:'booking'`,
     `amountPaid: down_payment`, `commissionAmount: round(fullPercent·down_payment/total)`,
     `bookingExpiresAt`. **Skip** QR signing, portal token, ticket email; **send** the apartado
     email instead.
   - **Both paths** now write `commissionType`/`commissionValue` onto each `folio_line` (the
     service snapshot already read in the prepare step) — see Phase 0.3.
4. **Refactor for reuse:** extract the QR-signing + portal-token + ticket-email block from
   `confirmSale` into a helper (e.g. `finalizePaidFolio(c, db, org, folioId, prepared, input)`) so
   the paid path and Phase 2 settle both call it. Keep `confirmSale`'s decrement/compensation inline.
5. **Email:** add `sendBookingConfirmationEmail` (deposit received, pending balance, expiry date) to
   `resend.ts`; fire via `c.executionCtx.waitUntil` (best-effort, never blocks the commit).
6. **Tests** (`test/pos/pos-bookings-create.test.ts`): Sc.1–6, 8 (creation half), 17 backward-compat.

---

## Phase 2 — Settle endpoint

**Files:** `…/pos/handler.ts`, `…/pos/index.ts`.

1. `POST /folios/:id/settle` → `settleBooking`. Read the folio caller-scoped (`agent_id = caller`,
   in-org). Guards: missing → `404`; `paid` → `409 ALREADY_SETTLED`; `cancelled` →
   `409 FOLIO_CANCELLED`; `now > booking_expires_at` → `409 BOOKING_EXPIRED`.
2. Effect (one batch): `status:'paid'`, `amountPaid: total`, `settledAt: now`, `settledBy: caller`,
   `commissionAmount: fullPercent + fullFixed` (re-derive from `folio_lines` using the per-line
   `commission_type`/`commission_value` snapshot from Phase 0.3 — `percent` → basis points of
   `line_total`, `fixed` → `value × quantity`). Inventory untouched.
3. Call the Phase-1 `finalizePaidFolio` helper to mint per-line QR + portal token + ticket email.
   (Re-sign from the stored `folio_lines` — same payload shape as confirmSale.)
4. Register the route in `index.ts` (after `/folios/:id`). **Tests:** `pos-bookings-settle.test.ts`
   — Sc.7, 8 (settle half), 9 guards, 16 isolation (settle a foreign folio → 404).

---

## Phase 3 — Manual cancel + reminder

**Files:** `…/pos/handler.ts`, `…/pos/index.ts`, `…/pos/schema.ts`.

1. `POST /folios/:id/cancel` (`{ reason?: string }`) → `cancelBooking`: caller-scoped; require
   `status:'booking'` (else `409`). One batch: re-increment each line's `slots.booked` by its
   `quantity` (release), `status:'cancelled'`, `cancelledAt/By: caller`, `cancellationReason`,
   `refundStatus:'none'` (deposit retained — D7). Commission unchanged.
2. `POST /folios/:id/reminder` (`{ force?: boolean }`) → `claimReminder`: caller-scoped; require
   `status:'booking'`. **Atomic claim** (D6): conditional `UPDATE … SET reminder_status='sent',
   reminder_sent_at/by WHERE id=? AND organization_id=? AND reminder_status='none'` `.returning()`.
   1 row → `{ claimed:true }`; 0 rows → re-read and return `{ claimed:false, reminder_sent_at,
   reminder_sent_by }`. `force:true` → unconditional update → `{ claimed:true }`.
3. `listAgentFolios` row += `booking_expires_at`, `pending_balance` (= `total − amount_paid`),
   `reminder_status`, `reminder_sent_at`, `reminder_sent_by`. **Tests:** `pos-bookings-cancel.test.ts`
   — Sc.10, 14, **14b (collision: second caller gets `claimed:false`; `force` re-claims)**; isolation (Sc.16).

---

## Phase 4 — Auto-expiry sweep (repo's first scheduled Worker)

**Files:** `api-guideme/wrangler.jsonc`, `api-guideme/src/index.tsx`, a new `…/pos/sweep.ts`.

1. `wrangler.jsonc` += `"triggers": { "crons": ["*/15 * * * *"] }`.
2. `src/index.tsx`: keep the Hono app as `fetch`; add `export default { fetch: app.fetch, scheduled }`.
   `scheduled(event, env, ctx)` → `ctx.waitUntil(sweepExpiredBookings(env))`.
3. `sweepExpiredBookings(env)`: select `status:'booking' AND booking_expires_at <= now`. For each,
   one batch per folio (each write filtered by **that folio's** `organization_id`): release spots,
   `status:'cancelled'`, `cancellationReason:'Apartado vencido'`, `cancelledBy: null`. Deposit
   retained (no refund). Reuse the Phase-3 release logic (extract a shared `releaseBookingSpots`).
4. **Tests:** `pos-bookings-sweep.test.ts` — drive `sweepExpiredBookings(env)` directly (don't rely
   on cron firing): Sc.11; isolation (a foreign expired booking is swept under its own org, never
   mixed). Verify `slots.booked` decremented + folio `cancelled`.

---

## Phase 5 — Reactivate endpoint

**Files:** `…/pos/handler.ts`, `…/pos/index.ts`.

1. `POST /folios/:id/reactivate` → `reactivateBooking`: caller-scoped; require `status:'cancelled'`
   **and** `booking_expires_at != null` (i.e. it was a booking, not an admin-cancelled paid folio).
2. Atomic re-decrement of each line's slot using the **effective-capacity** guard (same
   `capacity + flexMargin − booked >= qty` conditional UPDATE as confirmSale), with compensation on
   partial failure → `409 NO_CAPACITY_AVAILABLE`. On success: `status:'booking'`, fresh
   `bookingExpiresAt` (re-run the resolver). The client then calls settle.
3. **Tests:** `pos-bookings-reactivate.test.ts` — Sc.12 (capacity), Sc.13 (full → 409), isolation.

---

## Phase 6 — Org policy (US-A46)

**Files:** `api-guideme/src/routes/organizations/` (schema + handler), `app-guideme` admin settings.

1. Extend the org-update Zod schema with `booking_min_down_payment_pct` (int 0–100),
   `booking_hold_days` (int ≥ 1), `same_day_buffer_minutes` (int ≥ 0). Range → `400`.
2. Handler writes them org-scoped; serializer echoes them.
3. **Admin UI:** three fields in org settings — *Depósito mínimo (%)*, *Vigencia (días)*,
   *Margen mismo día (min)*. Plain MUI inputs + helper text. **Tests:** org-update validation +
   isolation (an admin can only edit their own org).

---

## Phase 7 — Adaptive checkout (US-AG07.2, frontend)

**Files:** `app-guideme/src/features/pos/components/ServiceSelectionPanel.tsx` (or the checkout
sub-component), `…/services/posService.ts`, `…/features/pos/hooks/`.

1. Replace the confirm CTA with the **amount-driven** model. Local `amount` state seeded to
   `cartTotal`. Derive `saleType`/`buttonLabel`/`disabled` from the §2 table:
   `amount === total` → `FULL` / *Finalizar Pago*; `min ≤ amount < total` → `PARTIAL` /
   *Registrar Reserva*; `0 < amount < min` → disabled *Monto Insuficiente*; `amount > total` →
   disabled *Excede el Total*. `min = ceil(total·orgMinPct/100)` (from the catalog/service payload).
2. **Suggested chip** `Reservar con X% ($Y)` rendered only when `orgMinPct > 0`; tap sets
   `amount = Y` and lights the chip; chip lit ⇔ `amount === Y` (render-phase derived — no effect).
3. On confirm: `FULL` → existing payload (no `down_payment`); `PARTIAL` → add `down_payment: amount`
   and make the **phone field required** (inline validation before submit).
4. Service/catalog payload must expose `booking_min_down_payment_pct` (add to the POS service
   serializer so the client can compute `min`/the chip). Invalidate folio/dashboard queries on success.

---

## Phase 8 — Recovery on the existing Ventas list (US-AG07.3, frontend — D9, no dashboard)

> **Revised (D9):** no `BookingsDashboard`, no route/tab. The recovery affordances are added to
> the **existing `FolioHistoryPage`** (the agent's Ventas list, already filterable by *Reservas*).

**Files:** `app-guideme/src/pages/FolioHistoryPage.tsx`, new shared module
`…/features/bookings/` — `components/BookingWhatsAppButton.tsx` + `bookingUrgency.ts`
(`hoursUntilExpiry`/`isUrgentBooking`/`venceLabel`). The `features/bookings` module is consumed by
both the agent (`pos`) and admin (`folios`) surfaces but imports neither — one-way deps (see §
"Module boundary" below).

1. The list already calls `useMyFolios({ status })` and the row type already carries
   `booking_expires_at`/`pending_balance`/`customer_phone`/`reminder_status` — no new hook.
2. **Decorate only `booking`-status cards:** left accent **orange** if `expires_in < 24h` else
   grey, a *Vence en…* chip, and the pending-balance figure beside Total/Anticipo.
3. **WhatsApp** via the shared `BookingWhatsAppButton` (**pre-flight, D6**, `stopPropagation` so it
   doesn't open the card): tap → `POST /reminder` **first**. On `claimed:true` → dim icon to
   opacity .5 + `window.open("https://wa.me/{phone}?text={encodeURIComponent(template)}")`. On
   `claimed:false` → non-blocking *¿Reenviar?* confirm; accept → re-post `{ force:true }` then open.
   Template hardcoded ES this phase.
4. Tapping a card → the **existing** folio detail (`FolioHistoryDetailPage`) with the Phase-9
   actions.
5. **Admin org-wide (D5/D9-admin):** the same decorations go on `FoliosListPage` and the WhatsApp
   button is reused as-is. Backend: extend `listFolios` (and `readFolio`, Phase 9) with
   `booking_expires_at`/`pending_balance`/`customer_phone`/`reminder_status`/`reminder_sent_*`;
   extend the `FolioListItem`/`FolioDetail` frontend types. The shared `BookingWhatsAppButton`
   takes a minimal `ReminderTarget` shape so both the pos and admin row types satisfy it.

---

## Phase 9 — Expiry / settle on the existing folio detail (US-AG07/07.4/07.5, frontend — D9)

> **Revised (D9):** the banner + actions are **dynamically incorporated** into the folio detail the
> agent already opens — no separate contingency screen. Shared between `FolioHistoryDetailPage`
> (reached from the Ventas list) and the post-sale `FolioReceiptPage`.

**Files:** `…/features/bookings/components/BookingActions.tsx` (exports `BookingActions` +
`ExpiredBookingBanner`), `…/pages/FolioHistoryDetailPage.tsx`, `…/pages/FolioReceiptPage.tsx`.

1. Gate the QR (`Boletos de acceso`) section to `status === 'paid'`; show a pending-balance row for
   live/expired apartados.
2. **Live apartado** → `BookingActions` renders **Liquidar saldo** (Phase 2) + **Cancelar apartado**
   (Phase 3, confirm modal, non-refundable).
3. **Expired apartado** (`cancelled` + `booking_expires_at` set) → `ExpiredBookingBanner`
   ("Apartado Expirado - Cupos Liberados") + **Reactivar y Liquidar** (`POST /reactivate`; on
   `200` proceed to settle; on `409 NO_CAPACITY_AVAILABLE` inline error). **Reagendar** / **Generar
   cupón** render **disabled** ("Próximamente") — deferred.
4. **Admin org-wide (D5/D9-admin):** drop the same `ExpiredBookingBanner` + `BookingActions` into
   `FolioDetailPage`; **hide the US-A21 refundable *Cancelar folio* for `booking` folios** (it
   stays for `paid`). `BookingActions`/`ExpiredBookingBanner` take a minimal `BookingFolio` shape
   so the admin `FolioDetail` satisfies them. The booking mutations (`useBookingActions`)
   invalidate the folio namespaces by their **root keys** (`['pos']` + `['folios']`, prefix match)
   so the list/detail refetch **without** `features/bookings` importing either feature's key
   constants.

---

## Module boundary — `features/bookings` (D9 topology)

To keep the dependency graph one-way, the booking domain lives in its **own** feature consumed by
both surfaces, never importing back:

```
features/bookings/        ← shared apartado domain
  bookingUrgency.ts        (isUrgentBooking, venceLabel, hoursUntilExpiry)
  components/              (BookingActions, ExpiredBookingBanner, BookingWhatsAppButton)
  hooks/useBookingActions  (useSettle/Cancel/Reactivate/ClaimReminder → services/bookingsService)
  index.ts
features/organization/    ← neutral org hooks (useMyOrganization/useUpdateOrganization)
services/bookingsService  ← settle/cancel/reminder/reactivate API clients

deps:  bookings → { organization, auth, catalog(util), services } ;  pos → organization ;
       pages → { bookings, pos, folios, organization }
       (pos ↔ folios ↔ bookings have NO edges between them)
```

This replaced the earlier arrangement where the components/hooks lived in `features/pos` and the
mutations imported `features/folios`' `FOLIOS_KEY` — a pos↔folios coupling now removed.

---

## Phase 10 — Cash-drawer carve-out + review + gates

1. **Cash-drawer follow-up (O3):** a `cancelled` **booking** retains its deposit, so the drawer must
   count its `amount_paid` as collected cash (today it excludes all `cancelled`). Implement the
   carve-out where the drawer aggregates, or — if owned by the cash-drawer spec — file the follow-up
   note there and link it. Confirm with the owner before shipping the sweep to production.
2. Re-read the spec §7 — every scenario has a test; **Sc.16 uses `seedTwoOrgs`**.
3. Gates: `pnpm --filter api-guideme test` green; `npx tsc -b` 0; `pnpm lint:app` 0 errors;
   `pnpm build:app` clean. Tick the spec §8 DoD.

---

## Cross-cutting notes

- **Commission re-derivation at settle (decided):** snapshot `commission_type`/`commission_value`
  onto `folio_lines` at sale (Phase 0.3) and re-derive at settle (Phase 2.2). Keeps commission
  immutable per the commissions spec's snapshot rule — no drift if the admin edits the rate between
  booking and settle.
- **`finalizePaidFolio` extraction** is the load-bearing refactor (Phase 1) that lets settle reuse
  the QR/portal/email path verbatim; do it carefully so the existing paid-sale tests stay green.
- **Naive-calendar `earliestSlotStart`:** combine `slot_date` + `slot_start_time` with the same
  no-timezone arithmetic the POS already uses; the same-day check compares against the device/org
  `today` the client pins.
- **No `git stash`** on the dirty tree (staged WIP). API has no tsc gate — **vitest is the gate**.
