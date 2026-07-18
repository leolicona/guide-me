-- Accommodation reservation — THE inventory unit (docs/lodging/accommodation-stays.spec.md §2.4).
-- One row per sold stay line. The lodging analogue of slots.booked: every availability check
-- reads it and every cancellation releases it. A stay occupies nights [check_in, check_out)
-- (half-open, standard turnover). `active` holds the dates (covers both 'booking' and 'paid'
-- folios — the folio carries the deposit/paid distinction); cancel/expiry flips to 'cancelled',
-- freeing the dates. Overlap is enforced at confirm/reactivate by a conditional INSERT (no DB
-- exclusion constraint exists in SQLite); the index makes the overlap probe cheap.
CREATE TABLE `accommodation_reservations` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`service_id` text NOT NULL,
	`unit_id` text NOT NULL,
	`folio_id` text NOT NULL,
	`check_in` text NOT NULL,
	`check_out` text NOT NULL,
	`guests` integer NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`unit_id`) REFERENCES `accommodation_units`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`folio_id`) REFERENCES `folios`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `accommodation_reservations_org_unit_dates_idx` ON `accommodation_reservations` (`organization_id`, `unit_id`, `check_in`, `check_out`);
