-- Accommodation seasonal rate override (docs/lodging/accommodation-stays.spec.md §2.2).
-- A flat nightly rate that applies to EVERY night in [start_date, end_date] for one unit; it
-- outranks the weekend rate (precedence: seasonal > weekend > base). Overlapping active seasons
-- for the same unit are rejected at write time (409 SEASON_OVERLAP). service_id is denormalized
-- for org-leading queries. Soft-deactivated.
CREATE TABLE `accommodation_seasons` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`service_id` text NOT NULL,
	`unit_id` text NOT NULL,
	`name` text NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text NOT NULL,
	`nightly_rate` integer NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`unit_id`) REFERENCES `accommodation_units`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `accommodation_seasons_org_unit_idx` ON `accommodation_seasons` (`organization_id`, `unit_id`, `start_date`);
