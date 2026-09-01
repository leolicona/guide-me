-- BUG-042 (docs/BUGS.md). Every folio roll-up derives from its lines since 0065 (TECH_DEBT #25):
-- status, hold clock, refund obligation, per-line money — each a correlated subquery of the form
--
--   … from folio_lines fl where fl.folio_id = folios.id
--   … from folio_payment_allocations a where a.folio_line_id = fl.id
--
-- The indexes both tables carried were `(organization_id, folio_id)` and
-- `(organization_id, folio_line_id)`. SQLite cannot enter a composite index unless its LEADING
-- column is constrained, and these correlations name only the child key — so every one of them
-- was a full table scan, nested, once per folio of the listing. In production the folio list read
-- ~930,000 rows per request at an efficiency of 0.0003 and exhausted the D1 rows-read quota.
--
-- Two single-column indexes on the correlated keys. No query changes: 35 correlations across 11
-- files pick these up as-is, and the `ON DELETE CASCADE` from folio_lines to allocations stops
-- scanning too. The org-leading indexes stay — they serve the org-scoped joins and rule 6 of
-- ARCHITECTURE.md § Multitenancy.
--
-- Additive, idempotent, no backfill: an index carries no facts.
CREATE INDEX IF NOT EXISTS folio_lines_folio_idx
  ON folio_lines (folio_id);

CREATE INDEX IF NOT EXISTS folio_payment_allocations_line_only_idx
  ON folio_payment_allocations (folio_line_id);
