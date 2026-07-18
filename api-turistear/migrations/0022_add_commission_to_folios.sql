ALTER TABLE `folios` ADD COLUMN `payment_method` text DEFAULT 'cash' NOT NULL;
--> statement-breakpoint
ALTER TABLE `folios` ADD COLUMN `commission_amount` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `folios` ADD COLUMN `cancellation_clawback` integer DEFAULT 0 NOT NULL;
