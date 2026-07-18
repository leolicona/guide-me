ALTER TABLE `cash_drops` ADD COLUMN `source` text DEFAULT 'agent' NOT NULL;
--> statement-breakpoint
ALTER TABLE `cash_drops` ADD COLUMN `acknowledgment` text DEFAULT 'not_required' NOT NULL;
--> statement-breakpoint
ALTER TABLE `cash_drops` ADD COLUMN `acknowledged_at` integer;
--> statement-breakpoint
ALTER TABLE `cash_drops` ADD COLUMN `ack_note` text;
--> statement-breakpoint
ALTER TABLE `cash_drops` ADD COLUMN `ack_resolved_by` text REFERENCES `users`(`id`);
