# Feature: Commissions — Base % per Agent + Bonus per Service

## Context

An agent earns a **commission** on every sale: a **base percentage** of the folio total
(set per agent) **plus** a **fixed bonus per pass** for specific services (set per service).
The commission is what the agent keeps; in the continuous cash model it is **deducted from
the cash they owe the company** (and, for card sales, the company ends up owing them the
commission). See `docs/cash-drops/agent-balance-cash-drops.spec.md`.

```
commission_amount(folio) = round(total × agent.base_commission / 100)
                         + Σ over lines ( line.quantity × service.commission_bonus )
```

The commission is **computed and snapshotted on the folio at sale time** (`folios.commission_amount`),
so later rate changes never rewrite already-sold history — the same principle as the price
snapshots on `folio_lines`.

**User Story:** **US-A12** — *As an admin, I want to define an additional commission bonus
per specific service, which is added to the agent's base %.*

### What already ships (do not rebuild)

This feature is **mostly shipped** by the cash-balance pivot. What already exists:

- **`users.base_commission`** — the agent's base percentage (whole number), **admin-editable**
  via the agent edit dialog (`features/agents` → `PUT /api/agents/:id`).
- **`services.commission_bonus`** — per-service bonus in minor units, migration
  `0023_add_commission_bonus_to_services.sql`, **read** by POS at sale time.
- **The calculation** — `confirmSale` (`src/routes/pos/handler.ts`) snapshots
  `commission_amount` per the formula above; the running-balance derivation
  (`src/routes/cash/handler.ts`) deducts it (kept on a cancelled folio only when the company
  absorbs the loss — clawback `false`, US-A26).

### The gap this feature closes

`services.commission_bonus` has **no write path** — it is absent from the service create/update
Zod schema, the services handler, and the catalog form — so it defaults to `0` with no way for
an admin to set it, leaving the "bonus per service" half of US-A12 inert. This feature adds
that write path. **No new tables, migrations, endpoints, or `ErrorCode`s** — only the existing
`POST`/`PUT /api/services` payload and the catalog service form gain one field.

### Scope boundary

| Concern | Owner |
|---|---|
| Per-service **commission bonus** definition (create/edit/read) | **This feature** |
| Agent **base %** definition | *Staff management* — already shipped (`users.base_commission`, agent edit) |
| Computing/snapshotting `commission_amount` at sale | *POS* — already shipped (`confirmSale`) |
| Commission's effect on the running balance / clawback on cancel | *Cash balance & drops* (US-AG23/24, US-A26) — already shipped |
| Commission **report by period** (totals to pay per agent, date range) | *Commission report* (US-A17/A18/A20, SHOULD HAVE) — separate read-only query |

---

## Data Model

No schema change — the column already exists (migration `0023`):

### `services.commission_bonus` (existing column)

| Column | Type | Notes |
|---|---|---|
| `commission_bonus` | `integer NOT NULL DEFAULT 0` | minor units (centavos), `≥ 0`; bonus **per pass** added to the agent's base % on a sale of this service |

`users.base_commission` (`integer NOT NULL DEFAULT 0`, whole-number percentage) is unchanged.

---

## Business Rules (enforced server-side)

1. **Bonus is a non-negative integer** (minor units). `commission_bonus ≥ 0`; non-integer /
   negative → `400 VALIDATION_ERROR`. Omitted on create → defaults to `0` (a service with no
   special bonus). `PUT` is a full replace: an omitted value resets the bonus to `0`.
2. **Org-scoped & admin-only.** Reuses the existing `/api/services` router
   (`authMiddleware` + `requireRole('admin')`, org-filtered). `organization_id` / `status`
   are never read from the body (Multitenancy Rule 1); Zod strips unknown keys.
3. **Snapshot, not live.** The bonus affects only sales made **after** it is set. Editing a
   service's `commission_bonus` does **not** touch the `commission_amount` already snapshotted
   on existing folios (mirrors the `base_price` / `minimum_price` snapshots).
