-- bug: folio-counts-full-scan (.specify/bugs/folio-counts-full-scan/assessment.md). BUG-042 (0067,
-- 0068) indexed the child keys the folio roll-ups correlate on; this is the next layer out — the
-- OUTER loop those correlations run inside. Hoy polls two reads every 60 s
-- (occupancy-dashboard D3), and both could narrow by `organization_id` alone:
--
--   GET /api/folios/counts   five count(*) over folios, each `organization_id = ? AND <predicate>`.
--                            Every folios index leads with organization_id and covers no predicate
--                            column, so each count visited every folio the org ever sold.
--   GET /api/dashboard/day   the day's slots (`slots_org_service_date_idx` puts service_id between
--                            the org and the date) and the day's ledger rows
--                            (`folio_payments_shift_idx` puts collected_by between the org and
--                            created_at) — every slot and every ledger row of the org, filtered after.
--
-- Measured in production (1,011 folios, 1,980 slots, 1,424 ledger rows): /counts read 10,346 rows
-- per call (2026-10-15); the day's slots read 2,004 and each ledger read 1,424 (2026-10-16) — about
-- 15,200 rows a poll to return five small counts and twelve departures. Production keeps no
-- sqlite_stat1, so the planner cannot learn that these sets are small; the indexes below let each
-- read enter its candidate set directly, and folioPendingWork.ts states every predicate as that set.
--
-- No index is partial: a plan line then names exactly what it narrows on, which is what
-- test/folios/hoy-polled-reads.test.ts pins. `0072` is reserved for the password-column drop and
-- `0073` is claimed by specs/006-devolada-transfer-verification, hence `0074`.
--
-- Additive, idempotent, no backfill: an index carries no facts.

-- verificationPendingFilter — an electronic payment awaiting an admin.
CREATE INDEX IF NOT EXISTS folios_org_verification_idx
  ON folios (organization_id, payment_verification);

-- undeliveredFilter — tickets that never reached the customer (both stamps NULL).
CREATE INDEX IF NOT EXISTS folios_org_undelivered_idx
  ON folios (organization_id, tickets_sent_at, tickets_viewed_at);

-- refundPendingFilter — a line whose refund is still owed. Covering: the count needs only folio_id.
CREATE INDEX IF NOT EXISTS folio_lines_org_refund_idx
  ON folio_lines (organization_id, refund_status, folio_id);

-- overdueFilter — a live line whose own hold clock passed (`cancelled_at IS NULL` is an equality).
CREATE INDEX IF NOT EXISTS folio_lines_org_live_clock_idx
  ON folio_lines (organization_id, cancelled_at, booking_expires_at);

-- requestPendingFilter — a request still awaiting an answer. folio_requests had no index led by
-- organization_id at all (constitution III asks for one), and drizzle binds `status = ?` as a
-- parameter, which the partial `uq_folio_requests_open … WHERE status = 'pending'` cannot match.
CREATE INDEX IF NOT EXISTS folio_requests_org_status_idx
  ON folio_requests (organization_id, status, folio_id);

-- getDashboardDay — the day's departures.
CREATE INDEX IF NOT EXISTS slots_org_date_idx
  ON slots (organization_id, date);

-- getDashboardDay — the day's money, by the ledger's own stamp.
CREATE INDEX IF NOT EXISTS folio_payments_org_created_idx
  ON folio_payments (organization_id, created_at);
