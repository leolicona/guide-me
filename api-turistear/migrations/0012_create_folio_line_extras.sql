CREATE TABLE `folio_line_extras` (
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
CREATE INDEX `folio_line_extras_org_folio_idx` ON `folio_line_extras` (`organization_id`, `folio_id`);
