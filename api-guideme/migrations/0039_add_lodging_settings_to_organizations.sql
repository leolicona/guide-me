-- Org-level lodging settings (docs/lodging/accommodation-stays.spec.md §2.5). Additive,
-- default-safe: existing orgs get Fri+Sat weekends, no free-cancel window, no penalty.
--   lodging_weekend_days       — CSV of ISO weekday ints (0=Sun … 6=Sat); which nights use weekend_rate.
--   lodging_free_cancel_days   — a PAID stay cancels free until this many days before check_in (0 = none).
--   lodging_cancel_penalty_pct — penalty (% of stay total) retained when cancelled inside the window.
ALTER TABLE `organizations` ADD COLUMN `lodging_weekend_days` text DEFAULT '5,6' NOT NULL;
--> statement-breakpoint
ALTER TABLE `organizations` ADD COLUMN `lodging_free_cancel_days` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `organizations` ADD COLUMN `lodging_cancel_penalty_pct` integer DEFAULT 0 NOT NULL;
