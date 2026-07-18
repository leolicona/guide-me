-- Unit-Type Inventory transition (docs/RFCs/rfc-airbnb-inventory-model.md, approved 2026-07-07;
-- spec v2: docs/lodging/accommodation-stays.spec.md §2). Physical units become UNIT TYPES with an
-- `inventory_count`; reservations/blockouts gain a `quantity`; `unit_id` FKs become `unit_type_id`.
--
-- RENAME, DON'T DROP (the 0040 lesson): D1's remote /query endpoint enforces FK constraints per
-- statement and ignores `PRAGMA defer_foreign_keys`. `folio_lines`, `accommodation_reservations`,
-- `accommodation_seasons` and `accommodation_blockouts` all hold FKs into `accommodation_units`,
-- so a DROP would force a multi-table rebuild. `ALTER TABLE … RENAME` (table and column) instead
-- auto-repoints every inbound FK definition, keeping each statement valid on its own.
--
-- Existing lodging rows are dev/test data (confirmed disposable) — wiped below, no transform.
-- Stay folios/lines are wiped too (their unit_id would dangle semantically); tour folios stay.

-- 1) Wipe stay inventory + stay sales test data (children before parents, per-statement FK-safe).
DELETE FROM accommodation_reservations;
--> statement-breakpoint
DELETE FROM accommodation_blockouts;
--> statement-breakpoint
DELETE FROM accommodation_seasons;
--> statement-breakpoint
DELETE FROM folio_line_extras WHERE folio_line_id IN
  (SELECT id FROM folio_lines WHERE line_type = 'stay');
--> statement-breakpoint
DELETE FROM folio_lines WHERE line_type = 'stay';
--> statement-breakpoint
-- Folios left with zero lines (stay-only test sales): remove their dependents, then the folios.
DELETE FROM folio_access_tokens WHERE folio_id IN
  (SELECT id FROM folios WHERE id NOT IN (SELECT folio_id FROM folio_lines));
--> statement-breakpoint
DELETE FROM cancellation_requests WHERE folio_id IN
  (SELECT id FROM folios WHERE id NOT IN (SELECT folio_id FROM folio_lines));
--> statement-breakpoint
DELETE FROM folios WHERE id NOT IN (SELECT folio_id FROM folio_lines);
--> statement-breakpoint
DELETE FROM accommodation_units;
--> statement-breakpoint

-- 2) The physical-units table becomes the unit-types table (all columns already describe a type).
ALTER TABLE accommodation_units RENAME TO accommodation_unit_types;
--> statement-breakpoint
ALTER TABLE accommodation_unit_types ADD COLUMN inventory_count integer NOT NULL DEFAULT 1;
--> statement-breakpoint

-- 3) Re-key children to the type + add the reserved/blocked quantities.
ALTER TABLE accommodation_reservations RENAME COLUMN unit_id TO unit_type_id;
--> statement-breakpoint
ALTER TABLE accommodation_reservations ADD COLUMN quantity integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE accommodation_blockouts RENAME COLUMN unit_id TO unit_type_id;
--> statement-breakpoint
ALTER TABLE accommodation_blockouts ADD COLUMN quantity integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE accommodation_seasons RENAME COLUMN unit_id TO unit_type_id;
--> statement-breakpoint
-- folio_lines: rename only — its existing `quantity` column now carries the room count for stays.
ALTER TABLE folio_lines RENAME COLUMN unit_id TO unit_type_id;
