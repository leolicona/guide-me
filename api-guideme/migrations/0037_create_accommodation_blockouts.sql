-- Accommodation block-out range (docs/lodging/accommodation-stays.spec.md §2.3).
-- Admin-declared dates a unit cannot be sold (maintenance, owner use). Half-open [start_date,
-- end_date) to match standard hotel turnover (the end date is free for a same-day arrival).
-- Hard-deletable (no historical value, unlike a sold reservation) — so no status column.
CREATE TABLE `accommodation_blockouts` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`service_id` text NOT NULL,
	`unit_id` text NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text NOT NULL,
	`reason` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`unit_id`) REFERENCES `accommodation_units`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `accommodation_blockouts_org_unit_idx` ON `accommodation_blockouts` (`organization_id`, `unit_id`, `start_date`);
