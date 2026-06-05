# Technical Debt Register

This document tracks known technical debt, deferred tasks, and architectural improvements that are planned for future phases.

## 14. Daily Cash-Drawer Feature Superseded & Removed — ✅ RESOLVED (replaced)

**Status:** The daily cash-closure (*corte de caja*) feature — `cash_drawers` /
`cash_drawer_expenses` tables, the `/api/cash-drawers` router, its tests, the agent **Caja**
page and admin **Closures** list/detail UI — was **removed end-to-end** and **replaced** by
the perpetual *Agent continuous cash balance with cash drops* feature
(`docs/cash-drops/agent-balance-cash-drops.spec.md`). Migration `0018_drop_cash_drawers.sql`
drops both tables (expenses → drawers, FK order); the Drizzle defs, routes, services, hooks,
pages, nav entries and route constants are all gone (verified: no dangling references in
`api-guideme/src` or `app-guideme/src`).

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

## 12. Agent Cash-Balance — Deferred Refinements — ⚠️ OPEN (accepted trade-offs)

**Status:** Accepted MVP simplifications in the *Agent continuous cash balance with cash
drops* feature (`src/routes/cash/handler.ts`). The balance is **derived live** from events on
every read — correct, but with the trade-offs below.

- **(a) Settled history is not frozen.** An agent can add/delete an expense or have a folio
  cancelled *behind* an already-confirmed cash drop; because the balance is recomputed from
  the full event history each read, this silently moves a number the admin already settled
  against. MVP treats the live balance as the single truth (a deletion simply raises the
  balance and is visible). *Action:* freeze events behind the last confirmed drop (a
  settlement watermark) before allowing edits, or refuse edits to pre-watermark rows.
- **(b) Unbounded derivation sums.** `deriveBalance` re-aggregates **all** of an agent's
  folios / expenses / drops / payouts on every read — O(history), growing forever. *Action:*
  carry a `balance_after` snapshot on each confirmed drop and sum only events since the last
  confirmed drop (snapshot-carry), bounding the per-read work.
- **(c) No adjust-amount-on-confirm.** A drop is terminal once reviewed; a wrong amount must
  be **rejected and re-registered** by the agent (no admin "confirm 480 instead of 500").
  *Action:* allow the admin to confirm with an adjusted `amount` (+ audit of the delta),
  superseding reject-and-resubmit.
- **(d) `listBalances` N+1.** The admin balances view derives each agent's balance in a loop
  (one `deriveBalance` — itself several queries — per agent). Fine at MVP agent counts.
  *Action:* replace with a single grouped query (folios/expenses/drops/payouts `GROUP BY
  agent_id` with the cancellation/clawback/payment-method predicates) joined to org agents.

**Why accepted:** all four are scale/edge-case refinements, not correctness bugs — the balance
math (`cash_collected − commissions − expenses − confirmed_drops + payouts`), the drop machine,
and multitenancy isolation are fully correct and covered by tests
(`test/cash/agent-balance-cash-drops.test.ts`). Each is invisible until either history grows
large (b, d) or an admin settles then an agent back-edits (a, c).

## 11. Client Cancellation Email Not Sent (US-C03) — ⚠️ OPEN (dependency not built)

**Status:** Deferred by the Total Folio Cancellation feature
(`docs/cancellation/total-folio-cancellation.spec.md`). US-A21 cancels the folio, releases
inventory, and records the cancellation; US-C03 ("the client receives an Email notification
if their folio is cancelled") is **not** wired because the Resend client-ticket-delivery
feature (SHOULD HAVE — *Sending receipt and QR code to client via Email*, US-AG09/C01/C03)
is not built yet. `cancelFolio` (`src/routes/folios/handler.ts`) currently has no email side
effect.

**Why accepted:** cancellation is an inventory + record action and is fully correct without
the notification; adding a Resend call now would mean standing up the whole email
integration (templates, sender identity, error handling) ahead of its feature. The
cancellation already invalidates the client's access (the scanner's `CANCELLED` gate), so
no stale ticket can be redeemed regardless of whether the email goes out.

**Action if revisited:** when the Resend client-delivery feature lands, hook a
cancellation-notification send into the single seam at the end of `cancelFolio` (after the
batch commits, using the folio's `customer_email` and the recorded
`cancellation_reason`/`cancelled_at`). No schema or API change is required — the audit
fields needed for the email body already exist on `folios`.

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
