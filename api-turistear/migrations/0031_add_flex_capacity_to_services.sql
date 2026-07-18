-- US-A36 — Flexible Capacity & Overbooking Tolerance (docs/catalog/flexible-capacity.spec.md).
-- is_flexible = 0 → Hard Cap (strict, the default & today's behaviour for every existing row).
-- is_flexible = 1 → Soft Cap: the POS allows up to flex_capacity_pct extra spots per slot
-- (floor(slot.capacity × pct / 100)). flex_capacity_pct is 0 (and ignored) for Hard Cap.
-- Additive + default-safe: every existing service becomes Hard Cap with a 0 tolerance.
ALTER TABLE `services` ADD COLUMN `is_flexible` integer DEFAULT 0 NOT NULL;
ALTER TABLE `services` ADD COLUMN `flex_capacity_pct` integer DEFAULT 0 NOT NULL;
