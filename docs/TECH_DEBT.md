# Technical Debt Register

This document tracks known technical debt, deferred tasks, and architectural improvements that are planned for future phases.

## 18. Accommodation Stays — Error Codes & `folio_lines` Rebuild — ✅ INTRODUCED & CONSUMED (no open debt)

**Status:** The accommodation/lodging feature (`docs/lodging/accommodation-stays.spec.md`) added three
error codes to the `ErrorCode` union in `src/types/errors.ts`, each thrown by a handler and asserted
by a test (`test/lodging/accommodation-stays.test.ts`) — introduced **and** consumed, no open debt:
- ~~`UNIT_UNAVAILABLE`~~ → **`INSUFFICIENT_INVENTORY`** (409) — v2 (Unit-Type Inventory, migration
  `0042`, `docs/RFCs/rfc-airbnb-inventory-model.md`): the per-unit overlap guard became a per-night
  COUNT guard (`reserved + blocked + requested ≤ inventory_count` ∀ night); the old code was removed
  from the union in the same change (no route emitted it any more) — no open debt.
- `SEASON_OVERLAP` (409) — a new season overlaps an existing active season for the type (admin API).
- `MIN_STAY_NOT_MET` (400) — a stay shorter than the type's `min_nights` (availability + sale).

**`folio_lines` rebuild (Option A):** migration `0040_alter_folio_lines_for_stays.sql` rebuilt
`folio_lines` to make `slot_id`/`slot_date`/`slot_start_time` nullable and add the stay columns
(`line_type`, `unit_id`, `check_in`, `check_out`, `guests`, `nights`) so a unified line list carries
both tour slots and lodging stays. SQLite can't drop NOT NULL/FK in place, so it is a table rebuild.

⚠️ **D1 remote per-statement FK enforcement (learned the hard way):** the first cut used the
Cloudflare-documented `PRAGMA defer_foreign_keys = TRUE` + drop/rename. It passed the test suite
(local Miniflare runs the migration file as one transaction, so the deferred check holds) but
**rolled back on `wrangler d1 migrations apply --remote`** with `FOREIGN KEY constraint failed`
(SQLITE_CONSTRAINT_FOREIGNKEY 7500). On remote, D1's `/query` endpoint enforces FKs **per
statement** and does **not** honor `defer_foreign_keys`, so `DROP TABLE folio_lines` orphaned the
`folio_line_extras` rows (the only inbound FK) the instant it ran. The rewrite keeps every statement
FK-valid: rebuild `folio_line_extras` *without* its `folio_lines` FK → swap `folio_lines` → rebuild
`folio_line_extras` again to restore all four FKs. Row ids are preserved across both copies, so each
check passes. **Takeaway for future table rebuilds: never rely on `defer_foreign_keys` for D1
`--remote`; order statements so no single statement violates a FK, or temporarily drop the inbound
FK.** Verified by the full suite via `applyD1Migrations` (the PRAGMA is kept as a harmless no-op
safety net for engines that do defer).

## 17. Cash Drawer — Retained Booking-Deposit Carve-Out — ⚠️ OPEN (cross-feature follow-up)

**Status:** Bookings/down-payments (`docs/bookings/bookings-down-payments.spec.md`, decision D7 /
open decision O3) ship with a **non-refundable retained deposit**: when a booking is cancelled
(manually via `POST /api/pos/folios/:id/cancel`, or by the auto-expiry sweep) the customer's
`amount_paid` **stays in the agent's cash drawer** and the folio goes to `status='cancelled'`,
`refund_status='none'`.

**The discrepancy:** the cash-drawer derivation (`api-turistear/src/routes/cash/handler.ts`) sums
`cash_collected` over **non-cancelled** folios only (`ne(folios.status, 'cancelled')`). So a
retained cash deposit on a cancelled booking is **excluded** from collected cash even though the
agent physically holds that money — the drawer would under-count by the deposit.

**Why deferred here:** the carve-out belongs to the *Cash drawer* feature's aggregation + its own
test surface (the bookings feature only sets `amount_paid`/`status`/`refund_status`). Wiring it in
the bookings PR would reach into another feature's derivation and tests.

**Action required:**
- **Who:** the cash-drawer owner (or the first PR that reconciles booking deposits into the drawer).
- **What:** in the `cash_collected` sum, include cancelled folios whose deposit was **retained**
  (a booking cancellation: `status='cancelled' AND refund_status='none' AND payment_method='cash'`),
  distinct from a refunding admin cancellation (US-A21, `refund_status` `pending`/`refunded`).
  Mirror the existing watermark-reversal logic (TECH_DEBT §12a) so a deposit retained pre-watermark
  isn't double-counted.
