# Implementation Plan — Commissions: Base % per Agent + Bonus per Service (US-A12)

> **Spec:** `docs/commissions/commissions.spec.md`
> **Stack (API):** Hono · Drizzle · Cloudflare D1 · Vitest (`cloudflare:test`)
> **Stack (App):** React · MUI · TanStack Query · React Hook Form + Zod
> **Builds on:** the shipped service catalog (`docs/catalog/service-catalog.spec.md`), the
> `services.commission_bonus` column (migration `0023`), the agent `base_commission`
> (staff management), and the POS commission snapshot + cash derivation already in place.

This is a **gap-closing** feature, not a green-field one. The column, the sale-time
calculation, and the balance deduction already ship; the only missing piece is the **admin
write path** for `services.commission_bonus`. **No new tables, migrations, endpoints, routes,
or `ErrorCode`s** — one field threads through the existing `/api/services` create/update
payload and the catalog form.

> ⚠️ **No migration.** `commission_bonus` already exists (`0023_add_commission_bonus_to_services.sql`,
> `integer NOT NULL DEFAULT 0`). This plan only teaches the API + UI to read/write it.

---

## Phases

```
Phase 1 → API: accept + persist + return commission_bonus (services route)
Phase 2 → API tests (Scenarios 1–5, 7–8; Scenario 6 already in the POS suite)
Phase 3 → Frontend: form field + type + detail display
Phase 4 → Docs: tick SPEC US-A12; mark TECH_DEBT §13 resolved
```

Phases 1→2 are backend (independently shippable). Phase 3 is the UI. Phase 4 closes the books.

---

## Phase 1 — API (`src/routes/services/`)

### Task 1.1 — Schema (`schema.ts`)

Add to `createServiceSchema` (and therefore `updateServiceSchema`, which aliases it):

```ts
commission_bonus: z.number().int().min(0).max(10000).optional().default(0), // basis points (500 = 5%)
```

Integer basis points `0–10000`, same units as `users.base_commission`. Optional + default `0`
keeps create backward-compatible and matches "an *additional* bonus". `PUT` is a full replace, so
an omitted value resets to `0` (Rule 1).

### Task 1.2 — Handler (`handler.ts`)

- `ServiceRow` interface + `serviceColumns`: add `commissionBonus: services.commissionBonus`.
- `serializeService`: add `commission_bonus: row.commissionBonus`.
- `createService` `.values({…})`: add `commissionBonus: input.commission_bonus ?? 0`.
- `updateService` `.set({…})`: add `commissionBonus: input.commission_bonus ?? 0`.

> Org filter, `status`/`organizationId`-from-context, and the `404`-on-missing all already
> hold — no routing or middleware change.

**Deliverable:** create/edit/read a service with `commission_bonus`; `curl` round-trip shows
it; negative/non-integer → `400`.

---

## Phase 2 — API Tests (`test/catalog/service-catalog.test.ts`)

Extend the existing suite (the `seedService` raw insert already lists explicit columns — add
`commission_bonus` there, or rely on the DB default for untouched tests).

| Test | Spec scenario |
|---|---|
| Create with `commission_bonus` → stored + echoed | 1 |
| Omitted on create → `0` | 2 |
| Negative / non-integer bonus → `400`, no row | 3 |
| `PUT` replaces the bonus | 4 |
| List + detail expose `commission_bonus` | 5 |
| Editing the bonus leaves a sold folio's `commission_amount` untouched | 7 |
| Cross-org read/edit of a service by id → `404` (`seedTwoOrgs`) | 8 |

> Scenario 6 (bonus feeds the POS commission snapshot) is **already** covered by
> `test/pos/pos-controlled-discount.test.ts` (the `base % + per-service bonus` test) — no
> duplication needed.

**Deliverable:** `pnpm --filter api-guideme test` green.

---

## Phase 3 — Frontend (`features/catalog`)

### Task 3.1 — Type + schema

- `types.ts` `Service`: add `commission_bonus: number` (basis points). Add
  `percentToBasisPoints` / `basisPointsToPercent` helpers (mirror `features/agents`).
- `schemas.ts` `serviceFormSchema`: add `commission_bonus` as a percent (`0–100`);
  `ServiceFormData` picks it up via `z.infer`.

### Task 3.2 — `ServiceFormDialog`

- `EMPTY`: `commission_bonus: 0`.
- Prefill (edit): `commission_bonus: basisPointsToPercent(service.commission_bonus)`.
- Payload: `commission_bonus: percentToBasisPoints(data.commission_bonus)`.
- A *Commission bonus* `TextField` (number, `%` end adornment, `step 0.01 min 0 max 100`), next
  to capacity — helper text e.g. "Se suma al % de comisión del agente."

### Task 3.3 — Detail display

`CatalogDetailPage` (or `ServiceRow`/`ServiceList`): show the bonus as a percent
(`commission_bonus / 100`%) when `> 0` (an at-a-glance "this tour pays extra" cue).
Elegant-minimalist — a caption, not a card.

**Deliverable:** an admin sets a per-service bonus in the catalog form; it round-trips and
shows on the detail; `pnpm build:app` clean.

---

## Phase 4 — Docs

- `docs/SPEC.md`: tick **Commissions: base % per agent + bonus per service (US-A12)** and drop
  the "Pending" annotation.
- `docs/TECH_DEBT.md`: mark **§13** (Commission Per-Service Bonus Not Manageable) **resolved**,
  pointing at this feature.

---

## Checklist

### Backend (Phase 1–2)
- [ ] `commission_bonus` in `createServiceSchema`/`updateServiceSchema` (int ≥ 0, default 0)
- [ ] `serviceColumns` + `ServiceRow` + `serializeService` carry it
- [ ] `createService` / `updateService` persist it
- [ ] `test/catalog/service-catalog.test.ts` Scenarios 1–5, 7–8

### Frontend (Phase 3)
- [ ] `Service` type + `serviceFormSchema` + `ServiceFormData`
- [ ] `ServiceFormDialog` field (prefill + `amountToCents` payload)
- [ ] Detail display of the bonus

### Docs (Phase 4)
- [ ] `docs/SPEC.md` US-A12 ticked
- [ ] `docs/TECH_DEBT.md` §13 resolved
