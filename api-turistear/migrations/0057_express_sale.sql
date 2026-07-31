-- Express Sale + Group Redemption (docs/pos/express-sale.spec.md,
-- docs/scanner/group-redemption.spec.md). One migration, two sibling features
-- shipping together. Everything additive with defaults: no ordering hazard with
-- the deployed worker, and every existing row behaves exactly as before.

-- US-AG45 (D22) — how the sale was taken. Existing folios are standard by definition.
ALTER TABLE folios ADD COLUMN sale_mode TEXT NOT NULL DEFAULT 'standard';

-- US-AG45 (D21) — client-generated replay guard: a double-tap or a 3G retry must
-- never write a second folio (and a second cash row against the seller's caja).
-- Nullable — pre-feature and standard sales carry none; the partial unique index
-- lets the NULLs coexist while a key stays unique within its organization.
ALTER TABLE folios ADD COLUMN idempotency_key TEXT;
CREATE UNIQUE INDEX folios_idempotency_key_idx
  ON folios (organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- US-A79 (D1) — how a scan consumes a ticket's passes: one per scan (default,
-- byte-identical to today) or the whole party at once. Read from the SCANNING
-- agent's org at scan time, never snapshotted onto the ticket.
ALTER TABLE organizations
  ADD COLUMN qr_redemption_mode TEXT NOT NULL DEFAULT 'per_pass';