- **Reference:** `docs/bookings/bookings-down-payments.spec.md` §6 (cash-drawer row) + O3.

## 16. Tourist Portal — Deferred Notifications & Electronic Refund Movement — ⚠️ OPEN (by design)

**Status:** The Tourist Self-Service Portal (`docs/tourist-portal/tourist-self-service-portal.spec.md`)
shipped with two deliberate deferrals:

1. **No admin email on a new cancellation request (spec D7).** The request surfaces via the
   in-app queue + nav badge only (the same precedent as Advanced Cash Collection's D1 — no
   admin-facing event-email infra exists). Layerable on Resend later with no model change.
2. **No electronic money movement on refunds.** There is no payment gateway (Phase-1 pivot),
   so `POST /api/folios/:id/refund/confirm` *records* that a refund happened — for cash it is
   the physical hand-back (proven by the portal PIN), for card/transfer/link the admin
   processes the return out-of-band and records it here (typically via the override-note path).

**Action if revisited:** (1) add a `sendCancellationRequestEmail` to `services/resend.ts` and
fire it from `submitCancellationRequest` via `waitUntil`; (2) when a gateway lands, hang the
actual refund call off the same `pending → refunded` transition.

## 15. External QR-Image Service Dependency — ⚠️ OPEN (accepted trade-off)

**Status:** The Client Ticket Delivery feature (`docs/email/client-ticket-delivery.spec.md`) embeds QR codes in the HTML email using external image tags pointing to `api.qrserver.com/?data=<token>`.

**Why accepted:** Generating raw PNG bytes entirely within a Cloudflare Worker requires either a WebAssembly module (like `qr-wasm`) or a pure JS implementation that does not rely on Node's Canvas/Buffer. Using the external URL is an acceptable MVP shortcut to deliver the email without expanding the build complexity.

**Action if revisited:** If `api.qrserver.com` rate-limits or the privacy of embedding the token in a URL parameter becomes a concern, self-host a `/api/qr/:token.png` endpoint within the Worker (using WASM) and change the Resend template to point to our own domain.

## 14. Daily Cash-Drawer Feature Superseded & Removed — ✅ RESOLVED (replaced)

**Status:** The daily cash-closure (*corte de caja*) feature — `cash_drawers` /
`cash_drawer_expenses` tables, the `/api/cash-drawers` router, its tests, the agent **Caja**
page and admin **Closures** list/detail UI — was **removed end-to-end** and **replaced** by
the perpetual *Agent continuous cash balance with cash drops* feature
(`docs/cash-drops/agent-balance-cash-drops.spec.md`). Migration `0018_drop_cash_drawers.sql`
drops both tables (expenses → drawers, FK order); the Drizzle defs, routes, services, hooks,
pages, nav entries and route constants are all gone (verified: no dangling references in
`api-turistear/src` or `app-turistear/src`).

**Why accepted:** the operationally meaningful number is "how much company cash is this agent
holding **right now**", not a paper reconciliation pinned to a calendar day. The continuous
running balance (server-derived from events, never stored) replaces the day snapshot, and the
cash-drop `pending → confirmed | rejected` machine reuses the closure review pattern — so the
old model carried no behaviour worth keeping. The drop assumed **no production cash-drawer
data to preserve** (the daily-closure feature shipped immediately before this pivot).

**Action if revisited:** none — this is a completed replacement, not open debt. The drop
migration is **destructive**; if a remote D1 ever held real `cash_drawers` rows, that data is
not recoverable from these migrations (snapshot before applying `0018` remotely).

## 13. Commission Per-Service Bonus Not Manageable (US-A12) — ✅ RESOLVED

**Status:** **Closed** by the *Commissions* feature
(`docs/commissions/commissions.spec.md`). `services.commission_bonus` now has a full write
path: it is in `createServiceSchema`/`updateServiceSchema` (integer minor units, ≥ 0, default
0), persisted by `createService`/`updateService`, returned by `serializeService` on list +
detail, and editable via a *Commission bonus* field in the catalog service form
(`ServiceFormDialog`). The read-side was already in place — `confirmSale` snapshots
`commission_amount = round(total × users.base_commission / 100) +
Σ(line.quantity × services.commission_bonus)` and the balance derivation deducts it — so both
halves of US-A12 (base % per agent + bonus per service) now flow end-to-end. Covered by
`test/catalog/service-catalog.test.ts` (create/default/validation/edit/read + snapshot
immutability) and `test/pos/pos-controlled-discount.test.ts` (the calc). No schema change was
needed (the column shipped with migration `0023`).

