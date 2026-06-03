# Technical Debt Register

This document tracks known technical debt, deferred tasks, and architectural improvements that are planned for future phases.

## 1. Deferred `NOT_FOUND` Error Code

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
