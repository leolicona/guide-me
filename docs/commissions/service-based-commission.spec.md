# Feature: Service-Based Commission — percent or fixed, defined on the service

**User stories:** US-A12 (redefined), US-A06/US-A07 (reduced), US-A33 (simplified), US-AG23 (unchanged behaviorally)
**Phase:** Reorg · follows Phase 1 · **Supersedes** the seller-based half of
`docs/commissions/commissions.spec.md` (base % per agent + per-service bonus). **Depends on:**
Mobile POS (`docs/pos/pos-controlled-discount.spec.md`) — the snapshot point; Admin Vendor
Capabilities (`docs/admin-vendor/admin-vendor-capabilities.spec.md`) — the admin-as-seller whose
commission this model fixes structurally.

> Moves commission from the **seller** to the **service**: each service defines its own
> commission — a **percentage** of the sold price or a **fixed amount per spot** — and *any*
> seller (agent or admin) earns exactly that for selling it. The per-agent
> `users.base_commission` is retired. Snapshot semantics are unchanged: commission is still
> computed once at POS, stored on the folio, and consumed by the running balance and the
> clawback flow exactly as today — **only the formula's inputs change.**

---

## Context

Commission today is `seller.base_commission % × folio total` **plus** a per-service
`commission_bonus % × line total` (US-A12). Two problems surfaced:

