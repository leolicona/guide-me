-- Zoned Capacity (US-A64 — docs/catalog/zoned-capacity.spec.md). Opt-in per slot-based service:
-- subdivide a departure's seats into 2–6 named zones (e.g. Turibus Piso alto / Piso bajo), each
-- with its own count, so agents sell a specific zone and no area is overbooked. A pure inventory
-- partition — same price/commission/extras, no per-zone pricing.
--
-- `service_zones` = the authored zone definitions (name + seats). `slot_zones` = one row per
-- (departure, zone) carrying a SNAPSHOTTED capacity (frozen per departure, so editing a zone
-- later never rewrites past departures) plus its own booked counter. `slots.capacity`/`booked`
-- are reconciled as the sum over open zones, so every existing availability read is untouched.
--
-- Purely additive: two new tables + three nullable/defaulted columns. No table rebuild, so none
-- of the 0040/0042 inbound-FK rebuild hazards apply — every statement is FK-valid on its own and
-- safe on D1 --remote (which enforces FKs per statement).

CREATE TABLE `service_zones` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`service_id` text NOT NULL,
	`name` text NOT NULL,
	`capacity` integer NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `service_zones_org_service_idx` ON `service_zones` (`organization_id`, `service_id`, `sort_order`);
--> statement-breakpoint
-- One row per (departure, zone). `capacity` is snapshotted from service_zones at creation and
-- frozen thereafter (past departures never re-snapshot). The UNIQUE(slot_id, zone_id) is the row
-- identity the atomic sale guard depends on.
CREATE TABLE `slot_zones` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`slot_id` text NOT NULL,
	`zone_id` text NOT NULL,
	`capacity` integer NOT NULL,
	`booked` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`slot_id`) REFERENCES `slots`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`zone_id`) REFERENCES `service_zones`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `slot_zones_slot_zone_uq` ON `slot_zones` (`slot_id`, `zone_id`);
--> statement-breakpoint
CREATE INDEX `slot_zones_org_slot_idx` ON `slot_zones` (`organization_id`, `slot_id`);
--> statement-breakpoint
-- Opt-in flag. Every existing service becomes an unzoned single pool — byte-identical to today.
ALTER TABLE `services` ADD COLUMN `zones_enabled` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- The zone a sold line's seats occupy (NULL for an unzoned sale or a lodging stay line) + a
-- snapshot of the zone name at sale time, so renaming a zone never rewrites a sold ticket.
ALTER TABLE `folio_lines` ADD COLUMN `zone_id` text REFERENCES `service_zones`(`id`);
--> statement-breakpoint
ALTER TABLE `folio_lines` ADD COLUMN `zone_name` text;
