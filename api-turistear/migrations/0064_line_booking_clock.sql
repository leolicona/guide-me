-- US-AG54 (docs/folios/line-autonomy.spec.md, F3 — D5). Each apartada line runs against ITS
-- departure: the same resolver (bookingExpiryEpoch), the same policy inputs, evaluated per line
-- instead of against the folio's earliest slot. The folio's own column survives as MIN(line
-- clocks) while it lives (D11's honesty rule), so every existing reader — the settle guard, the
-- reminder urgency, the overdue facet — stays truthful.
ALTER TABLE folio_lines ADD COLUMN booking_expires_at INTEGER;

-- D10 backfill — existing apartada lines COPY the folio's snapshotted expiry, never recalculated:
-- a per-line recalculation could EXTEND a hold already communicated to the customer, silently
-- rewriting a promise (S-17). New bookings mint per-line clocks at confirm; old ones keep the one
-- they were told. Idempotent via the IS NULL guard.
UPDATE folio_lines SET booking_expires_at =
  (SELECT f.booking_expires_at FROM folios f WHERE f.id = folio_lines.folio_id)
WHERE booking_expires_at IS NULL
  AND cancelled_at IS NULL
  AND EXISTS (
    SELECT 1 FROM folios f
    WHERE f.id = folio_lines.folio_id
      AND f.status = 'booking'
      AND f.booking_expires_at IS NOT NULL
  );
