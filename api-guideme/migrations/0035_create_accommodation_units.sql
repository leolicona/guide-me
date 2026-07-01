-- Accommodation Stays (docs/lodging/accommodation-stays.spec.md §2.1).
-- A `lodging` service (services.category = 'lodging') is a property/listing that owns named,
-- individually-bookable units. Each unit carries its OWN nightly pricing, occupancy, stay rules,
-- and amenities (a suite ≠ a cabin). organization_id is carried directly (Rule 5) for per-query
-- org filtering + an org-leading index (Rule 6). Money is integer minor units; amenities is a CSV
-- of amenity enum keys (mirrors schedules.weekdays). Soft-deactivated, never hard-deleted.
CREATE TABLE `accommodation_units` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`service_id` text NOT NULL,
	`name` text NOT NULL,
	`unit_type` text,
	`beds` integer NOT NULL,
	`base_occupancy` integer NOT NULL,
	`max_capacity` integer NOT NULL,
	`base_rate` integer NOT NULL,
	`weekend_rate` integer,
	`extra_person_fee` integer DEFAULT 0 NOT NULL,
	`min_nights` integer DEFAULT 1 NOT NULL,
	`checkin_time` text DEFAULT '15:00' NOT NULL,
	`checkout_time` text DEFAULT '11:00' NOT NULL,
	`amenities` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `accommodation_units_org_service_idx` ON `accommodation_units` (`organization_id`, `service_id`, `status`);
