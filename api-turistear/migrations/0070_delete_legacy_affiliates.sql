-- delete-legacy-affiliates — specs/003-delete-legacy-affiliates/plan.md.
--
-- Deletes every user still stored with the retired role `affiliate` (one in prod, one in dev) and
-- everything tied to them: their sales with every child row, their cash drops, payouts, expenses
-- and reset tokens. The developer chose this knowing it removes those sales from history and
-- reports (spec, Assumptions).
--
-- D1 — keyed by the role, not by ids: the same file serves prod, dev and every fresh test
-- database, where it changes nothing. `users` goes last, so the selection holds throughout.
-- D4 — rows are reached only through the affiliates' own sales or their own seller column. A row
-- of anyone else that names an affiliate keeps the user's foreign key alive: the final DELETE
-- fails and the whole file rolls back, rather than delete another seller's record.

-- D2 — hand the seats back first, as `applyCancellation` does. A live line is one where neither
-- the line nor its sale is cancelled: a cancelled one gave its seats back when it was cancelled.
-- A plain departure line releases on the departure, clamped at zero.
UPDATE slots
SET booked = MAX(0, booked - (
      SELECT SUM(l.quantity)
      FROM folio_lines l JOIN folios f ON f.id = l.folio_id
      WHERE l.slot_id = slots.id
        AND l.zone_id IS NULL
        AND l.cancelled_at IS NULL
        AND f.cancelled_at IS NULL
        AND f.agent_id IN (SELECT id FROM users WHERE role = 'affiliate'))),
    updated_at = unixepoch()
WHERE id IN (
  SELECT l.slot_id
  FROM folio_lines l JOIN folios f ON f.id = l.folio_id
  WHERE l.zone_id IS NULL
    AND l.cancelled_at IS NULL
    AND f.cancelled_at IS NULL
    AND f.agent_id IN (SELECT id FROM users WHERE role = 'affiliate'));

-- D2 — a zoned line releases on its zone, the authoritative counter (US-A64)…
UPDATE slot_zones
SET booked = MAX(0, booked - (
      SELECT SUM(l.quantity)
      FROM folio_lines l JOIN folios f ON f.id = l.folio_id
      WHERE l.slot_id = slot_zones.slot_id
        AND l.zone_id = slot_zones.zone_id
        AND l.cancelled_at IS NULL
        AND f.cancelled_at IS NULL
        AND f.agent_id IN (SELECT id FROM users WHERE role = 'affiliate'))),
    updated_at = unixepoch()
WHERE EXISTS (
  SELECT 1
  FROM folio_lines l JOIN folios f ON f.id = l.folio_id
  WHERE l.slot_id = slot_zones.slot_id
    AND l.zone_id = slot_zones.zone_id
    AND l.cancelled_at IS NULL
    AND f.cancelled_at IS NULL
    AND f.agent_id IN (SELECT id FROM users WHERE role = 'affiliate'));

-- …then its departure's totals are re-derived from the active zones (`reconcileSlotTotals`).
-- A lodging stay is released by deleting its reservation below.
UPDATE slots
SET booked = (SELECT COALESCE(SUM(sz.booked), 0) FROM slot_zones sz
              WHERE sz.slot_id = slots.id AND sz.status = 'active'),
    capacity = (SELECT COALESCE(SUM(sz.capacity), 0) FROM slot_zones sz
                WHERE sz.slot_id = slots.id AND sz.status = 'active'),
    updated_at = unixepoch()
WHERE id IN (
  SELECT l.slot_id
  FROM folio_lines l JOIN folios f ON f.id = l.folio_id
  WHERE l.zone_id IS NOT NULL
    AND l.cancelled_at IS NULL
    AND f.cancelled_at IS NULL
    AND f.agent_id IN (SELECT id FROM users WHERE role = 'affiliate'));

-- D3 — their sales, children before parents, each one named.
DELETE FROM folio_payment_allocations
WHERE payment_id IN (
        SELECT id FROM folio_payments WHERE folio_id IN (
          SELECT id FROM folios WHERE agent_id IN (SELECT id FROM users WHERE role = 'affiliate')))
   OR folio_line_id IN (
        SELECT id FROM folio_lines WHERE folio_id IN (
          SELECT id FROM folios WHERE agent_id IN (SELECT id FROM users WHERE role = 'affiliate')));

DELETE FROM folio_payments WHERE folio_id IN (
  SELECT id FROM folios WHERE agent_id IN (SELECT id FROM users WHERE role = 'affiliate'));

DELETE FROM folio_events WHERE folio_id IN (
  SELECT id FROM folios WHERE agent_id IN (SELECT id FROM users WHERE role = 'affiliate'));

DELETE FROM notifications WHERE folio_id IN (
  SELECT id FROM folios WHERE agent_id IN (SELECT id FROM users WHERE role = 'affiliate'));

DELETE FROM folio_requests WHERE folio_id IN (
  SELECT id FROM folios WHERE agent_id IN (SELECT id FROM users WHERE role = 'affiliate'));

DELETE FROM folio_access_tokens WHERE folio_id IN (
  SELECT id FROM folios WHERE agent_id IN (SELECT id FROM users WHERE role = 'affiliate'));

DELETE FROM accommodation_reservations WHERE folio_id IN (
  SELECT id FROM folios WHERE agent_id IN (SELECT id FROM users WHERE role = 'affiliate'));

DELETE FROM folio_line_extras WHERE folio_id IN (
  SELECT id FROM folios WHERE agent_id IN (SELECT id FROM users WHERE role = 'affiliate'));

DELETE FROM folio_lines WHERE folio_id IN (
  SELECT id FROM folios WHERE agent_id IN (SELECT id FROM users WHERE role = 'affiliate'));

DELETE FROM folios WHERE agent_id IN (SELECT id FROM users WHERE role = 'affiliate');

-- D3 — their own cash records and reset tokens.
DELETE FROM cash_drops WHERE agent_id IN (SELECT id FROM users WHERE role = 'affiliate');

DELETE FROM payouts WHERE agent_id IN (SELECT id FROM users WHERE role = 'affiliate');

DELETE FROM agent_expenses WHERE agent_id IN (SELECT id FROM users WHERE role = 'affiliate');

DELETE FROM password_reset_tokens WHERE user_id IN (SELECT id FROM users WHERE role = 'affiliate');

-- D1, D4 — the users, last.
DELETE FROM users WHERE role = 'affiliate';
