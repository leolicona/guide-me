-- devolada-transfer-verification D1-D9, D21 (specs/006-devolada-transfer-verification/data-model.md).
-- An organization connects its own Devolada account, and its transfers are cleared by Banxico's
-- verdict, which Devolada reports, instead of by an admin reading a bank app. Five tenant-scoped
-- tables, each with `organization_id` and an index led by it (constitution III):
--
--   devolada_connections  one per organization: its status and its CURRENT credential (D1-D3)
--   devolada_credentials  every key the organization ever connected, encrypted (AES-256-GCM, D1).
--                         A retired key is kept while a link that uses it is unresolved, so each
--                         link is followed with the key that created it (D21); the sweep erases it
--                         after (D12)
--   devolada_links        one per transfer we asked for: a sale, a deposit or a settlement (D6-D8)
--   devolada_payments     what Devolada reported for a link, latest snapshot per payment (D9)
--   devolada_events       the notification inbox, de-duplicating Devolada's webhook (D4)
--
-- ADDITIVE ONLY: no existing column is touched. A pull request's preview applies this to dev's D1
-- before the merge, while dev still runs code that never reads these tables (D19). Instants are
-- epoch seconds; Devolada's milliseconds are converted in services/devolada.ts (D5). Enumerations
-- are TypeScript-only, as everywhere in this schema (src/db/schema.ts).

CREATE TABLE devolada_credentials (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  mode TEXT NOT NULL,                          -- 'real'|'test', learned from the connect probe (D2)
  ciphertext TEXT,                             -- base64url AES-256-GCM; NULL once erased (D12)
  iv TEXT,                                     -- base64url 96-bit IV, fresh per write; NULL with it
  key_hint TEXT NOT NULL,                      -- last four characters: the only part ever returned
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  retired_at INTEGER,                          -- another key replaced it, or the admin disconnected
  erased_at INTEGER                            -- the sweep erased its ciphertext (D21)
);

CREATE INDEX devolada_credentials_org_idx
  ON devolada_credentials (organization_id, retired_at);

