-- US-LG04/LG05/LG06 (docs/paid-ledger/spec.md) — Step 4: make the folio_payments ledger the cash
-- engine's source of truth. This migration brings HISTORICAL rows up to the shape the ledger-based
-- engine reads, so the cutover reproduces today's numbers exactly. Additive/idempotent.

-- 1. Commission rows must carry the METHOD of the collection they accrue on, so the engine can
--    bucket commission cash-vs-electronic (US-AG29). The Step-1 backfill left them null; adopt the
--    folio's payment method (every pre-Step-3 folio is single-method).
UPDATE folio_payments
SET method = (SELECT f.payment_method FROM folios f WHERE f.id = folio_payments.folio_id)
WHERE entry_type = 'commission' AND method IS NULL;

-- 2. A cancelled folio must NET OUT of the ledger's sales/cash buckets (and, on clawback, its
--    commission) — exactly as the old status-exclusion did. Going forward every cancellation writes
--    these reversal rows; here we backfill them for folios cancelled BEFORE this step. Dated at
--    cancelled_at so the drop-watermark fast path treats a post-watermark cancellation as a
--    current-shift event (this is what lets the §12a hack be deleted in the handler). Idempotent via
--    deterministic ids + NOT EXISTS.

-- 2a. Reverse the collected money (all cancelled folios, regardless of clawback).
INSERT INTO folio_payments (
  id, organization_id, folio_id, entry_type, amount, method, verification, collected_by, created_at
)
SELECT
  'refx_' || f.id,
  f.organization_id,
  f.id,
  'refund',
  -f.amount_paid,
  f.payment_method,
  'not_required',
  f.agent_id,
  COALESCE(f.cancelled_at, f.updated_at, f.created_at)
FROM folios f
WHERE f.status = 'cancelled'
  AND f.amount_paid > 0
  AND NOT EXISTS (SELECT 1 FROM folio_payments p WHERE p.id = 'refx_' || f.id);

-- 2b. Reverse the commission ONLY for a clawed-back cancellation (an absorbed one keeps it).
INSERT INTO folio_payments (
  id, organization_id, folio_id, entry_type, amount, method, verification, collected_by, created_at
)
SELECT
  'crev_' || f.id,
  f.organization_id,
  f.id,
  'commission_reversal',
  -f.commission_amount,
  f.payment_method,
  'not_required',
  f.agent_id,
  COALESCE(f.cancelled_at, f.updated_at, f.created_at)
FROM folios f
WHERE f.status = 'cancelled'
  AND f.cancellation_clawback = 1
  AND f.commission_amount > 0
  AND NOT EXISTS (SELECT 1 FROM folio_payments p WHERE p.id = 'crev_' || f.id);
