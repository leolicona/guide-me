-- Accommodation stay lines on folio_lines (docs/lodging/accommodation-stays.spec.md §4.4, Option A
-- — one unified line list). A stay has a unit + date range and NO slot, so slot_id/slot_date/
-- slot_start_time must become nullable and new stay columns are added. SQLite can't drop a NOT NULL
-- column in place, so folio_lines needs a full table rebuild.
--
-- IMPORTANT — why this isn't a plain rebuild: D1's REMOTE /query endpoint enforces FK constraints
-- per statement and does NOT honor `PRAGMA defer_foreign_keys` (local Miniflare does, which is why
-- the naive defer-based rebuild passed tests but rolled back on `wrangler d1 migrations apply
-- --remote` with: FOREIGN KEY constraint failed). folio_line_extras is the only table with an
-- inbound FK to folio_lines, so `DROP TABLE folio_lines` orphans it the instant it runs.
--
-- To stay valid at EVERY statement boundary we: (1) rebuild folio_line_extras WITHOUT its
-- folio_lines FK so folio_lines has no inbound reference, (2) swap folio_lines, then (3) rebuild
-- folio_line_extras again to restore all its FKs against the new folio_lines. Row ids are preserved
-- throughout, so each FK check passes. The PRAGMA stays as a harmless safety net for engines that
-- DO defer (e.g. local Miniflare runs the file in one transaction).
PRAGMA defer_foreign_keys = TRUE;
--> statement-breakpoint
-- 1) New folio_lines shape: slot_* nullable + stay columns (line_type/unit_id/check_in/…).
CREATE TABLE `folio_lines_new` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`folio_id` text NOT NULL,
	`service_id` text NOT NULL,
	`slot_id` text,
	`service_name` text NOT NULL,
	`slot_date` text,
	`slot_start_time` text,
	`quantity` integer NOT NULL,
	`base_price` integer NOT NULL,
	`minimum_price` integer NOT NULL,
	`unit_price` integer NOT NULL,
	`line_total` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`qr_token` text,
	`redeemed_count` integer DEFAULT 0 NOT NULL,
	`commission_type` text DEFAULT 'percent' NOT NULL,
	`commission_value` integer DEFAULT 0 NOT NULL,
	`line_type` text DEFAULT 'slot' NOT NULL,
	`unit_id` text,
	`check_in` text,
	`check_out` text,
	`guests` integer,
	`nights` integer,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`folio_id`) REFERENCES `folios`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`slot_id`) REFERENCES `slots`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`unit_id`) REFERENCES `accommodation_units`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `folio_lines_new`
	(`id`, `organization_id`, `folio_id`, `service_id`, `slot_id`, `service_name`, `slot_date`,
	 `slot_start_time`, `quantity`, `base_price`, `minimum_price`, `unit_price`, `line_total`,
	 `created_at`, `qr_token`, `redeemed_count`, `commission_type`, `commission_value`, `line_type`)
SELECT
	`id`, `organization_id`, `folio_id`, `service_id`, `slot_id`, `service_name`, `slot_date`,
	`slot_start_time`, `quantity`, `base_price`, `minimum_price`, `unit_price`, `line_total`,
	`created_at`, `qr_token`, `redeemed_count`, `commission_type`, `commission_value`, 'slot'
FROM `folio_lines`;
--> statement-breakpoint
-- 2) Rebuild folio_line_extras WITHOUT its folio_lines FK (transient: no FKs at all) so that
--    folio_lines has zero inbound references and can be dropped under per-statement enforcement.
CREATE TABLE `folio_line_extras_tmp` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`folio_id` text NOT NULL,
	`folio_line_id` text NOT NULL,
	`extra_id` text NOT NULL,
	`name` text NOT NULL,
	`price` integer NOT NULL,
	`quantity` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
INSERT INTO `folio_line_extras_tmp`
	(`id`, `organization_id`, `folio_id`, `folio_line_id`, `extra_id`, `name`, `price`, `quantity`, `created_at`)
SELECT
	`id`, `organization_id`, `folio_id`, `folio_line_id`, `extra_id`, `name`, `price`, `quantity`, `created_at`
FROM `folio_line_extras`;
--> statement-breakpoint
DROP TABLE `folio_line_extras`;
--> statement-breakpoint
ALTER TABLE `folio_line_extras_tmp` RENAME TO `folio_line_extras`;
--> statement-breakpoint
-- 3) Swap folio_lines — now free of inbound FKs, so the drop is FK-safe.
DROP TABLE `folio_lines`;
--> statement-breakpoint
ALTER TABLE `folio_lines_new` RENAME TO `folio_lines`;
--> statement-breakpoint
CREATE INDEX `folio_lines_org_folio_idx` ON `folio_lines` (`organization_id`, `folio_id`);
--> statement-breakpoint
CREATE INDEX `folio_lines_org_slot_idx` ON `folio_lines` (`organization_id`, `slot_id`);
--> statement-breakpoint
-- 4) Restore folio_line_extras with all four FKs (incl. folio_line_id → the rebuilt folio_lines).
--    ids were preserved by both copies, so every folio_line_id still resolves.
CREATE TABLE `folio_line_extras_final` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`folio_id` text NOT NULL,
	`folio_line_id` text NOT NULL,
	`extra_id` text NOT NULL,
	`name` text NOT NULL,
	`price` integer NOT NULL,
	`quantity` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`folio_id`) REFERENCES `folios`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`folio_line_id`) REFERENCES `folio_lines`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`extra_id`) REFERENCES `service_extras`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `folio_line_extras_final`
	(`id`, `organization_id`, `folio_id`, `folio_line_id`, `extra_id`, `name`, `price`, `quantity`, `created_at`)
SELECT
	`id`, `organization_id`, `folio_id`, `folio_line_id`, `extra_id`, `name`, `price`, `quantity`, `created_at`
FROM `folio_line_extras`;
--> statement-breakpoint
DROP TABLE `folio_line_extras`;
--> statement-breakpoint
ALTER TABLE `folio_line_extras_final` RENAME TO `folio_line_extras`;
--> statement-breakpoint
CREATE INDEX `folio_line_extras_org_folio_idx` ON `folio_line_extras` (`organization_id`, `folio_id`);
