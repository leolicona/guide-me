CREATE TABLE `cancellation_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`folio_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`reason` text,
	`resolution_note` text,
	`resolved_by` text,
	`resolved_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`folio_id`) REFERENCES `folios`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`resolved_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_cancellation_requests_folio` ON `cancellation_requests` (`folio_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_cancellation_requests_open` ON `cancellation_requests` (`folio_id`) WHERE `status` = 'pending';
