CREATE TABLE `slots` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`service_id` text NOT NULL,
	`schedule_id` text,
	`date` text NOT NULL,
	`start_time` text NOT NULL,
	`capacity` integer NOT NULL,
	`booked` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`schedule_id`) REFERENCES `schedules`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `slots_org_service_date_idx` ON `slots` (`organization_id`, `service_id`, `date`);
--> statement-breakpoint
CREATE UNIQUE INDEX `slots_active_unique_idx` ON `slots` (`organization_id`, `service_id`, `date`, `start_time`) WHERE `status` = 'active';
