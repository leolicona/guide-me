# Implementation Plan: Zoned Capacity (US-A64)

Spec: `docs/catalog/zoned-capacity.spec.md`. This plan sequences that spec into shippable phases.

## Guiding constraints

- **No technical debt.** The spec adopts the **snapshot model** (each departure records its own
  `slot_zones.capacity`, created eagerly for future slots) precisely so nothing is deferred: no
  live-capacity read, no history rewrite, no `TECH_DEBT.md` entry. Every phase leaves the tree
  green — no placeholder, no half-migration, no "wire up later".
- **The atomic single-statement guard is sacred.** D1 has no interactive transactions; the
  overbooking protection is one conditional `UPDATE`. Never split it.
- **Batch atomicity.** Anything that must commit together goes in one `db.batch()` — the lesson
  from the schedule-materialization fix (a slot must never exist without its zone rows).
- **Zoned paths branch on `services.zones_enabled`.** An unzoned service must stay byte-identical
  to today; the reconcile helper must be a no-op for it.
- **Per-phase tests.** Each phase lands with its scenarios passing; the feature is not "done in
  pieces then tested" — every phase is independently green.

Scenario numbers below refer to the spec's § Scenarios.

---

## Phase 0 — Data model & shared primitives (no behaviour change)

Foundation only: after this phase every existing test still passes and nothing reads the new
tables yet (`zones_enabled` defaults `0`).

**Backend**
- Migration `0043_zoned_capacity.sql`: create `service_zones` + `slot_zones` (both with
  `capacity`), add `services.zones_enabled`, `folio_lines.zone_id`, `folio_lines.zone_name`.
  Additive only — verify each statement is FK-valid in isolation (`ADD COLUMN … REFERENCES` is).
- Drizzle: add both tables and the three altered columns to `src/db/schema.ts`; confirm inferred
  types flow into the routes that import them.
- `ZONE_UNAVAILABLE` → the `ErrorCode` union in `src/types/errors.ts`.
- `src/routes/services/zones.reconcile.ts` — `reconcileSlotTotals(db, slotId): BatchItem[]`
  returning the rule-2 statement(s). Pure builder, no execution, so callers compose it into their
  own batch. **Guarded at every call site by `zones_enabled`**, never internally.

**Verify:** `pnpm cf-typegen:api`; `pnpm --filter api-turistear test` green (unchanged);
`pnpm build:app` clean. Apply the migration to a scratch/local D1 and confirm it applies remotely
without the per-statement FK rollback that bit `0040`.

**Exit:** schema exists, nothing consumes it.

---

## Phase 1 — Admin zone definitions, enable/disable, editing (backend)

The whole authoring surface. This is the largest phase and the one where the snapshot/eager
invariants are established.

**Routes** (mirror the `unit-types` collection shape, admin-only, Rules 1–4):
```
POST/GET/PUT/DELETE  /api/services/:id/zones[/:zoneId]
POST                 /api/services/:id/zones/:zoneId/deactivate|reactivate
POST                 /api/services/:id/zones/enable   { zones[], assign_existing_to }
POST                 /api/services/:id/zones/disable
```

**Core logic**
- `enable`: one chunked batch — insert `service_zones`; set `zones_enabled=1`; clear
  `is_flexible`/`flex_capacity_pct`; **eager-create `slot_zones` for every future slot, one row
  per zone, capacity snapshotted**; seed `assign_existing_to.booked = slots.booked` where
  `booked>0`; **backfill `folio_lines.zone_id`/`zone_name`**; reconcile future slots.
- `disable`: freeze future `slots.capacity` = current derived total, delete future `slot_zones`,
  keep past rows; `zones_enabled=0`.
- Edit rules (§ Editing zones): rename (free), shrink (≥ MAX future booked, else `409`), grow,
  add (inserts snapshotted future rows), delete (only if unsold) vs deactivate. Each capacity
  change re-snapshots **future** `slot_zones` and reconciles (rule 4).
- **Slot materialization integration** — the load-bearing cross-cut: `createSchedule` and
  `createSlot` (`src/routes/services/slots.handler.ts`) insert `slot_zones` rows in the **same
  batch** as the slot for a zoned service. This is where I most recently worked; reuse that batch.
- `PUT …/slots/:slotId` rejects a `capacity` change on a zoned service (`400`).
- Flex mutual-exclusion in the `services` Zod schema + catalog handler (coerce on enable).

**Validation (Zod):** name 1–40 trimmed & case-insensitively unique (`409`); capacity ≥ 1;
2–6 active zones; `assign_existing_to` required & valid when future sales exist.

**Tests** (`test/catalog/zoned-capacity.test.ts`): Scenarios **1–7, 18–21, 24, 27, 28, 30**.
Scenario 7 (pre-existing folio cancels cleanly after enable) is the backfill regression — seed a
paid folio line directly, enable, cancel, assert the zone counter and `slots.booked` both drop.

**Exit:** an admin can define, enable, edit, disable zones; new departures get zone rows; nothing
sells yet.

---

## Phase 2 — Selling a zone (backend)

