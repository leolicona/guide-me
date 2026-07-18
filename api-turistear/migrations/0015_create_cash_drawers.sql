CREATE TABLE `cash_drawers` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`business_date` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`total_collected` integer,
	`pending_balance` integer,
	`expense_total` integer,
	`net_balance` integer,
	`folio_count` integer,
	`submitted_at` integer,
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
CREATE UNIQUE INDEX `cash_drawers_org_agent_date_unique_idx` ON `cash_drawers` (`organization_id`, `agent_id`, `business_date`);
--> statement-breakpoint
CREATE INDEX `cash_drawers_org_status_idx` ON `cash_drawers` (`organization_id`, `status`);
