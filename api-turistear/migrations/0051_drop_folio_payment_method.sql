-- US-LG08 (docs/paid-ledger/spec.md, D10a) — physical cleanup: the folio no longer has a single
-- payment method. Every reader was moved onto the folio_payments ledger in steps 4–5 (money reads)
-- and derives the display method (shared method, or 'Mixto') via a correlated subquery; nothing
-- writes or reads folios.payment_method anymore. Drop the now-vestigial column.
ALTER TABLE folios DROP COLUMN payment_method;
