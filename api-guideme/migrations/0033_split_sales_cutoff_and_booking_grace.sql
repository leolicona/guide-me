-- US-A47 — split the single same-day buffer into two independent policies:
--   sales_cutoff_offset_minutes  — closes NEW walk-in sales + booking creation on a departing slot
--   booking_grace_offset_minutes — when an UNSETTLED same-day booking auto-cancels (renamed buffer)
-- Both are SIGNED minutes: positive = N min BEFORE departure; negative = N min AFTER (a grace
-- window). The rename preserves the existing buffer value (default 15 = 15 min before).
ALTER TABLE `organizations` ADD COLUMN `sales_cutoff_offset_minutes` integer DEFAULT 0 NOT NULL;
ALTER TABLE `organizations` RENAME COLUMN `same_day_buffer_minutes` TO `booking_grace_offset_minutes`;
