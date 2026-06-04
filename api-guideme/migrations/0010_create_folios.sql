CREATE TABLE `folios` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`customer_name` text,
	`customer_email` text,
	`customer_phone` text,
	`status` text DEFAULT 'paid' NOT NULL,
	`subtotal` integer NOT NULL,
	`discount_total` integer DEFAULT 0 NOT NULL,
	`total` integer NOT NULL,
	`amount_paid` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `folios_org_agent_idx` ON `folios` (`organization_id`, `agent_id`);
--> statement-breakpoint
CREATE INDEX `folios_org_created_idx` ON `folios` (`organization_id`, `created_at`);
