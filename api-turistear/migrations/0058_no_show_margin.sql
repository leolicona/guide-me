-- US-A85 — the no-show margin gets a number of its own
-- (docs/folios/folio-state-machine.spec.md, D23; withdraws D6 and D22).
--
-- Signed exactly like its two neighbours in /settings — `sales_cutoff_offset_minutes` and
-- `booking_grace_offset_minutes`:  + = minutes BEFORE departure, − = minutes AFTER.
-- `0` (the default) means the departure instant, so nothing changes for anyone on the day this
-- lands: a line whose departure has passed with nothing redeemed simply becomes readable as a
-- no-show, which is a reading, never a write.
--
-- Why a column of its own rather than reusing one that already exists:
--
--   `booking_grace_offset_minutes` drives TWO clocks already — it fixes `booking_expires_at` for a
--   near-departure sale, and it is where stage ② ends and the auto-cancellation fires. An org
--   setting it to −30 to mean "half an hour past departure counts as a no-show" would move every
--   apartado's release with it.
--
--   `sales_cutoff_offset_minutes` gates the sale itself.
--
-- One number cannot serve two intents — the same conclusion `apartado-stages.spec.md` S1 reached
-- when it refused to reuse the sales cutoff for the apartado creation cutoff.
--
-- The endpoint enforces coherence with the sales cutoff: the margin may not mark a customer absent
-- while their seat is still sellable (`NO_SHOW_MARGIN_TOO_EARLY`).
--
-- Additive column with a default: no ordering hazard with the deployed worker.

ALTER TABLE organizations
  ADD COLUMN no_show_margin_minutes INTEGER NOT NULL DEFAULT 0;
