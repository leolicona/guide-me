ALTER TABLE `folios` ADD COLUMN `refund_status` text DEFAULT 'none' NOT NULL;
--> statement-breakpoint
ALTER TABLE `folios` ADD COLUMN `refund_amount` integer;
--> statement-breakpoint
ALTER TABLE `folios` ADD COLUMN `refund_pin` text;
--> statement-breakpoint
ALTER TABLE `folios` ADD COLUMN `refund_pin_attempts` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `folios` ADD COLUMN `refund_note` text;
--> statement-breakpoint
ALTER TABLE `folios` ADD COLUMN `refunded_at` integer;
--> statement-breakpoint
ALTER TABLE `folios` ADD COLUMN `refunded_by` text REFERENCES `users`(`id`);
