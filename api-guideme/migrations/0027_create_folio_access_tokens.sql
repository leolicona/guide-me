CREATE TABLE `folio_access_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`folio_id` text NOT NULL,
	`token` text NOT NULL,
	`expires_at` integer NOT NULL,
	`last_accessed_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`folio_id`) REFERENCES `folios`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `folio_access_tokens_token_unique` ON `folio_access_tokens` (`token`);
--> statement-breakpoint
CREATE INDEX `idx_folio_access_tokens_folio` ON `folio_access_tokens` (`folio_id`);
