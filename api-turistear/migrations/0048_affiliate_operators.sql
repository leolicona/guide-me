-- US-AF10–AF13 / US-OP01–OP02 / US-A68 — Temporary PIN access for affiliate operators.
-- docs/affiliate-operators/spec.md. Operators are shift cashiers under ONE affiliate (manager)
-- account — NOT users. Additive: a new table + a nullable attribution column on folios.

CREATE TABLE affiliate_operators (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  affiliate_company_id TEXT NOT NULL REFERENCES affiliate_companies(id),
  -- The affiliate user who owns this operator; its sales attribute to this manager's caja
  -- (folios.agent_id) and it resolves the operator session's borrowed identity (D5).
  manager_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  pin_hash TEXT,                                   -- null until first-run PIN setup (US-OP01)
  pin_salt TEXT,
  pin_attempts INTEGER NOT NULL DEFAULT 0,         -- >= 5 => locked until a manager resets (D10)
  access_token TEXT NOT NULL UNIQUE,               -- the saved link's secret; rotated on remove/reset
  status TEXT NOT NULL DEFAULT 'active',           -- 'active' | 'removed' (soft — D9)
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Phone is unique among a company's ACTIVE operators (D7); a removed operator's phone is reusable.
CREATE UNIQUE INDEX affiliate_operators_active_phone_uq
  ON affiliate_operators (affiliate_company_id, phone) WHERE status = 'active';

CREATE INDEX affiliate_operators_company_idx
  ON affiliate_operators (affiliate_company_id, status);

-- The shift operator who made the sale (US-AF13). Null => the manager sold directly. Pure
-- attribution — agent_id (the manager) still owns the money/caja/commission.
ALTER TABLE folios ADD COLUMN operator_id TEXT REFERENCES affiliate_operators(id);
