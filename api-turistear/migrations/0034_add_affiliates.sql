-- Affiliate program (docs/affiliates/affiliate-setup-commissions.spec.md + affiliate-portal.spec.md).
-- Additive only: three new tables + nullable FK columns + a `position` column. The `users.role`
-- enum is app-level text (no DB CHECK), so adding 'affiliate' needs no column rebuild.
--
--   affiliate_companies     — the partner company (hotel / agency / restaurant). US-A48/A52/A55.
--   affiliate_commissions   — the allow-list AND the per-service rate (D1/D2). UNIQUE(company,service).
--   affiliate_invitations   — parallel invite flow (D8): carries role + company explicitly so the
--                             agent invite path stays untouched.
--   users.affiliate_company_id — links an `affiliate` user to its company (set at acceptance).
--   users.position             — optional job title collected at affiliate onboarding (US-AF01).
--   folios.affiliate_company_id — sale attribution (D5): null for in-house (agent/admin) sales.
CREATE TABLE `affiliate_companies` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`contact_email` text,
	`contact_phone` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `affiliate_companies_org_idx` ON `affiliate_companies` (`organization_id`);
--> statement-breakpoint
CREATE TABLE `affiliate_commissions` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`affiliate_company_id` text NOT NULL,
	`service_id` text NOT NULL,
	`commission_type` text NOT NULL,
	`commission_value` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`affiliate_company_id`) REFERENCES `affiliate_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `affiliate_commissions_company_service_unique` ON `affiliate_commissions` (`affiliate_company_id`, `service_id`);
--> statement-breakpoint
CREATE INDEX `affiliate_commissions_org_company_idx` ON `affiliate_commissions` (`organization_id`, `affiliate_company_id`);
--> statement-breakpoint
CREATE TABLE `affiliate_invitations` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`affiliate_company_id` text NOT NULL,
	`identity` text NOT NULL,
	`identity_type` text DEFAULT 'email' NOT NULL,
	`token` text NOT NULL,
	`invited_by` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`affiliate_company_id`) REFERENCES `affiliate_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`invited_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `affiliate_invitations_token_unique` ON `affiliate_invitations` (`token`);
--> statement-breakpoint
CREATE INDEX `affiliate_invitations_company_status_idx` ON `affiliate_invitations` (`affiliate_company_id`, `status`);
--> statement-breakpoint
ALTER TABLE `users` ADD COLUMN `affiliate_company_id` text REFERENCES `affiliate_companies`(`id`);
--> statement-breakpoint
ALTER TABLE `users` ADD COLUMN `position` text;
--> statement-breakpoint
ALTER TABLE `folios` ADD COLUMN `affiliate_company_id` text REFERENCES `affiliate_companies`(`id`);