4. **No new error codes.** Bad bodies reuse `400 VALIDATION_ERROR`; unknown/cross-org service
   ids reuse `404 NOT_FOUND` (from the existing service routes).

---

## Endpoints (existing routes, one new field)

All admin-only, org-scoped — unchanged routing. The request/response shapes gain
`commission_bonus`.

### `POST /api/services` — create (US-A09 + US-A12)

```json
{ "name": "Canyon Tour", "description": null, "base_price": 150000,
  "minimum_price": 100000, "default_capacity": 12, "commission_bonus": 5000 }
```
→ `201 { "service": { …, "commission_bonus": 5000 } }`. `commission_bonus` optional (default
`0`); `< 0` or non-integer → `400`.

### `PUT /api/services/:id` — edit (US-A13 + US-A12)

Same body as create (full replace). → `200 { "service": { …, "commission_bonus": … } }`.
`404` if unknown / cross-org.

### `GET /api/services` and `GET /api/services/:id` — read

Every service row now carries `commission_bonus`.

---

## Scenarios

#### Scenario 1 — Create a service with a commission bonus
**When** the admin `POST /api/services { …, "commission_bonus": 5000 }`
**Then** `201`; the stored row and the response have `commission_bonus = 5000`.

#### Scenario 2 — `commission_bonus` defaults to 0 when omitted
**When** the admin creates a service without `commission_bonus`
**Then** `201`; `commission_bonus = 0`.

#### Scenario 3 — Invalid bonus → 400
**When** `commission_bonus` is negative or non-integer
**Then** `400 VALIDATION_ERROR`; nothing written.

#### Scenario 4 — Edit the bonus (full replace)
**Given** a service with `commission_bonus = 5000`
**When** the admin `PUT`s the service with `commission_bonus = 8000`
**Then** `200`; the stored bonus is `8000`.

#### Scenario 5 — List and detail expose the bonus
**When** the admin `GET /api/services` and `GET /api/services/:id`
**Then** each service carries its `commission_bonus`.

#### Scenario 6 — The bonus feeds the POS commission snapshot (integration)
**Given** an agent with `base_commission = 10` and a service with `commission_bonus = 5000`
**When** the agent confirms a sale of `quantity = 2` at `total = 300000`
**Then** the folio's `commission_amount = round(300000 × 10/100) + 2 × 5000 = 40000`.
*(Already covered by the POS suite — asserted here as the end-to-end guarantee.)*

#### Scenario 7 — Editing the bonus does not rewrite sold history
**Given** a folio already sold with a snapshotted `commission_amount`
**When** the admin later changes the service's `commission_bonus`
**Then** the existing folio's `commission_amount` is unchanged (snapshot, Rule 3).

#### Scenario 8 — Cross-org isolation (`seedTwoOrgs`)
**When** an `org_a` admin reads/edits an `org_b` service by id
**Then** `404 NOT_FOUND`; org_b rows never appear in org_a's list.

---

## Definition of Done

- [ ] `commission_bonus` added to `createServiceSchema` / `updateServiceSchema`
      (integer `≥ 0`, optional → default `0`); no org/status fields in the body
- [ ] `createService` persists it; `updateService` replaces it; `serializeService` returns it
      on list + detail
- [ ] Catalog **service form** (`ServiceFormDialog`) gains a *Commission bonus* field
      (major-decimal in, `amountToCents` out, prefilled on edit); `Service` type +
      `serviceFormSchema` carry it; the detail page shows it
- [ ] Scenarios 1–5, 7–8 covered in `test/catalog/service-catalog.test.ts`; Scenario 6 already
      covered by the POS suite
- [ ] `pnpm --filter api-guideme test` green; `pnpm build:app` clean
- [ ] `docs/SPEC.md` MUST-HAVE **Commissions: base % per agent + bonus per service (US-A12)**
      ticked; `docs/TECH_DEBT.md` §13 marked **resolved**
