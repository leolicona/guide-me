-- Service-based commission (docs/commissions/service-based-commission.spec.md).
-- Commission moves from the seller (users.base_commission, now deprecated/unread) to the
-- service: `commission_type` ('percent' | 'fixed') + `commission_value` (basis points when
-- percent; minor units PER SPOT when fixed). The old per-service bonus % becomes the
-- service's full percent rate (backfill), then the bonus column is dropped.
ALTER TABLE `services` ADD COLUMN `commission_type` text DEFAULT 'percent' NOT NULL;
ALTER TABLE `services` ADD COLUMN `commission_value` integer DEFAULT 0 NOT NULL;
UPDATE `services` SET `commission_value` = `commission_bonus`;
ALTER TABLE `services` DROP COLUMN `commission_bonus`;
