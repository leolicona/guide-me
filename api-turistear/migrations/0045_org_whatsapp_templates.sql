-- Admin-edited WhatsApp message templates (docs/whatsapp-qr-delivery/spec.md — D10). NULL ⇒ the
-- shipped default (utils/waTemplates) is used. wa_ticket_template delivers paid tickets (tours +
-- lodging) and must contain {portal_link}; wa_reminder_template is the apartado payment reminder.
--
-- Plain nullable ADD COLUMNs — no table rebuild, safe on D1 --remote per-statement.
ALTER TABLE `organizations` ADD COLUMN `wa_ticket_template` text;
--> statement-breakpoint
ALTER TABLE `organizations` ADD COLUMN `wa_reminder_template` text;
