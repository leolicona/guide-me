ALTER TABLE `users` ADD `base_commission` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE INDEX `users_org_role_status_idx` ON `users` (`organization_id`, `role`, `status`);
