CREATE TABLE `cash_drops` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`amount` integer NOT NULL,
	`balance_before` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`note` text,
	`reviewed_by` text,
	`reviewed_at` integer,
	`review_note` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reviewed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `cash_drops_org_status_idx` ON `cash_drops` (`organization_id`, `status`);
--> statement-breakpoint
CREATE INDEX `cash_drops_org_agent_idx` ON `cash_drops` (`organization_id`, `agent_id`);
