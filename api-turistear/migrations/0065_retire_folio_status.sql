-- US-A89 (docs/folios/line-autonomy.spec.md, D11 — completed by TECH_DEBT #25). The physical
-- drop the epic deferred at close: every reader and writer now lives on the lines
-- (folio_payment_allocations + the line's cancellation/refund/clock columns), so the folio's
-- roll-up columns retire. What stays on the folio is what is folio-scoped by design (D12):
-- identity/contact, the portal token, the ONE refund PIN + its audit trail
-- (refund_pin/attempts/note/refunded_at/refunded_by), the credit aggregate, delivery, reminders.
ALTER TABLE folios DROP COLUMN status;
ALTER TABLE folios DROP COLUMN booking_expires_at;
ALTER TABLE folios DROP COLUMN refund_status;
ALTER TABLE folios DROP COLUMN refund_amount;
