-- BUG-042, second half (docs/BUGS.md). 0067 indexed the two child keys the folio ROLL-UPS correlate
-- on. The list row carries a third correlation, older than both — `displayMethodSql`
-- (utils/folioPayments.ts, US-AG41):
--
--   … from folio_payments fp where fp.folio_id = folios.id and fp.entry_type = 'payment'
--
-- and folio_payments' index (0049) is `(organization_id, folio_id)`: the same shape, the same
-- full scan per folio. Measured on 240 folios / 480 payments: the list read 121,433 rows with 0067
-- alone and 6,952 with this index too. It is also the ONLY scan production runs today, since prod
-- still predates 0065's derivations — its seller list read ~200,000 rows per request on exactly
-- this correlation.
--
-- Additive, idempotent, no backfill: an index carries no facts.
CREATE INDEX IF NOT EXISTS folio_payments_folio_only_idx
  ON folio_payments (folio_id);
