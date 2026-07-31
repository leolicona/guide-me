-- Cancellation Policy Engine — the apartado unification (spec D20 + D18 revised).
--
-- Two changes, both data-only.
--
-- 1. THE INHERITED LADDER IS NO LONGER "REFUND EVERYTHING, ALWAYS".
--
--    0054 gave every org a single terminal tier at 100%. That was defensible while the engine only
--    priced fully-paid folios — sales an admin was already refunding by hand anyway. It stops being
--    defensible now that the engine also prices apartados (D20): an unconfigured org would hand back
--    every deposit on every cancellation, including to a customer who simply never showed up, and
--    the agent would forfeit their commission doing it. That is not a conservative default; it is a
--    trap that happens to look generous.
--
--    The new inherited ladder is the one the spec has always used as its worked example:
--      ≥120h out → refund 100%, agent keeps no commission
--      ≥24h out  → refund 50%,  agent keeps its commission (capped by what was retained)
--      departed  → refund 0%,   agent keeps its commission
--
--    ONLY orgs still carrying the 0054 default are rewritten. The test is semantic, not textual —
--    "exactly one tier, terminal, at 100%" — so it holds whether the document was written by 0054's
--    json_object() or by the API's JSON.stringify() at organization creation. An org that
--    deliberately configured that same single tier is indistinguishable from the default (it is the
--    same document) and is rewritten too; there is no way to tell those apart, and no meaning in
--    trying.
--
-- 2. `booking_deposit_retained_pct` IS REMOVED FROM THE DOCUMENT.
--
--    It was a floor that pinned an apartado's refund to 0 regardless of the ladder. D20 deletes the
--    concept rather than defaulting it to 0, so no configuration can re-introduce the contradiction
--    of a ladder that says 100% and a deposit clause that says 0.
--
--    Stripping it here is housekeeping, not a behaviour change: the Zod schema is a non-strict
--    object, so a document that still carries the key already parses with the value ignored. This
--    just stops the stored data from disagreeing with the schema when someone inspects it.
--
-- FOLIO SNAPSHOTS ARE DELIBERATELY NOT TOUCHED. D6 — a folio is priced by the ladder in force when
-- it was sold, and rewriting a snapshot would retroactively change the terms of a completed sale.
-- Snapshots that still carry the deposit key simply stop honouring it, which does change how such a
-- folio prices; that is accepted because the engine has never reached production, so no real folio
-- was ever sold under the floor.
--
-- Idempotent: re-running matches nothing the second time.

-- 1 — the inherited ladder. The NULL branch is belt-and-braces (D17: "no policy" must be
-- unreachable); 0054 already cleared it, and organization creation writes one.
UPDATE organizations
SET cancellation_policy = json_object(
      'version', 1,
      'tiers', json_array(
        json_object('min_hours', 120, 'refund_pct', 100, 'agent_commission_pct', 0),
        json_object('min_hours', 24, 'refund_pct', 50, 'agent_commission_pct', 100),
        json_object('min_hours', NULL, 'refund_pct', 0, 'agent_commission_pct', 100)
      )
    ),
    updated_at = unixepoch()
WHERE cancellation_policy IS NULL
   OR (
     json_array_length(cancellation_policy, '$.tiers') = 1
     AND json_extract(cancellation_policy, '$.tiers[0].min_hours') IS NULL
     AND json_extract(cancellation_policy, '$.tiers[0].refund_pct') = 100
   );

-- 2 — drop the retired key from every org that configured its own ladder (step 1 already wrote
-- documents without it).
UPDATE organizations
SET cancellation_policy = json_remove(cancellation_policy, '$.booking_deposit_retained_pct'),
    updated_at = unixepoch()
WHERE cancellation_policy IS NOT NULL
  AND json_extract(cancellation_policy, '$.booking_deposit_retained_pct') IS NOT NULL;
