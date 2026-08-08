-- US-A88 — may a transfer be recorded WITHOUT its bank reference?
-- (docs/payment-verification/payment-verification.spec.md, D10 — amends D2.)
--
-- Some orgs verify against the bank statement by amount + time and find typing a reference at the
-- point of sale pure friction; others depend on it to match the money. So the requirement becomes
-- an org choice. Default 1 (required) — today's rule — so no existing org changes behaviour on the
-- day this lands.
--
-- The toggle relaxes the INPUT only: an unreferenced transfer still enters `payment_verification =
-- 'pending'` with its QR deferred. The verification axis (US-A67) is deliberately untouched.
--
-- Additive column with a default: no ordering hazard with the deployed worker.

ALTER TABLE organizations
  ADD COLUMN payment_reference_required INTEGER NOT NULL DEFAULT 1;
