-- US-A24 / US-AG53 (docs/folios/folio-timeline.spec.md) — the folio's append-only narrative.
-- ADDITIVE: a new table + a one-time synthetic backfill; no folios column is touched (scope
-- boundary). One row per USER ACTION (D9); live rows are written in the same batch as their
-- mutation (D3). The table is a narrative, never an authority — nothing computes money or state
-- from it.

CREATE TABLE folio_events (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  folio_id TEXT NOT NULL REFERENCES folios(id),
  event_type TEXT NOT NULL,   -- 'created'|'payment'|'payment_verified'|'transfer_rejected'
                              -- |'tickets_sent'|'tickets_viewed'|'reminder_sent'|'rescheduled'
                              -- |'cancelled'|'refund_confirmed'
  actor_id TEXT REFERENCES users(id),                  -- NULL = the system (sweep) or the tourist (Visto)
  operator_id TEXT REFERENCES affiliate_operators(id), -- PIN-shift attribution, as in folio_payments
  payload TEXT,                                        -- JSON, shape per event_type (spec § Data Model)
  backfilled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL                          -- the event's OWN moment, never the insert's
);

-- The only read is the folio detail, oldest-first.
CREATE INDEX folio_events_folio_idx
  ON folio_events (folio_id, created_at);

-- Synthetic backfill (D4) — every mapping reads a timestamp that already exists and stamps it as
-- created_at, so a pre-migration folio arrives with its history. What left no trace
-- (transfer rejections, reschedules) is honestly absent. IDEMPOTENT like 0049: deterministic ids
-- + NOT EXISTS guards.

-- created ← the folio itself
INSERT INTO folio_events (id, organization_id, folio_id, event_type, actor_id, operator_id, payload, backfilled, created_at)
SELECT 'fev_c_' || f.id, f.organization_id, f.id, 'created', f.agent_id, f.operator_id,
       json_object('sale_mode', f.sale_mode),
       1, f.created_at
FROM folios f
WHERE NOT EXISTS (SELECT 1 FROM folio_events e WHERE e.id = 'fev_c_' || f.id);

-- payment ← one per money-movement row already in the ledger. `kind` is unknowable
-- retroactively and is omitted (spec § Backfill mapping).
INSERT INTO folio_events (id, organization_id, folio_id, event_type, actor_id, operator_id, payload, backfilled, created_at)
SELECT 'fev_p_' || p.id, p.organization_id, p.folio_id, 'payment', p.collected_by, p.operator_id,
       json_object('amount', p.amount, 'method', p.method),
       1, p.created_at
FROM folio_payments p
WHERE p.entry_type = 'payment'
  AND NOT EXISTS (SELECT 1 FROM folio_events e WHERE e.id = 'fev_p_' || p.id);

-- payment_verified ← the re-armable clearance axis; only the latest verification survives.
INSERT INTO folio_events (id, organization_id, folio_id, event_type, actor_id, payload, backfilled, created_at)
SELECT 'fev_v_' || f.id, f.organization_id, f.id, 'payment_verified', f.payment_verified_by,
       json_object('reference', f.payment_reference),
       1, f.payment_verified_at
FROM folios f
WHERE f.payment_verified_at IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM folio_events e WHERE e.id = 'fev_v_' || f.id);

-- tickets_sent ← last-write-wins column; only the final send survives (spec § Backfill mapping).
INSERT INTO folio_events (id, organization_id, folio_id, event_type, actor_id, payload, backfilled, created_at)
SELECT 'fev_ts_' || f.id, f.organization_id, f.id, 'tickets_sent', f.tickets_sent_by, NULL, 1, f.tickets_sent_at
FROM folios f
WHERE f.tickets_sent_at IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM folio_events e WHERE e.id = 'fev_ts_' || f.id);

-- tickets_viewed ← the bot-proof first-view beacon; the actor is the tourist (NULL).
INSERT INTO folio_events (id, organization_id, folio_id, event_type, actor_id, payload, backfilled, created_at)
SELECT 'fev_tv_' || f.id, f.organization_id, f.id, 'tickets_viewed', NULL, NULL, 1, f.tickets_viewed_at
FROM folios f
WHERE f.tickets_viewed_at IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM folio_events e WHERE e.id = 'fev_tv_' || f.id);

-- reminder_sent ← the WhatsApp recovery claim (US-AG07.3).
INSERT INTO folio_events (id, organization_id, folio_id, event_type, actor_id, payload, backfilled, created_at)
SELECT 'fev_r_' || f.id, f.organization_id, f.id, 'reminder_sent', f.reminder_sent_by, NULL, 1, f.reminder_sent_at
FROM folios f
WHERE f.reminder_sent_at IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM folio_events e WHERE e.id = 'fev_r_' || f.id);

-- cancelled ← the audit columns; actor NULL for a system_expiry sweep renders "Sistema".
INSERT INTO folio_events (id, organization_id, folio_id, event_type, actor_id, payload, backfilled, created_at)
SELECT 'fev_x_' || f.id, f.organization_id, f.id, 'cancelled', f.cancelled_by,
       json_object('source', f.cancellation_source, 'reason', f.cancellation_reason,
                   'clawback', f.cancellation_clawback, 'refund_amount', f.refund_amount),
       1, f.cancelled_at
FROM folios f
WHERE f.cancelled_at IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM folio_events e WHERE e.id = 'fev_x_' || f.id);

-- rescheduled ← D13's per-line record (folio_requests, kind 'reschedule', approved). The slot
-- joins recover the human-readable departures; `origin` is unknowable retroactively (a counter
-- move is written already-approved, indistinguishable from an approved petition) and is omitted.
INSERT INTO folio_events (id, organization_id, folio_id, event_type, actor_id, payload, backfilled, created_at)
SELECT 'fev_rs_' || r.id, r.organization_id, r.folio_id, 'rescheduled', r.resolved_by,
       json_object('from_date', fs.date, 'from_time', fs.start_time,
                   'to_date', ts.date, 'to_time', ts.start_time),
       1, r.resolved_at
FROM folio_requests r
LEFT JOIN slots fs ON fs.id = r.from_slot_id
LEFT JOIN slots ts ON ts.id = r.to_slot_id
WHERE r.kind = 'reschedule' AND r.status = 'approved' AND r.resolved_at IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM folio_events e WHERE e.id = 'fev_rs_' || r.id);

-- refund_confirmed ← the hand-back; a note means the lost-link override, no note means the PIN.
INSERT INTO folio_events (id, organization_id, folio_id, event_type, actor_id, payload, backfilled, created_at)
SELECT 'fev_rf_' || f.id, f.organization_id, f.id, 'refund_confirmed', f.refunded_by,
       json_object('amount', f.refund_amount,
                   'via', CASE WHEN f.refund_note IS NULL THEN 'pin' ELSE 'override' END),
       1, f.refunded_at
FROM folios f
WHERE f.refunded_at IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM folio_events e WHERE e.id = 'fev_rf_' || f.id);
