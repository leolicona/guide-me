CREATE TABLE `folio_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`folio_id` text NOT NULL,
	`service_id` text NOT NULL,
	`slot_id` text NOT NULL,
	`service_name` text NOT NULL,
	`slot_date` text NOT NULL,
	`slot_start_time` text NOT NULL,
	`quantity` integer NOT NULL,
	`base_price` integer NOT NULL,
	`minimum_price` integer NOT NULL,
	`unit_price` integer NOT NULL,
	`line_total` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`folio_id`) REFERENCES `folios`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`slot_id`) REFERENCES `slots`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `folio_lines_org_folio_idx` ON `folio_lines` (`organization_id`, `folio_id`);
--> statement-breakpoint
CREATE INDEX `folio_lines_org_slot_idx` ON `folio_lines` (`organization_id`, `slot_id`);
