-- Per-unit commission override — the "waterfall" model (US-A12, lodging). A unit MAY override the
-- service's base commission; a NULL `commission_type` means "inherit the service rate". When set,
-- `commission_value` mirrors services.commission_*: basis points for 'percent' (1000 = 10%) or
-- minor units for 'fixed'. Both columns are nullable and set together (enforced in the API schema).
--
-- Plain nullable ADD COLUMNs — no table rebuild, no inbound-FK concerns (contrast 0040). Safe to
-- apply on D1 --remote per-statement.
ALTER TABLE `accommodation_units` ADD COLUMN `commission_type` text;
--> statement-breakpoint
ALTER TABLE `accommodation_units` ADD COLUMN `commission_value` integer;