1. **The admin earns nothing.** Commission is keyed on the seller's `users.base_commission`,
   which defaults to `0` and — for the admin — has **no editor anywhere** (the staff editor
   only edits agents; Configuración doesn't exist yet). So an admin's sale computes
   `0 + bonus`, usually exactly `$0`. Reported as a bug on 2026-06-11; root cause:
   `pos/handler.ts` commission lookup + `auth/handler.ts` registration insert (no
   `baseCommission`).
2. **The rate lives in the wrong place.** Operators reason about commission per *tour*
   ("this tour pays 10%", "this one pays $30 a seat"), not per *person*. A flat per-agent %
   can't express margin differences between services — the per-service *bonus* exists
   precisely to fake that.

Making the **service** the commission carrier dissolves both: there is no per-seller rate to
forget, and "earn like everyone else" (Admin Vendor D2) becomes structurally true instead of
configuration-dependent. Product confirmed (2026-06-11): no per-agent differentiation is
needed — same service, same commission, whoever sells it.

### Design decisions (✅ = confirmed with product)

| # | Decision | Choice | Rationale |
|---|---|---|---|
| D1 ✅ | **Carrier** | Commission is defined **on the service**: `commission_type ∈ {percent, fixed}` + `commission_value`. The per-agent `base_commission` is **retired** (no reads, no writes, no editor). | "Instead of leaving a fixed commission per sales agent, assign a commission directly to the services." Kills the admin-zero bug by construction. |
| D2 ✅ | **Both types** | `percent` — basis points (0–10000) of the line total; `fixed` — minor units **per spot** (× quantity). Default type `percent`. | Operators think both ways ("10% of the tour" / "$30 a seat"). Percent is the safe default: it inherits every discount/booking/clawback rule for free. |
| D3 | **Fixed is per spot, capped by the price floor** | A fixed commission scales with `quantity` and must satisfy `commission_value ≤ minimum_price`. | Per-seat is the operator's mental model and scales like percent. The cap guarantees commission never exceeds the revenue of even a maximally-discounted pass — structurally removing the "discount to the floor, still earn full commission > margin" trap (US-AG06 interaction). |
| D4 | **Percent base includes extras** | `percent` applies to the **line total including extras** — the same base the old bonus used. `fixed` ignores extras and discounts entirely. | Continuity: bonus already worked this way; changing the base would silently re-price existing folios' expectations. |
| D5 | **Snapshot semantics untouched** | Commission is computed at POS and stored on `folios.commission_amount` exactly as today. The running balance, US-AG24 electronic crediting, clawback (US-A26), and every report read the snapshot — **none of them change.** | The financial pipeline is settled and tested; this feature only changes how the snapshotted number is derived. |
| D6 | **Migration continuity** | `commission_value` is backfilled from `commission_bonus`, then `commission_bonus` is dropped. A service that had `bonus = 500` (5%) is now simply a 5%-commission service. | The bonus *becomes* the commission. Admins should review catalog rates after migrating, since the agent-base term no longer adds (release note, not a blocker — the old admin base was 0 for admins anyway and per-org for agents). |
| D7 | **`users.base_commission` column stays (deprecated)** | All application reads/writes are removed (POS calc, agents list/edit serialization); the column itself is kept with its `DEFAULT 0` to avoid a users-table rebuild and test-fixture churn. A future migration may drop it. | Product behavior is what matters; the physical drop is deferrable and reversible-friendly. |

### Scope boundary

| Concern | Owner |
|---|---|
| `commission_type`/`commission_value` on services (migration, Zod, handlers, serializers), the POS commission formula, removing `base_commission` from agents list/edit, catalog form UI (type + value), agents UI cleanup | **This feature** |
| Snapshot storage, running-balance derivation, clawback, electronic-payment crediting, commission reports (read the snapshot) | *Baselines* — **unchanged** |
| Admin selling, self-authorized settlement, Tu caja | *Admin Vendor Capabilities* — its commission rule (D2) is **simplified** by this feature (no rate to configure) |
| Bookings/down-payments (US-AG07, unbuilt) | When built: percent accrues on the amount collected (existing rule); **fixed accrues only when the folio reaches `paid`** (rule reserved here, implemented there) |
| Per-agent multipliers / tiered pay | **Out of scope** (product: not needed). If ever required, reintroduce as a multiplier over the service rate — never as a parallel base. |

---

## Data Model

Migration `0030_service_based_commission.sql`:

```sql
ALTER TABLE `services` ADD COLUMN `commission_type` text DEFAULT 'percent' NOT NULL;
ALTER TABLE `services` ADD COLUMN `commission_value` integer DEFAULT 0 NOT NULL;
UPDATE `services` SET `commission_value` = `commission_bonus`;
ALTER TABLE `services` DROP COLUMN `commission_bonus`;
```

- `commission_type` — `'percent' | 'fixed'` (app-level enum, like other status columns).
- `commission_value` — **basis points** (0–10000) when `percent`; **minor units per spot**
  when `fixed`. One column, type-discriminated; never both meanings at once.
- `users.base_commission` — **deprecated** (D7): no reads, no writes; schema comment updated.

---

## Business Rules (enforced server-side)

1. **One commission per service.** `commission_type` + `commission_value` are set in the
   catalog (US-A09/US-A13 create/edit) and validated: `percent` → integer 0–10000; `fixed` →
   integer ≥ 0 **and ≤ `minimum_price`** (D3). Violations → `400 VALIDATION_ERROR`.
2. **The seller is irrelevant to the rate.** The POS computes, per line:
   - `percent`: `round(line_total × commission_value / 10000)` — `line_total` includes extras (D4).
   - `fixed`: `commission_value × quantity`.
   `folios.commission_amount = Σ line commissions`. **No lookup of the seller's rate exists
   anymore** — agent and admin sales produce identical commission for identical carts (fixes
   the US-A33 bug at the root).
3. **Snapshot at POS (D5).** Type and value are read at confirm time and the resulting amount
   is stored on the folio; later catalog edits never rewrite history (unchanged guarantee).
4. **Discount interaction.** `percent` shrinks with the discounted price (as today). `fixed`
   does not — but D3's cap (`value ≤ minimum_price`) guarantees the commission never exceeds
   what even a floor-priced pass collects.
5. **Clawback, electronic payments, balance math: unchanged.** All consume the folio snapshot.
6. **Multitenancy.** Catalog validation and POS reads stay org-scoped as today; `seedTwoOrgs`
   isolation re-proven on the changed routes.

---

## Endpoints

No new routes; shape changes on existing ones.

### `POST /api/services`, `PUT /api/services/:id` (US-A09/US-A13)

`commission_bonus` is **replaced** by:

```json
{ "commission_type": "percent", "commission_value": 1000 }
```

Optional on create (defaults `percent` / `0`). Cross-field validation per Rule 1. All service
serializations (catalog list/detail, POS catalog) carry the two new fields and stop carrying
`commission_bonus`.

### `POST /api/pos/folios` (US-AG08)

Request unchanged. `commission_amount` in the response is now computed by Rule 2.

### `GET /api/agents`, `PUT /api/agents/:id` (US-A06/US-A07)

`base_commission` is **removed** from the agent serialization and from the update schema
(name/phone remain editable). A client still sending it is harmless (Zod strips unknown keys).

---

## Frontend (app-guideme)

- **`ServiceFormDialog`** — the "Bono de comisión" field becomes a **Comisión** control: a
  type toggle (**%** / **$ por lugar**) + a value input (percent entered 0–100 →
  `percentToBasisPoints`; fixed entered in pesos → `amountToCents`). Helper text explains the
  cap for fixed ("no puede exceder el precio mínimo").
- **`CatalogDetailPage`** — the bonus chip becomes `comisión 10%` or `comisión $30.00 por lugar`.
- **Agents UI** — `AgentRow` drops the "Comisión: X%" line; `EditAgentDialog` drops the
  "Comisión base" field; `features/agents` types/schemas drop `base_commission`/`commission`.
- **Types** — `features/catalog/types.ts`: `Service.commission_bonus` →
  `commission_type: 'percent' | 'fixed'` + `commission_value: number`.
- Cash/balance surfaces are untouched (they render the snapshot).

---

## Scenarios

### US-A12 (redefined) — commission defined on the service

#### S1 — Percent service pays any seller identically
**Given** a service with `commission_type='percent', commission_value=1000` (10%) and no extras
**When** an **agent** sells 2 passes at `250000` and an **admin** sells the identical cart
**Then** both folios snapshot `commission_amount = round(500000 × 1000/10000) = 50000` —
byte-identical, no seller-rate lookup.

#### S2 — Fixed service pays per spot
**Given** `commission_type='fixed', commission_value=30000` ($300.00 per spot, ≤ minimum_price)
**When** a seller confirms 4 passes (any unit price ≥ minimum)
**Then** `commission_amount = 30000 × 4 = 120000`, regardless of discounts or extras.

#### S3 — Percent includes extras; fixed ignores them (D4)
**Given** a 10% service line of `150000` + extras `50000`
**Then** percent commission = `round(200000 × 0.10) = 20000`; the same cart on a fixed-`30000`
service (qty 1) yields `30000`.

#### S4 — Validation
`percent` with `commission_value = 10001` → `400`; `fixed` with `commission_value >
minimum_price` → `400`; `fixed` with value ≤ minimum_price → `201`/`200`.

#### S5 — Snapshot immune to catalog edits (Rule 3)
**Given** a folio sold at 10%
**When** the admin edits the service to `fixed/50000`
**Then** the folio's `commission_amount` and every balance figure derived from it are unchanged;
only new sales use the new rule.

### US-A06/A07 (reduced) — agents carry no rate

#### S6 — Agent list and edit without commission
`GET /api/agents` rows carry no `base_commission`; `PUT /api/agents/:id` accepts name/phone
and succeeds without (or while ignoring) a `base_commission` key.

### Discount interaction (US-AG06 × D3)

#### S7 — Floor-priced sale still covers a fixed commission
**Given** `minimum_price = 100000`, `commission_value = 30000` fixed
**When** the seller discounts to exactly `100000`
**Then** the sale confirms with commission `30000` — possible **only because** D3 capped the
value at the floor; a percent service at the same floor pays `round(100000 × rate)`.

### Migration continuity (D6)

#### S8 — Pre-migration bonus becomes the rate
**Given** a service created before migration with `commission_bonus = 500`
**Then** after migration it reads `commission_type='percent', commission_value=500` and a new
sale snapshots 5% — the old "base + bonus" never applies again.

### Roles & Multitenancy

#### S9 — `seedTwoOrgs` isolation (required)
Catalog edits and POS sales in `org_a` never read or affect `org_b` services/rates; commission
snapshots derive strictly from the caller's org's catalog.

---

## Definition of Done

**Backend**
- [x] Migration 0030 (add type+value, backfill from bonus, drop `commission_bonus`).
- [x] Drizzle schema: services gain `commissionType`/`commissionValue`; `users.baseCommission`
      marked deprecated (no reads/writes anywhere in `src/`).
- [x] Services Zod schemas + handlers + serializers on the new fields, with the D3 cap refine.
- [x] POS handler computes Rule 2 per line; the seller-rate lookup is deleted.
- [x] Agents routes: `base_commission` removed from serialization + update schema.
- [x] Tests: core scenarios in `test/commissions/service-based-commission.test.ts` (S1–S3, S5,
      S7); S4 validation + S6 agents + S8-equivalents live in the updated catalog/staff suites;
      S9 isolation re-proven by the existing catalog/POS `seedTwoOrgs` tests. Full suite: 286
      passing.

**Frontend**
- [x] `ServiceFormDialog` type toggle (% / $ por lugar) + unit-converted value field; catalog
      types/schemas; `CatalogDetailPage` chip ("comisión 10%" / "comisión $300.00 por lugar").
- [x] Agents UI drops commission display/editing (AgentRow shows phone instead;
      EditAgentDialog is name+phone only).
- [x] `pnpm lint:app`, `tsc`, `pnpm build:app` clean.

**Docs**
- [x] `docs/SPEC.md`: US-A06/A07/A12/A33 rewritten, Key Business Rules § Commissions replaced,
      glossary updated, feature lines repointed.
- [x] Supersession banner on `docs/commissions/commissions.spec.md`; Admin Vendor spec D2/Rule 3
      commission references updated.

---

## Resolved questions

Confirmed with product (2026-06-11):

1. **D1 ✅ Service is the carrier; per-agent rate retired** — no per-agent differentiation
   needed ("same service, same commission, whoever sells it").
2. **D2 ✅ Both types**, percent default.
3. **D3 Fixed = per spot, capped at `minimum_price`** — chosen to neutralize the
   discount-incentive edge structurally rather than with copy.
4. **Booking interaction reserved** (US-AG07 unbuilt): percent on collected amount; fixed on
   reaching `paid`.
