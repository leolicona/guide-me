ALTER TABLE `folios` ADD COLUMN `cancelled_at` integer;
--> statement-breakpoint
ALTER TABLE `folios` ADD COLUMN `cancelled_by` text REFERENCES `users`(`id`);
--> statement-breakpoint
ALTER TABLE `folios` ADD COLUMN `cancellation_reason` text;