**Sale path** (`confirmSale`, `src/routes/pos/handler.ts`)
- Sale schema: slot line accepts optional `zone_id`; required on zoned, refused on unzoned.
- Replace the slot guard with the **single-statement zone guard** against `slot_zones.capacity`
  (row exists — eager). Zero rows → `409 ZONE_UNAVAILABLE` → existing `compensate()`.
- Append `reconcileSlotTotals(slotId)` to the same batch. Snapshot `zone_name` onto the line.
- A split party = two lines, one folio (falls out of the existing per-line loop); one QR per line.

**POS payload** (`getPosService`): add the `zones` array per slot from `slot_zones`
(incl. `status`). Rollup (`listPosServices`) needs no change — rule 2 keeps `slots.booked` right.

**Tests:** Scenarios **8–14, 29**. Scenario 14 (concurrent last seat) asserts the guard holds
under race, mirroring US-AG11.

**Exit:** agents sell specific zones; overbooking a zone is impossible.

---

## Phase 3 — Release paths (backend)

Every path that returns seats must return them to the zone, then reconcile. This is the highest-
risk phase for silent counter drift, so it is isolated for focused review.

- `compensate()` — give back `slot_zones.booked` (already exercised by Phase 2 failures; harden).
- `sweep.ts` (expiry) — release each expired booking's zone seats + reconcile, per batch.
- Manual cancel — release per zone + reconcile.
- Un-cancel re-block — re-block **into the same zone**, guarded; may now fail if the zone refilled
  → reuse the existing "cannot re-block" path.

**Tests:** Scenarios **15, 16, 17**.

**Exit:** no code path can strand or double-count a zone seat.

---

## Phase 4 — Per-departure close/reopen (backend)

- `POST …/slots/:slotId/zones/:zoneId/close|reopen` — flip `slot_zones.status` + reconcile, one
  batch. Closing blocks new sales; sold seats stay valid.

**Tests:** Scenarios **22, 23**.

---

## Phase 5 — Scanner & portal read-through (backend, small)

- `scanTicket` (`routes/tickets/handler.ts`): `TicketContext` gains `zone_name` from the line.
  **`TicketPayload` is untouched** — pre-feature QRs stay valid.
- Portal folio view (`routes/portal/handler.tsx`): show the zone under the date line.

**Tests:** Scenarios **25, 26** (26 = a pre-feature token still verifies).

**Exit:** the entire backend contract (Scenarios 1–30) is green.

---

## Phase 6 — Frontend

Backend-complete before this starts, so every screen reads a real payload.

- **Wizard** (`features/catalog/components/wizard`): "Dividir en zonas" checkbox → name+seats
  editor (add/remove, live total, min 2); Soft-Cap warning on enable; per-service capacity field
  becomes the read-only derived total.
- **Catalog list** (`ServiceRow`): zoned meta line ("20 alto · 30 bajo").
- **Detail** (`CatalogDetailPage`): `ZonesSection` mirroring `UnitsSection` (shared `SectionCard`
  / `FormSheet` / `ConfirmSheet`).
- **Schedules section**: per-departure zone breakdown + close/reopen (icon-paired red on a closed
  zone, per the design system).
- **POS** (`SlotPicker`): zone chips expand under a tapped departure; quantity bounded by the
  zone's remaining; sold-out/closed zone disabled like `(Agotado)`.
- **Cart** (`store/posCart.ts`): key slot lines by `slotId + zoneId` — `lineKey`, `addLine`
  dedupe, `updateQuantity`, `updateExtraQuantity`. **This is the frontend correctness pin**: miss
  it and a split party collapses into one wrong line.
- **Labels**: zone on cart, folio, receipt, portal, scanner result card.

**Verify:** `pnpm lint:app` at baseline; `pnpm build:app` clean; live walkthrough at 375px —
define zones, sell a split party, close a zone, scan both tickets.

---

## Phase 7 — Docs & final gate

- `SPEC.md`: US-A64 entry, inventory-rule line, glossary ("zone"). **No `TECH_DEBT.md` entry** —
  by design there is no deferred limitation.
- Full suite green: `pnpm --filter api-turistear test`, `pnpm build:app`, `pnpm lint:app`.
- Deploy API then app (API first — the app's new reads depend on the new payload); allow edge
  propagation before verifying live (the lesson from the schedule-atomicity deploy).

---

## Dependency graph

```
P0 ─▶ P1 ─▶ P2 ─▶ P3 ─▶ P4 ─▶ P5 ─▶ P6 ─▶ P7
       │            (P3/P4/P5 each depend only on P2)
       └─ slot-materialization hook lives here, used by every later sale
```

Strictly linear on the backend; P6 needs the whole backend contract; P7 gates the release.

## What is deliberately NOT in scope (and is not debt)

- **Per-zone pricing** — a real future feature (additive `service_zones` columns + the pricing
  stack), not a shortcut taken here.
- **Per-line cancellation** — pre-existing product gap (cancellation is whole-folio,
  `docs/cancellation/total-folio-cancellation.spec.md`); zoned capacity works correctly with it
  (a cancel releases all lines' zones). Not introduced by this feature, so not this feature's debt.
- **Gate enforcement / per-device scanner config** — the scanner displays the zone by design.

None of these leave a `TODO` or a workaround in the shipped code; they are simply other features.