## 12. Agent Cash-Balance — Deferred Refinements — 🟡 MOSTLY RESOLVED

**Status:** Paid down by the *Agent Cash-Balance Refinements* work
(`docs/cash-drops/balance-refinements.design.md`). The high-leverage primitive is a
**settlement watermark** — `cash_drops.balance_after`, stamped at confirm time (migration
`0024_add_settlement_to_cash_drops.sql`). (a), (b), (d), and the anchor/cancellation parts of
(e) are **resolved**; (c)'s amount-adjustment mechanics are **shipped** but its
acknowledgment/signing flow is **still pending** (tied to US-AG27, below); one sub-case of (e)
is **out of scope** (unreachable). Covered by `test/cash/agent-balance-cash-drops.test.ts`
(Scenarios 4a, 5a, 10b, 12a, 12b, 14a–14c), with Scenario 12a a **regression gate** proving the
watermark-anchored headline equals the independent all-time recompute.

- **(a) Settled history is now frozen.** ✅ The watermark is the boundary. An expense
  `created_at <= watermark` refuses deletion (`409 CONFLICT`, `deleteExpense`); a pre-watermark
  folio cancelled *after* the watermark is no longer silent — `deriveBalance` adds a **reversal
  term** (`sumCancellationReversal`) that surfaces the reversed cash (and any clawed-back
  commission) in the **current shift**, leaving the settled `balance_after` frozen. *(This
  changed Scenario 4's split for the watermarked path — the reversal now lands in the live shift,
  not `carry_forward`; the legacy/no-watermark path is unchanged and still covered by Scenario 4.)*
- **(b) Per-read work is now bounded.** ✅ `deriveBalance` has a fast path:
  `balance = balance_after + Σ(events since the watermark)` — O(shift), not O(history). The shift
  breakdown and the authoritative balance are one computation, and `carry_forward` is read
  **directly** from `balance_after`. Confirming is also bounded (new `balance_after` = prior
  watermark + since-sums − amount). A legacy confirmed drop with no `balance_after` transparently
  falls back to the full-history derivation.
- **(c) Adjust-amount-on-confirm — mechanics shipped, acknowledgment pending.** 🟡 `reviewDrop`
  accepts an optional `amount`; confirming with a corrected value updates the balance immediately,
  stashes the agent's original into `amount_requested` (new column), and audits the delta in
  `review_note` (admin UI: `CashDropDetailPage` confirm dialog + a requested-vs-confirmed line).
  **Still to build:** the "Silent Acknowledgment" / non-blocking notification flow shared with
  **Admin-Initiated Direct Collection (US-AG27)** — the agent is notified to digitally
  sign/acknowledge the adjustment, auto-signing after 24h if ignored. Until US-AG27 lands, an
  adjustment is applied + audited but not agent-acknowledged.
- **(d) `listBalances` N+1 removed → later superseded by the US-A19 shift-scope upgrade.** ✅
  Originally replaced the per-agent loop with `GROUP BY agent_id` aggregates merged in memory
  (O(1) queries, all-time totals). **Superseded:** US-A19 was upgraded to require a per-agent
  **shift-scoped** breakdown (collected/commissions/expenses since each agent's last confirmed
  drop, plus a carry-forward line) for clean daily reconciliation — which a single grouped query
  can't express without a per-agent watermark join. Since the watermark made each `deriveBalance`
  O(shift), the loop is no longer pathological: `listBalances` now maps every agent through the
  **canonical `deriveBalance`**, fired concurrently (`Promise.all`), so the admin row mirrors the
  agent's `/me` view exactly (single source of truth). The headline `balance` stays all-time.
  Design + regression gate: `docs/cash-drops/admin-shift-scoped-balances.design.md`. O(1) escape
  hatch (conditional aggregation over a per-agent watermark window) recorded there for if an org
  ever reaches hundreds of agents.
- **(e) Shift attribution.** ✅ (mostly) The anchor now follows the **settlement timeline**
  (`reviewed_at`, tiebreak `created_at`), so out-of-order confirmation resolves to the drop
  confirmed last; post-drop cancellations surface via the (a) reversal. ⚠️ **Out of scope (still
  deferred):** a **booking whose `amount_paid` grows across a confirmed drop** — *currently
  unreachable*, because `amount_paid` is written once at folio creation and never grown (no
  endpoint mutates it). Revisit only if such an endpoint is introduced; the §4.2 reversal pattern
  then generalises to a signed adjustment ledger keyed on payment events.

