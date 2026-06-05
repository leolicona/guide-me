# Technical Debt Register

This document tracks known technical debt, deferred tasks, and architectural improvements that are planned for future phases.

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
