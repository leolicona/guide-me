-- US-AG07.1 fix — the booking hold's pre-departure buffer becomes a configurable org setting (was a
-- hardcoded 24h). More importantly the buffer is now applied by TIME-DISTANCE, not calendar date: a
-- slot that is calendar-tomorrow but LESS than the buffer away used to be treated as "not same-day"
-- and got the full 24h buffer, so its expiry landed in the PAST and confirmSale minted a
-- born-expired booking. With this setting the buffer both (a) sets the settle-by deadline for a
-- distant booking and (b) is the threshold below which the tighter same-day grace window applies.
-- Default 24 (hours) preserves the prior behaviour for slots ≥ 24h out.
ALTER TABLE organizations
  ADD COLUMN booking_pre_departure_buffer_hours INTEGER NOT NULL DEFAULT 24;
