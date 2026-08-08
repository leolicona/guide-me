-- US-A86 / US-AG51 — the notification outbox
-- (docs/folios/folio-state-machine.spec.md, D8, D12, D14, D20, D21, D26).
--
-- Until now every customer-facing message was dispatched INLINE from whichever handler caused it.
-- A Resend outage therefore consumed the one notification a customer gets, silently — a defect
-- already paid for once (apartado-stages.spec.md S8, added during that build).
--
-- One row per (folio, event, channel) the system decided to emit. `status` is the DRAIN's state,
-- never the folio's:
--   pending → not sent yet: the email drain has not run, or the WhatsApp tap has not happened
--   sent    → it left (automatically for email, or a human tapped for WhatsApp)
--   failed  → the provider refused; retried by the drain, never silently dropped
--   skipped → the event fired but this channel does not apply (no email on file)
--
-- D20 — every one of the eight events is written to the customer by WhatsApp; email is emitted
-- ADDITIONALLY whenever there is an address. Written notice is what prevents a dispute; email is a
-- durable second copy, never a substitute.
--
-- D21 — what a drained row proves is that we SENT, not that they received. There is deliberately
-- NO `viewed_at` column: reading is measured only where a beacon exists, which today is
-- `folios.tickets_viewed_at` and the tickets alone. A column here would be a second home for that
-- fact, and null for seven of eight events by unmeasurability rather than by non-reading.

CREATE TABLE notifications (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL REFERENCES organizations(id),
  folio_id         TEXT NOT NULL REFERENCES folios(id),
  event            TEXT NOT NULL,
  channel          TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending',
  attempts         INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  sent_at          INTEGER,
  sent_by          TEXT REFERENCES users(id),
  created_at       INTEGER NOT NULL DEFAULT (unixepoch())
);

-- The admin outbox view and the email drain both read (org, status, oldest first).
CREATE INDEX idx_notifications_org_status
  ON notifications(organization_id, status, created_at);

-- The re-send guard. A cron re-run, a retried sweep or a double-tapped button cannot duplicate a
-- message — the same property `folios.reminder_status` gives the stage-② notice today, generalised
-- to every event. Emits use INSERT OR IGNORE and lean on this.
CREATE UNIQUE INDEX uq_notifications_folio_event_channel
  ON notifications(folio_id, event, channel);
