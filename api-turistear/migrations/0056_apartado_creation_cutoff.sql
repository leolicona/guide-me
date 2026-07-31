-- US-A77 — a creation cutoff of its own for apartados
-- (docs/bookings/apartado-stages.spec.md, S1).
--
-- `sales_cutoff_offset_minutes` gates EVERY new folio with one number, and its default of 0 —
-- sellable until the moment of departure — is right for a walk-in paying cash. It is wrong for an
-- apartado: nothing stops an agent opening one twenty minutes before departure, which then expires
-- fifteen minutes before it, so the apartado lives for five minutes. One number cannot serve a sale
-- that is already complete and a sale that is a promise to come back.
--
-- Hours before the earliest departure in the cart. `0` (the default) means NO restriction, which is
-- exactly today's behaviour — nobody's booth changes on the day this lands. An org that sets one
-- must set it coherently: the endpoint enforces `cutoff >= booking_pre_departure_buffer_hours`, so
-- an apartado can never be created inside the window it is expected to be settled in.
--
-- Additive column with a default: no ordering hazard with the deployed worker.

ALTER TABLE organizations
  ADD COLUMN booking_creation_cutoff_hours INTEGER NOT NULL DEFAULT 0;
