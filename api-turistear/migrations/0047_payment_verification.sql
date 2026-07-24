-- US-AG41 / US-A67 (docs/payment-verification/spec.md) — record an electronic payment's bank
-- reference, and gate ticket (QR) release behind an admin verification of that money.
--
-- payment_reference: the transfer's bank reference (free text; null for cash). If a folio takes two
--   transfer payments (deposit + settle) this holds the most recent one awaiting verification.
-- payment_verification: RE-ARMABLE axis — 'not_required' (all-cash) · 'pending' (a transfer payment
--   awaits an admin) · 'verified'. QR signs only when the folio is `paid` AND this is NOT 'pending'.
ALTER TABLE folios ADD COLUMN payment_reference TEXT;
ALTER TABLE folios ADD COLUMN payment_verification TEXT NOT NULL DEFAULT 'not_required';
ALTER TABLE folios ADD COLUMN payment_verified_at INTEGER;
ALTER TABLE folios ADD COLUMN payment_verified_by TEXT REFERENCES users(id);

-- Grandfather (D9): every existing electronic folio already has QR out in the world → 'verified';
-- cash folios → 'not_required' (already the default, set explicitly for clarity).
UPDATE folios SET payment_verification = 'verified' WHERE payment_method != 'cash';
UPDATE folios SET payment_verification = 'not_required' WHERE payment_method = 'cash';
