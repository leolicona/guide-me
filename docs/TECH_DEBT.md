# Technical Debt Register

This document tracks known technical debt, deferred tasks, and architectural improvements that are planned for future phases.

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
