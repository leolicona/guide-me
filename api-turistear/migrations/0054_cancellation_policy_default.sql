-- Cancellation Policy Engine, Phase 2 (docs/cancellation/cancellation-policy-engine.spec.md — D17/D18).
--
-- Phase 1 gated the engine on `cancellation_policy IS NULL`: an org without a policy ran the
-- pre-feature code. That gate is what let a change to money handling ship safely — and it is also
-- what kept the original defect alive, because an org without a policy still got two different
-- answers depending on WHO cancelled (admin path: no refund recorded; tourist-approval path: a
-- full refund of the same folio).
--
-- This migration gives every organization an explicit ladder, so "no policy" stops being a
-- reachable state and the legacy pricing branches can be deleted outright (same PR).
--
-- The inherited default refunds EVERYTHING, always — one terminal tier. Rationale (D18):
--   * It is the reading a customer would assume of unstated terms.
--   * It never refunds LESS than the most generous path that existed before, so nobody is
--     shortchanged on the day this lands.
--   * It is visible: the admin opens Settings and reads a real ladder they can edit, instead of
--     inheriting behaviour buried in a handler.
--
-- Orgs that had lodging cancel settings (`lodging_free_cancel_days` / `lodging_cancel_penalty_pct`)
-- get this SAME default. Those fields are deliberately NOT translated into a ladder: a ladder is
-- org-wide, so a stay policy would immediately start governing that org's TOURS too — terms nobody
-- chose, applied to services they were never written for. Those orgs are shown a banner in
-- Settings asking them to configure a ladder; until they do, their stays refund in full.
--
-- Data-only UPDATE: no schema change, no column drop, so there is no ordering hazard with the
-- deployed worker (unlike 0051). Idempotent — the WHERE clause makes a re-run a no-op.

UPDATE organizations
SET cancellation_policy = json_object(
      'version', 1,
      'tiers', json_array(
        json_object(
          'min_hours', NULL,
          'refund_pct', 100,
          'agent_commission_pct', 0
        )
      ),
      'booking_deposit_retained_pct', 100
    ),
    updated_at = unixepoch()
WHERE cancellation_policy IS NULL;
