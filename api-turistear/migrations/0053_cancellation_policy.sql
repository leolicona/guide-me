-- Cancellation Policy Engine (docs/cancellation/cancellation-policy-engine.spec.md).
--
-- A per-company refund ladder: how much is refunded at each distance from departure, and what
-- share of commission the seller keeps. All four columns are additive and default-safe.
--
-- D1 (the governing constraint): `cancellation_policy IS NULL` means NO policy is configured, and
-- every cancellation path then runs exactly the code it ran before this migration. Existing orgs
-- get NULL, so nothing changes for anyone until an admin writes a ladder. Rollback is
-- `UPDATE organizations SET cancellation_policy = NULL`.

-- The ladder itself, as a JSON document (D2 — a column, not a table: policy is org-level for now,
-- so this needs no CRUD routes and the per-folio snapshot is a string copy).
--   { "version": 1,
--     "tiers": [ { "min_hours": 120|null, "refund_pct": 0-100,
--                  "agent_commission_pct": 0-100, "affiliate_commission_pct": 0-100 (optional) } ],
--     "booking_deposit_retained_pct": 0-100 }
ALTER TABLE `organizations` ADD COLUMN `cancellation_policy` text;
--> statement-breakpoint

-- US-A73 (D14) — may an agent cancel their own current-shift sale? 0 preserves the admin-only
-- behaviour enforced by requireRole('admin') on the folios router since US-A21.
ALTER TABLE `organizations` ADD COLUMN `agent_cancellation_enabled` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint

-- D6 — the ladder in force when the sale was confirmed. The customer agreed to the terms they were
-- shown, so editing the policy must never re-price a sale already made. Mirrors why
-- folio_lines.commission_value is snapshotted. NULL for folios sold before this feature (or sold
-- while the org had no policy) — they fall back to the org's live policy, which is NULL for them
-- too, so they take the legacy path.
ALTER TABLE `folios` ADD COLUMN `cancellation_policy_snapshot` text;
--> statement-breakpoint

-- Who cancelled, as a TYPE rather than prose. Today the only way to tell a system expiry from an
-- admin action is `cancelled_by IS NULL` plus the Spanish string 'Apartado vencido' — not something
-- a report should have to parse. NULL = cancelled before this migration.
--   'admin' | 'agent' | 'tourist_request' | 'company' | 'system_expiry'
ALTER TABLE `folios` ADD COLUMN `cancellation_source` text;