**Known limitation (accepted, consistent with §6):** timestamps are whole-second, so the fast-
path boundary `created_at > reviewed_at` is fuzzy for an event landing in the *same wall-clock
second* as a confirmation. Admins confirm drops seconds/minutes apart, so this is a sub-second
concurrency edge; the fallback / `/balances` recompute stays exact.

## 11. Client Cancellation Email Not Sent (US-C03) — ✅ RESOLVED

**Status:** Closed by the Client Ticket Delivery feature (`docs/email/client-ticket-delivery.spec.md`). `cancelFolio` (`src/routes/folios/handler.ts`) now sends a Resend notification after the batch commits when `folio.customer_email` is set.

**Why accepted:** This resolves the previous technical debt. The cancellation email effectively notifies users and prevents confusion.

**Forward seam — Refund PIN (US-A23 / US-T05):** when the Tourist Self-Service Portal
(Phase 2) and Cash Refund Tracking land, the physical-cash-returned loop closes here too.
The flow will be: admin approves cancellation → `cancelFolio` generates a secure one-time
`refund_pin` stored on the folio → tourist portal (US-T05) shows it → agent/admin enters the
PIN to confirm the cash was handed back (`refund_confirmed_at`). The `folios` table already
carries the full cancellation audit; the only additions will be two nullable columns
(`refund_pin`, `refund_confirmed_at`) added when that feature lands.

> **Note — partial cancellation stays out of scope.** Per-service / per-line cancellation is
> explicitly **WON'T HAVE THIS TIME** in the SPEC; this feature is total-only by design and
> that is not debt to be paid down in the MVP.

## 10. Strictly-Online QR Scanner (offline sync is Phase 2) — ⚠️ OPEN (by design)

**Status:** Intentional MVP scope, set by the Online QR Scanner feature
(`docs/scanner/online-qr-scanner.spec.md`) and the SPEC design principle. `POST
/api/tickets/scan` validates and redeems **only** against the server (the single source of
truth for `redeemed_count`); the frontend refuses to scan when offline (US-AG19) rather
than queueing.

**Why accepted:** the MVP gate scenario assumes connectivity (3G/4G/WiFi); real-time
redemption avoids any reconcile/conflict logic. The signed-token structure
(`src/utils/qr.ts`) was deliberately built to support offline verification later **without
reissuing tickets** — the signature can be checked locally against the per-org key.

**Action if revisited:** Phase 2 (US-AG16) adds offline validation — verify the signature
locally (bad signature → fake), store consumed `folio_line_id`s in `localStorage`, and
reconcile via `POST /api/tickets/sync`; the server stays authoritative on `redeemed_count`
(it must clamp at `quantity` when applying a synced batch, surfacing over-redemptions that
happened across offline devices).

## 9. Ticket Scan Is Not Idempotent — ⚠️ OPEN (accepted trade-off)

**Status:** Accepted limitation of `POST /api/tickets/scan` (Online QR Scanner). Each
successful call redeems exactly one pass; there is no idempotency key. If the response is
lost in flight and the agent rescans the same code, a second pass is redeemed.

**Why accepted:** the frontend mitigates the common case by **re-arming** between scans
(`ScannerPage` pauses the camera after each scan and waits for "Scan next"), so the same
physical QR fires one request per deliberate scan; a genuine network-loss + rescan is rare
and visible (the agent sees the progress jump). The atomic `redeemed_count < quantity`
guard still prevents redeeming **past** the purchased total.

**Action if revisited:** if field data shows duplicate redemptions, accept a
client-generated `scan_id` (idempotency key) on the scan body and dedupe server-side
(requires the redemption audit table from §8 to record applied keys). No ticket-format
change is required.

## 8. Redemption Audit Log Deferred — ⚠️ OPEN (YAGNI)

**Status:** Deferred by the Online QR Scanner feature. Redemption state is a single
counter, `folio_lines.redeemed_count` (migration `0014`), which is all US-AG17 needs
("Pass N of M used"). There is **no** per-scan audit table (who scanned, when, which pass,
on what device).

**Why deferred:** no MVP feature reads per-scan rows — the count alone drives the result
screen — so adding a `ticket_redemptions` table now would be unused schema (same YAGNI
discipline as §1). The single atomic `UPDATE … redeemed_count + 1` is sufficient for
correctness.

