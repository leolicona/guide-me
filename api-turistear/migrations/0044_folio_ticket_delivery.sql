-- WhatsApp ticket delivery tracking (docs/whatsapp-qr-delivery/spec.md — D4). A delivery axis on
-- the folio, separate from payment status:
--   tickets_sent_at / tickets_sent_by — the agent tapped "Enviar por WhatsApp" (their metric,
--     cleared once they act; idempotent last-write-wins, D13).
--   tickets_viewed_at — the tourist opened the portal (the bot-proof "Visto" beacon, first-view).
-- A folio is "pendiente de enviar" once a portal link exists and tickets_sent_at is null.
--
-- Plain nullable ADD COLUMNs — no table rebuild, safe on D1 --remote per-statement.
ALTER TABLE `folios` ADD COLUMN `tickets_sent_at` integer;
--> statement-breakpoint
ALTER TABLE `folios` ADD COLUMN `tickets_sent_by` text REFERENCES users(id);
--> statement-breakpoint
ALTER TABLE `folios` ADD COLUMN `tickets_viewed_at` integer;
