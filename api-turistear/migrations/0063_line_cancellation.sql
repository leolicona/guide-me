-- US-A22 (docs/folios/line-autonomy.spec.md, F2 — D1's written half, D6, D9, D13). The line gains
-- its cancellation (an ACTION, written — unlike pagada/apartada, which stay derived from
-- allocations) and its own refund debt; the narrative and the outbox learn to name the line.
--
-- RE-RUNNABLE BY DESIGN (the 0062 pattern): guarded UPDATEs (`cancelled_at IS NULL`,
-- `refund_amount IS NULL`), IF-NOT-EXISTS-style index swap, timestamps copied from SOURCE columns.
-- The allocations-backfill test replays the backfill statements verbatim.

-- D1 (written half) + D6 — line-level cancellation + refund debt.
ALTER TABLE folio_lines ADD COLUMN cancelled_at INTEGER;
ALTER TABLE folio_lines ADD COLUMN cancelled_by TEXT REFERENCES users(id);
ALTER TABLE folio_lines ADD COLUMN cancellation_source TEXT; -- same enum as folios.cancellation_source
ALTER TABLE folio_lines ADD COLUMN refund_status TEXT NOT NULL DEFAULT 'none'; -- 'none'|'pending'|'refunded'
ALTER TABLE folio_lines ADD COLUMN refund_amount INTEGER;

-- D9 — accrual (commission/commission_reversal) and single-line reversal rows point at their line.
-- ON DELETE SET NULL, not CASCADE: a ledger row, an event and an outbox row are meaningful
-- WITHOUT their line (the money moved, the action happened) — they survive a line delete and
-- only lose the label. Nothing in production deletes lines; this is for the test suites'
-- cleanup deletes, which the scope boundary forbids editing.
ALTER TABLE folio_payments ADD COLUMN folio_line_id TEXT REFERENCES folio_lines(id) ON DELETE SET NULL;

-- D13 — the narrative and the outbox name the line. NULL = folio-scoped (created, tickets_sent…).
ALTER TABLE folio_events ADD COLUMN folio_line_id TEXT REFERENCES folio_lines(id) ON DELETE SET NULL;
-- The outbox CASCADES instead: nulling two line-scoped rows of the same (folio, event, channel)
-- would collide inside the COALESCE unique guard below — and a guard row without its line can no
-- longer guard anything.
ALTER TABLE notifications ADD COLUMN folio_line_id TEXT REFERENCES folio_lines(id) ON DELETE CASCADE;

-- D13 — the re-send guard gains the line. The COALESCE is load-bearing: SQLite treats NULLs as
-- DISTINCT in unique indexes, so a plain composite index would let folio-scoped rows duplicate —
-- and without the line in the key at all, cancelling line B months after line A would collide
-- with A's guard and the customer would silently never be told.
DROP INDEX IF EXISTS uq_notifications_folio_event_channel;
CREATE UNIQUE INDEX IF NOT EXISTS uq_notifications_folio_line_event_channel
  ON notifications (folio_id, COALESCE(folio_line_id, ''), event, channel);

-- ---------------------------------------------------------------------------------------------
-- D10 backfill — lines of already-cancelled folios arrive cancelled.
--
-- The stamps are EXACT, not reconstruction: every pre-feature cancellation was total, so the
-- folio's own snapshotted cancelled_at/by/source apply to all of its lines verbatim.
-- ---------------------------------------------------------------------------------------------
UPDATE folio_lines SET
  cancelled_at = (SELECT f.cancelled_at FROM folios f WHERE f.id = folio_lines.folio_id),
  cancelled_by = (SELECT f.cancelled_by FROM folios f WHERE f.id = folio_lines.folio_id),
  cancellation_source = (SELECT f.cancellation_source FROM folios f WHERE f.id = folio_lines.folio_id)
WHERE cancelled_at IS NULL
  AND EXISTS (SELECT 1 FROM folios f WHERE f.id = folio_lines.folio_id AND f.status = 'cancelled');

-- The refund debt's split IS reconstruction, declared: the folio's single refund_amount is
-- distributed pro-rata to the money each line actually received (its POSITIVE allocations from
-- 0062 — never the net, which already subtracts the reversal), floors + remainder to the
-- heaviest line — the same rule the live reversal and 0062's block 3 use. refund_status copies
-- the folio's own value onto the lines that carry a share.
WITH w AS (
  SELECT fl.id AS line_id, fl.folio_id,
         COALESCE(fl.slot_date, fl.check_in, '9999-12-31') || 'T' || COALESCE(fl.slot_start_time, '00:00') AS ord_key,
         MAX(0, COALESCE((SELECT SUM(a.amount) FROM folio_payment_allocations a
                          WHERE a.folio_line_id = fl.id AND a.amount > 0), 0)) AS weight,
         f.refund_amount AS refund_total,
         f.refund_status AS folio_refund_status
  FROM folio_lines fl
  JOIN folios f ON f.id = fl.folio_id
  WHERE f.status = 'cancelled' AND COALESCE(f.refund_amount, 0) > 0
),
t AS (
  SELECT folio_id, SUM(weight) AS w_total FROM w GROUP BY folio_id
),
s AS (
  SELECT w.line_id, w.folio_id, w.refund_total, w.folio_refund_status,
         (w.weight * w.refund_total) / t.w_total AS floor_share,
         ROW_NUMBER() OVER (
           PARTITION BY w.folio_id ORDER BY w.weight DESC, w.ord_key, w.line_id
         ) AS heavy_rank
  FROM w
  JOIN t ON t.folio_id = w.folio_id AND t.w_total > 0
  WHERE w.weight > 0
),
ftot AS (
  SELECT folio_id, SUM(floor_share) AS floored FROM s GROUP BY folio_id
)
UPDATE folio_lines SET
  refund_amount = fixed.share,
  refund_status = fixed.folio_refund_status
FROM (
  SELECT s.line_id, s.folio_refund_status,
         s.floor_share + CASE WHEN s.heavy_rank = 1 THEN s.refund_total - ftot.floored ELSE 0 END AS share
  FROM s
  JOIN ftot ON ftot.folio_id = s.folio_id
) AS fixed
WHERE folio_lines.id = fixed.line_id
  AND fixed.share > 0
  AND folio_lines.refund_amount IS NULL;