CREATE TABLE devolada_connections (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  status TEXT NOT NULL,                        -- 'connected'|'broken'|'disconnected'
  current_credential_id TEXT REFERENCES devolada_credentials(id), -- NULL while disconnected (D21)
  webhook_url TEXT,                            -- the address we registered; NULL where none (D3)
  replaced_webhook_url TEXT,                   -- the address the admin agreed to replace (FR-006)
  broken_reason TEXT,                          -- DEVOLADA_CREDENTIAL_REJECTED|_BUSINESS_SUSPENDED|_CHANNEL_UNAVAILABLE
  broken_at INTEGER,
  credit_paused_at INTEGER,                    -- a payment on the current key is queued_for_credit
  last_verdict_at INTEGER,                     -- last final verdict applied (FR-005)
  probed_at INTEGER,                           -- last re-probe of a broken connection (D2: 15 min)
  connected_by TEXT NOT NULL REFERENCES users(id),
  connected_at INTEGER NOT NULL,
  disconnected_by TEXT REFERENCES users(id),
  disconnected_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- At most one connection per organization; it also serves every read by organization.
CREATE UNIQUE INDEX devolada_connections_org_uq
  ON devolada_connections (organization_id);

CREATE TABLE devolada_links (
  id TEXT PRIMARY KEY,                         -- also the Idempotency-Key of the create (D6)
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  folio_id TEXT NOT NULL REFERENCES folios(id), -- sent to Devolada as customerRef (D7)
  folio_line_id TEXT REFERENCES folio_lines(id), -- set for a per-line settlement
  folio_payment_id TEXT REFERENCES folio_payments(id), -- sale/deposit: the pending row; settlement: the row recorded on confirmation (D8)
  kind TEXT NOT NULL,                          -- 'sale'|'deposit'|'settlement'
  credential_id TEXT NOT NULL REFERENCES devolada_credentials(id), -- the link's key (D21)
  mode TEXT NOT NULL,                          -- 'real'|'test', copied from its credential (D4)
  amount INTEGER NOT NULL,                     -- > 0; Devolada's askCents (FR-007)
  devolada_link_id TEXT,                       -- Devolada's paymentLinkId, globally unique (D4)
  url TEXT,                                    -- the payer's page, sent by WhatsApp
  expires_at INTEGER NOT NULL,                 -- D7
  state TEXT NOT NULL,                         -- creating|open|paid|expired|closing|closed|failed|abandoned
  closed_reason TEXT,                          -- cancelled|rejected|amount_changed|settled_otherwise|verified_by_admin|abandoned (D13)
  requested_by TEXT NOT NULL REFERENCES users(id), -- the seller; collected_by of a D8 settlement
  create_attempts INTEGER NOT NULL DEFAULT 1,  -- suffixes the Idempotency-Key after a refusal (D5)
  last_checked_at INTEGER,                     -- last re-read; NULL = never checked (D12)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Correlated reads on the sale detail and list (BUG-042).
CREATE INDEX devolada_links_folio_idx
  ON devolada_links (organization_id, folio_id);

-- Webhooks are routed by Devolada's link id: a globally unique key (constitution III, D4).
CREATE UNIQUE INDEX devolada_links_devolada_id_uq
  ON devolada_links (devolada_link_id);

-- The sweep's selection across organizations, like sweepExpiredBookings (D12).
CREATE INDEX devolada_links_state_expiry_idx
  ON devolada_links (state, expires_at);

-- One open settlement link per sale: a repeated settle request returns that link (D8).
CREATE UNIQUE INDEX devolada_links_open_settlement_uq
  ON devolada_links (folio_id)
  WHERE kind = 'settlement' AND state IN ('creating', 'open');

-- One open link per ledger row it collects.
CREATE UNIQUE INDEX devolada_links_open_payment_uq
  ON devolada_links (folio_payment_id)
  WHERE state IN ('creating', 'open');

-- A credential's unresolved links: the sweep's cleanup, D21's fallback and the connection view's
-- previous keys (D12, D21, BUG-042).
CREATE INDEX devolada_links_credential_idx
  ON devolada_links (credential_id, state);

CREATE TABLE devolada_payments (
  id TEXT PRIMARY KEY,                         -- the :id of the resolve endpoint (D15)
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  link_id TEXT NOT NULL REFERENCES devolada_links(id),
  folio_id TEXT NOT NULL REFERENCES folios(id), -- denormalized for indexed reads
  devolada_payment_id TEXT NOT NULL,           -- Devolada's paymentId, globally unique
  status TEXT NOT NULL,                        -- validating|queued_for_credit|confirmed|partial|unapplied|invalid|expired|superseded
  proof_door TEXT NOT NULL,                    -- 'transfer'|'receipt'
  asked_amount INTEGER NOT NULL,               -- what the link asked when the customer submitted
  claimed_amount INTEGER,                      -- what the receipt or form says: a claim, never money
  received_amount INTEGER,                     -- what Banxico says arrived (FR-020)
  match TEXT,                                  -- 'exact'|'short'|'over'
  receipt_number TEXT,                         -- Devolada's folio (DV-…), shown as «Comprobante Devolada» (FR-022)
  verdict_at INTEGER,                          -- Devolada's confirmedAt
  awaiting TEXT,                               -- 'payer_tracking_key'
  awaiting_reason TEXT,                        -- 'all_used'|'ambiguous'|'no_match'|'unreadable'
  devolada_created_at INTEGER NOT NULL,
  applied_status TEXT,                         -- the last status D9 acted on
  applied_at INTEGER,
  resolution TEXT,                             -- 'accepted'|'dismissed'|'returned' (D15)
  resolved_by TEXT REFERENCES users(id),
  resolved_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX devolada_payments_folio_idx
  ON devolada_payments (organization_id, folio_id);

CREATE INDEX devolada_payments_link_idx
  ON devolada_payments (link_id);

CREATE UNIQUE INDEX devolada_payments_devolada_id_uq
  ON devolada_payments (devolada_payment_id);

-- The attention count (D14).
CREATE INDEX devolada_payments_status_idx
  ON devolada_payments (organization_id, status);

-- The sweep's selection, across organizations, of payments in flight on closed links (D12).
CREATE INDEX devolada_payments_status_link_idx
  ON devolada_payments (status, link_id);

-- Only events resolved to an organization are stored: an unknown link has no organization to
-- scope a row to, so it is logged instead (D4).
CREATE TABLE devolada_events (
  event_id TEXT PRIMARY KEY,                   -- Devolada's evt_…, globally unique
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  devolada_payment_id TEXT NOT NULL,           -- no FK: the inbox only de-duplicates notifications
  type TEXT NOT NULL,                          -- 'payment.<status>'
  event_created_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1,
  outcome TEXT NOT NULL                        -- 'applied'|'no_change'|'mode_mismatch'|'failed'
);

CREATE INDEX devolada_events_org_idx
  ON devolada_events (organization_id, received_at);
