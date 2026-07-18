ALTER TABLE `organizations` ADD COLUMN `booking_min_down_payment_pct` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `organizations` ADD COLUMN `booking_hold_days` integer DEFAULT 7 NOT NULL;
--> statement-breakpoint
ALTER TABLE `organizations` ADD COLUMN `same_day_buffer_minutes` integer DEFAULT 15 NOT NULL;
--> statement-breakpoint
ALTER TABLE `folios` ADD COLUMN `booking_expires_at` integer;
--> statement-breakpoint
ALTER TABLE `folios` ADD COLUMN `settled_at` integer;
--> statement-breakpoint
ALTER TABLE `folios` ADD COLUMN `settled_by` text REFERENCES `users`(`id`);
--> statement-breakpoint
ALTER TABLE `folios` ADD COLUMN `reminder_status` text DEFAULT 'none' NOT NULL;
--> statement-breakpoint
ALTER TABLE `folios` ADD COLUMN `reminder_sent_at` integer;
--> statement-breakpoint
ALTER TABLE `folios` ADD COLUMN `reminder_sent_by` text REFERENCES `users`(`id`);
--> statement-breakpoint
ALTER TABLE `folio_lines` ADD COLUMN `commission_type` text DEFAULT 'percent' NOT NULL;
--> statement-breakpoint
ALTER TABLE `folio_lines` ADD COLUMN `commission_value` integer DEFAULT 0 NOT NULL;