**Action if revisited:** the first feature that **reports** on redemptions (cash drawer /
admin dashboard / commissions, or the §9 idempotency key, or the §10 offline-sync
reconcile) introduces `ticket_redemptions` (`id`, `organization_id`, `folio_line_id`,
`scanned_by`, `scanned_at`, `pass_number`) and writes one row per successful scan inside
the same path that increments `redeemed_count`.

## 7. Per-Org QR Signing by Key Derivation (no rotation) — ⚠️ OPEN (accepted trade-off)

**Status:** Accepted design, introduced by the signed-QR feature
(`docs/qr/folio-qr-signing.spec.md`). The SPEC requires each ticket "signed with
HMAC-SHA256 using a `QR_SECRET` per organization." Rather than store a per-org secret
column (generation-on-create + a backfill for existing orgs), `src/utils/qr.ts` keeps a
**single** Worker secret `QR_SECRET` and derives the per-org signing key as
`orgKey = HMAC-SHA256(QR_SECRET, "guideme:qr:v1:" + organizationId)`. This satisfies "per
organization" (distinct key per org; a ticket minted for one org cannot verify under
another's derived key — multitenancy in the signature itself) with **no schema change and
no backfill**.

**Why accepted:** `QR_SECRET` is a Worker secret (`wrangler secret put QR_SECRET`); only
the derived key signs, and neither leaves the server. Covered by
`test/qr/qr.unit.test.ts` (cross-key isolation) and `test/qr/folio-qr-signing.test.ts`
(Scenarios 4, 11).

**Action if revisited:** **secret rotation is not yet supported** — there is no `kid` and
rotating `QR_SECRET` would invalidate every already-issued ticket. The payload `v: 1` and
the `"guideme:qr:v1:"` key label reserve room for a versioned scheme (embed a key id,
verify against the matching secret) without reissuing tickets. Add it when rotation is
needed.

## 6. QR `expires_at` Single-Timezone Assumption — ⚠️ OPEN (accepted trade-off)

**Status:** Accepted MVP simplification in `src/routes/pos/handler.ts` (`ticketExpiry`),
introduced by the signed-QR feature. A ticket's `expires_at` is
`unixtime(slot_date @ 00:00 UTC) + 48h` — valid through the end of the day after the tour.
This mirrors the existing naive-calendar assumption already used by Schedules/Slots and
POS (dates are timezone-less `YYYY-MM-DD` strings).

**Why accepted:** the platform is single-timezone in the MVP; the 48h grace comfortably
covers late-evening slots and next-morning stragglers regardless of the org's real offset.
This feature only **stamps** `expires_at`; the *Online QR Scanner* feature enforces it.

**Action if revisited:** when organizations gain a real timezone (a broader change touching
schedules/slots/POS too), compute `expires_at` from the slot's local datetime rather than
UTC midnight. No ticket-format change is required — `expires_at` is already an absolute unix
timestamp.

## 5. `verifyTicket` Shipped Ahead of Its Production Consumer — ✅ INTRODUCED (no open debt)

**Status:** `src/utils/qr.ts` exports `verifyTicket` alongside `signTicket`/`deriveOrgKey`,
introduced by the signed-QR feature (`docs/qr/folio-qr-signing.spec.md`). Only `signTicket`
runs in a production request path today (folio confirm). `verifyTicket` is the *Online QR
Scanner* feature's future production consumer; here it is exercised by this feature's own
tests (roundtrip, tamper, cross-key, and the read-path integrity check in
`readFolio`/`getFolio`).

**Why no debt:** unlike a deferred-and-unused code path, a signer is only meaningfully
testable against its verifier, and `verifyTicket` **is** consumed now — by `getFolio`
(integrity-checks the stored token before echoing its payload) and by the QR test suites.
No dead code; the scanner simply becomes its second caller.

## 4. D1 Has No Interactive Transactions — ⚠️ OPEN (accepted trade-off)

**Status:** Accepted limitation, surfaced by the POS sale-confirm
(`docs/pos/pos-controlled-discount.spec.md`). The Cloudflare D1 Workers binding offers
`batch()` (all-or-nothing **on error**) but **not** interactive transactions, and a
conditional `UPDATE` that matches **0 rows is not an error** — so a batch cannot
conditionally abort when a slot is sold out. `confirmSale`
(`src/routes/pos/handler.ts`) therefore uses a **validate → conditional-decrement →
compensate** flow: it decrements each slot with
`UPDATE slots SET booked = booked + n WHERE … AND capacity - booked >= n RETURNING id`,
and if any decrement matches 0 rows it re-increments (`booked - n`) the slots already
decremented in that confirm, then throws `409 SLOT_UNAVAILABLE`. The folio rows are
written only after all decrements succeed, in a single `db.batch`.

