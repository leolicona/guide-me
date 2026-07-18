CREATE TABLE `cash_drawer_expenses` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`cash_drawer_id` text NOT NULL,
	`description` text NOT NULL,
	`amount` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`cash_drawer_id`) REFERENCES `cash_drawers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `cash_drawer_expenses_org_drawer_idx` ON `cash_drawer_expenses` (`organization_id`, `cash_drawer_id`);
