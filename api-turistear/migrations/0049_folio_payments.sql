-- US-LG01 (docs/paid-ledger/spec.md) — per-payment money-movement ledger. One SIGNED row per
-- movement on a folio (payment/refund/commission/commission_reversal). ADDITIVE: a new table + a
-- one-time backfill; no existing column is touched. Nothing reads this table yet — Step 1 is a
-- verified shadow of the folio money scalars. Later steps make it the cash engine's source of truth.

CREATE TABLE folio_payments (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  folio_id TEXT NOT NULL REFERENCES folios(id),
  -- Money movements (payment/refund) carry a `method`; accruals (commission/commission_reversal)
  -- do not. `amount` is SIGNED: payment/commission > 0, refund/commission_reversal < 0.
  entry_type TEXT NOT NULL,                          -- 'payment'|'refund'|'commission'|'commission_reversal'
  amount INTEGER NOT NULL,                           -- signed minor units
  method TEXT,                                       -- 'cash'|'card'|'transfer'|'link'; null for commission rows
  reference TEXT,                                    -- bank ref; only a transfer payment sets it
  verification TEXT NOT NULL DEFAULT 'not_required', -- 'not_required'|'pending'|'verified' (per row)
  collected_by TEXT NOT NULL REFERENCES users(id),   -- who took THIS money (a settle may differ from the seller)
  operator_id TEXT REFERENCES affiliate_operators(id), -- the PIN shift that took it (US-A68); null in-house
  verified_at INTEGER,
  verified_by TEXT REFERENCES users(id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())  -- the money's OWN date (deposit/settle/refund/cancel)
);

CREATE INDEX folio_payments_folio_idx
  ON folio_payments (organization_id, folio_id);

-- The per-shift sums (cash_collected / by-method) scan by collector + date.
CREATE INDEX folio_payments_shift_idx
  ON folio_payments (organization_id, collected_by, created_at);

-- The admin "Por verificar" queue only ever wants unverified electronic rows.
CREATE INDEX folio_payments_pending_idx
  ON folio_payments (organization_id, verification) WHERE verification = 'pending';

-- Backfill (D11) — one synthetic `payment` row per folio from its current scalars, plus one
-- `commission` row per folio with commission_amount > 0. Totals are preserved EXACTLY:
--   Σ(payment rows).amount    = folios.amount_paid        (one row, no refunds yet)
--   Σ(commission rows).amount = folios.commission_amount  (one row, no reversals yet)
-- Pre-migration settled bookings already lost their deposit/balance split, so they get a single
-- row — no fabricated history. IDEMPOTENT: deterministic ids ('pmt_'/'cmn_' + folio id) + the
-- NOT EXISTS guard make a re-run a no-op (belt-and-suspenders; wrangler runs a migration once).
INSERT INTO folio_payments (
  id, organization_id, folio_id, entry_type, amount, method, reference, verification,
  collected_by, operator_id, verified_at, verified_by, created_at
)
SELECT
  'pmt_' || f.id,
  f.organization_id,
  f.id,
  'payment',
  f.amount_paid,
  f.payment_method,
  f.payment_reference,
  f.payment_verification,
  f.agent_id,
  f.operator_id,
  f.payment_verified_at,
  f.payment_verified_by,
  f.created_at
FROM folios f
WHERE NOT EXISTS (SELECT 1 FROM folio_payments p WHERE p.id = 'pmt_' || f.id);

INSERT INTO folio_payments (
  id, organization_id, folio_id, entry_type, amount, method, verification, collected_by, created_at
)
SELECT
  'cmn_' || f.id,
  f.organization_id,
  f.id,
  'commission',
  f.commission_amount,
  NULL,
  'not_required',
  f.agent_id,
  f.created_at
FROM folios f
WHERE f.commission_amount > 0
  AND NOT EXISTS (SELECT 1 FROM folio_payments p WHERE p.id = 'cmn_' || f.id);