**Why accepted:** the compensation window is sub-millisecond and bounded by cart size;
the `capacity - booked >= n` guard plus the `slots_active_unique_idx` partial index are
the DB-level backstops. Covered by `test/pos/pos-controlled-discount.test.ts` Scenario 10
(roomy slot is rolled back, sold-out slot untouched, **no** folio written).

**Action if revisited:** if D1 gains interactive transactions (or the sale moves to a
Durable Object for serialized inventory), replace the compensation with a real
transaction. No schema change is required.

## 3. POS Error Codes (`PRICE_BELOW_MINIMUM`, `SLOT_UNAVAILABLE`) — ✅ INTRODUCED & CONSUMED (no open debt)

**Status:** Introduced and consumed together by the Mobile Point of Sale feature
(`docs/pos/pos-controlled-discount.spec.md`). Both were added to the `ErrorCode` union in
`src/types/errors.ts` and are consumed by the POS confirm endpoint
(`POST /api/pos/folios`): `400 PRICE_BELOW_MINIMUM` when a line's `unit_price` is below the
snapshot `minimum_price` (US-AG06 controlled-discount floor), and `409 SLOT_UNAVAILABLE`
when a slot can no longer satisfy the requested quantity at confirm time (US-AG11 race
protection). Like the `CONFLICT` case (§2), the codes were added at the same time as their
first use, so no debt is opened. Covered in `test/pos/pos-controlled-discount.test.ts`
(Scenarios 7 and 10).

## 2. `CONFLICT` Error Code — ✅ INTRODUCED & CONSUMED (no open debt)

**Status:** Introduced and consumed together by the Schedules & Slots feature
(`docs/schedules/schedules-slots.spec.md`). `'CONFLICT'` was added to the `ErrorCode`
union in `src/types/errors.ts` and is consumed by the slot/schedule endpoints, which
return `409 CONFLICT` for: a duplicate active slot at `(service, date, start_time)`, an
edit/reactivate that would collide with another active slot, and an edit that would set
`capacity` below the already-booked spots. Unlike the deferred `NOT_FOUND` case (§1),
this code was added at the same time as its first use, so no debt is opened. A partial
unique index (`slots_active_unique_idx … WHERE status = 'active'`) backs the handler
pre-checks at the DB layer. Covered in `test/catalog/schedules-slots.test.ts`
(Scenarios 4, 7, 9).

## 1. Deferred `NOT_FOUND` Error Code — ✅ RESOLVED

**Status:** Resolved by the Service Catalog feature (`docs/catalog/service-catalog.spec.md`).
`'NOT_FOUND'` is present in the `ErrorCode` union in `src/types/errors.ts` and is now
consumed by `GET /api/services/:id` (and the other org-filtered service/extra
endpoints), which return `404 NOT_FOUND` for unknown or cross-org ids without
revealing whether the resource exists in another organization (Scenarios 6, 11, 14,
17). Cross-org isolation is covered in `test/catalog/service-catalog.test.ts`.

<details>
<summary>Original entry (for history)</summary>

**Context:** 
The Multitenancy specification (Scenario B3) dictates that when a user attempts to fetch a resource by ID that belongs to a different organization, the system must return a `404 Not Found` error. This prevents information leakage across organizations by not confirming whether the resource actually exists or not.

**Current State:**
The global `ErrorCode` union in `src/types/errors.ts` does not currently define a `NOT_FOUND` error code.

**Why Deferred?**
The foundational Multitenancy implementation plan (Phase 2) only introduced the `GET /api/organizations/me` endpoint. If the user's organization is missing, it is considered an invariant violation (internal error), so it returns `500 INTERNAL_ERROR` instead of `404`. Since no endpoint in this phase requires the `NOT_FOUND` code, adding it now would introduce unused code (violating YAGNI).

**Action Required:**
- **Who:** The developer implementing the first resource-detail endpoint (e.g., Service Catalog, where `GET /api/services/:id` is needed).
- **What:** Add `'NOT_FOUND'` to the `ErrorCode` union in `src/types/errors.ts`.
- **Reference:** `docs/multitenancy/implementation-plan.md` (Phase 4, Task 4.3)

</details>
