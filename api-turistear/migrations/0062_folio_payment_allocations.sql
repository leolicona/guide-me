-- US-LG09 (docs/folios/line-autonomy.spec.md, D1/D10) — the money's per-line owner. One signed row
-- per (payment, line); Σ of a payment's allocations = the payment's amount, written in the SAME
-- batch by every live path (confirmSale, settleBooking, void, the cancellation reversal). Nothing
-- reads this table in F1 — it is the verified shadow step (paid-ledger Step 1's shape).
--
-- RE-RUNNABLE BY DESIGN: IF NOT EXISTS on DDL, a per-payment NOT EXISTS guard on every backfill
-- block, deterministic ids ('alc_' || payment_id || '_' || line_id), and created_at copied from
-- the SOURCE row — never the migration's clock (the 0061 pattern). The allocations-backfill test
-- replays these statements verbatim against pre-feature fixtures and checks them against the
-- TypeScript engine as an oracle (S-15/S-16, utils/folioAllocations.ts).

CREATE TABLE IF NOT EXISTS folio_payment_allocations (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL REFERENCES organizations(id),
  -- ON DELETE CASCADE: nothing in production ever deletes a ledger row or a line (the domain is
  -- append-only) — the cascade exists so a child allocation can never orphan-block the parent,
  -- e.g. the test suites' cleanup deletes, which the scope boundary forbids editing.
  payment_id       TEXT NOT NULL REFERENCES folio_payments(id) ON DELETE CASCADE,
  folio_line_id    TEXT NOT NULL REFERENCES folio_lines(id) ON DELETE CASCADE,
  amount           INTEGER NOT NULL,             -- signed minor units, never 0; signed like its parent row
  backfilled       INTEGER NOT NULL DEFAULT 0,   -- D10: 1 = reconstructed here. Forensic metadata only —
                                                 -- no logic may ever branch on it.
  created_at       INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS folio_payment_allocations_line_idx
  ON folio_payment_allocations (organization_id, folio_line_id);

CREATE INDEX IF NOT EXISTS folio_payment_allocations_payment_idx
  ON folio_payment_allocations (payment_id);

-- ---------------------------------------------------------------------------------------------
-- D10 backfill. The model everywhere below is the SAME one utils/folioAllocations.ts computes:
-- lines laid on a number line in CASCADE order (naive departure string, legacy-null last, id
-- tiebreak), payments laid chronologically over them; an allocation is the overlap. Cascade
-- order key — must stay byte-equivalent to `cascadeKey` in folioAllocations.ts:
--   COALESCE(slot_date, check_in, '9999-12-31') || 'T' || COALESCE(slot_start_time, '00:00')
-- ---------------------------------------------------------------------------------------------

-- Block 1 — PAID + CANCELLED folios' payment rows: plain interval intersection over full
-- line_totals. For a paid folio every line ends covered EXACTLY (Σ payments = total); for a
-- cancelled ex-booking the payments cover a prefix — the same prefix the refund block reverses.
-- Only the payment→line detail is reconstruction; per-line totals are arithmetic (D10).
INSERT INTO folio_payment_allocations (id, organization_id, payment_id, folio_line_id, amount, backfilled, created_at)
SELECT
  'alc_' || p.id || '_' || l.id,
  p.organization_id,
  p.id,
  l.id,
  MIN(p.cum_end, l.cum_end) - MAX(p.cum_start, l.cum_start),
  1,
  p.created_at
FROM (
  SELECT fp.id, fp.organization_id, fp.folio_id, fp.created_at,
         SUM(fp.amount) OVER (PARTITION BY fp.folio_id ORDER BY fp.created_at, fp.id) - fp.amount AS cum_start,
         SUM(fp.amount) OVER (PARTITION BY fp.folio_id ORDER BY fp.created_at, fp.id) AS cum_end
  FROM folio_payments fp
  JOIN folios f ON f.id = fp.folio_id AND f.status IN ('paid', 'cancelled')
  WHERE fp.entry_type = 'payment'
) p
JOIN (
  SELECT fl.id, fl.folio_id,
         SUM(fl.line_total) OVER (PARTITION BY fl.folio_id ORDER BY COALESCE(fl.slot_date, fl.check_in, '9999-12-31') || 'T' || COALESCE(fl.slot_start_time, '00:00'), fl.id) - fl.line_total AS cum_start,
         SUM(fl.line_total) OVER (PARTITION BY fl.folio_id ORDER BY COALESCE(fl.slot_date, fl.check_in, '9999-12-31') || 'T' || COALESCE(fl.slot_start_time, '00:00'), fl.id) AS cum_end
  FROM folio_lines fl
) l ON l.folio_id = p.folio_id
WHERE MIN(p.cum_end, l.cum_end) - MAX(p.cum_start, l.cum_start) > 0
  AND NOT EXISTS (SELECT 1 FROM folio_payment_allocations a WHERE a.payment_id = p.id);

-- Block 2 — BOOKING folios: the D2/D3 seed-and-cascade applied retroactively. Segments per line:
-- first every line's SEED (org minimum % of line_total, integer division = floor), then every
-- line's REMAINDER, both in cascade order — so the deposit funds every line's minimum before any
-- line is topped up. The GROUP BY merges a payment that crosses a line's seed and remainder into
-- one (payment, line) row. Reconstruction under TODAY'S org % — the honest limit the spec declares.
INSERT INTO folio_payment_allocations (id, organization_id, payment_id, folio_line_id, amount, backfilled, created_at)
SELECT
  'alc_' || p.id || '_' || s.line_id,
  p.organization_id,
  p.id,
  s.line_id,
  SUM(MIN(p.cum_end, s.cum_end) - MAX(p.cum_start, s.cum_start)),
  1,
  p.created_at
FROM (
  SELECT fp.id, fp.organization_id, fp.folio_id, fp.created_at,
         SUM(fp.amount) OVER (PARTITION BY fp.folio_id ORDER BY fp.created_at, fp.id) - fp.amount AS cum_start,
         SUM(fp.amount) OVER (PARTITION BY fp.folio_id ORDER BY fp.created_at, fp.id) AS cum_end
  FROM folio_payments fp
  JOIN folios f2 ON f2.id = fp.folio_id AND f2.status = 'booking'
  WHERE fp.entry_type = 'payment'
) p
JOIN (
  SELECT seg.line_id, seg.folio_id,
         SUM(seg.amount) OVER (PARTITION BY seg.folio_id ORDER BY seg.seg_rank, seg.ord_key, seg.line_id) - seg.amount AS cum_start,
         SUM(seg.amount) OVER (PARTITION BY seg.folio_id ORDER BY seg.seg_rank, seg.ord_key, seg.line_id) AS cum_end
  FROM (
    SELECT fl.id AS line_id, fl.folio_id, r.seg_rank,
           CASE r.seg_rank
             WHEN 0 THEN MIN(fl.line_total, (fl.line_total * o.booking_min_down_payment_pct) / 100)
             ELSE fl.line_total - MIN(fl.line_total, (fl.line_total * o.booking_min_down_payment_pct) / 100)
           END AS amount,
           COALESCE(fl.slot_date, fl.check_in, '9999-12-31') || 'T' || COALESCE(fl.slot_start_time, '00:00') AS ord_key
    FROM folio_lines fl
    JOIN folios f ON f.id = fl.folio_id AND f.status = 'booking'
    JOIN organizations o ON o.id = f.organization_id
    CROSS JOIN (SELECT 0 AS seg_rank UNION ALL SELECT 1) r
  ) seg
  WHERE seg.amount > 0
) s ON s.folio_id = p.folio_id
WHERE MIN(p.cum_end, s.cum_end) - MAX(p.cum_start, s.cum_start) > 0
  AND NOT EXISTS (SELECT 1 FROM folio_payment_allocations a WHERE a.payment_id = p.id)
GROUP BY p.id, s.line_id;

-- Block 3 — CANCELLED folios' refund rows: each line's refund share is PRO-RATA to the money it
-- held (its payment coverage from Block 1's arithmetic, in closed form), floors + remainder to
-- the heaviest line — the exact rule the live reversal uses (prorateByWeight); the refund rows
-- (one per method bucket) then lay chronologically over those shares. Allocations are NEGATIVE,
-- signed like their parent rows.
WITH lines_cum AS (
  SELECT fl.id AS line_id, fl.folio_id,
         COALESCE(fl.slot_date, fl.check_in, '9999-12-31') || 'T' || COALESCE(fl.slot_start_time, '00:00') AS ord_key,
         SUM(fl.line_total) OVER (PARTITION BY fl.folio_id ORDER BY COALESCE(fl.slot_date, fl.check_in, '9999-12-31') || 'T' || COALESCE(fl.slot_start_time, '00:00'), fl.id) - fl.line_total AS cum_start,
         SUM(fl.line_total) OVER (PARTITION BY fl.folio_id ORDER BY COALESCE(fl.slot_date, fl.check_in, '9999-12-31') || 'T' || COALESCE(fl.slot_start_time, '00:00'), fl.id) AS cum_end
  FROM folio_lines fl
  JOIN folios f ON f.id = fl.folio_id AND f.status = 'cancelled'
),
cov AS (
  SELECT lc.line_id, lc.folio_id, lc.ord_key,
         MAX(0, MIN(lc.cum_end, pt.paid_total) - MIN(lc.cum_start, pt.paid_total)) AS weight
  FROM lines_cum lc
  JOIN (
    SELECT fp.folio_id, COALESCE(SUM(fp.amount), 0) AS paid_total
    FROM folio_payments fp WHERE fp.entry_type = 'payment' GROUP BY fp.folio_id
  ) pt ON pt.folio_id = lc.folio_id
),
tot AS (
  SELECT c.folio_id, SUM(c.weight) AS cov_total, rt.refund_total
  FROM cov c
  JOIN (
    SELECT fp.folio_id, COALESCE(SUM(-fp.amount), 0) AS refund_total
    FROM folio_payments fp WHERE fp.entry_type = 'refund' GROUP BY fp.folio_id
  ) rt ON rt.folio_id = c.folio_id
  GROUP BY c.folio_id
),
share AS (
  SELECT c.line_id, c.folio_id, c.ord_key, c.weight,
         (c.weight * t.refund_total) / t.cov_total AS floor_share,
         ROW_NUMBER() OVER (PARTITION BY c.folio_id ORDER BY c.weight DESC, c.ord_key, c.line_id) AS heavy_rank,
         t.refund_total
  FROM cov c
  JOIN tot t ON t.folio_id = c.folio_id
  WHERE t.refund_total > 0 AND t.cov_total > 0 AND c.weight > 0
),
share_cum AS (
  SELECT sf.line_id, sf.folio_id,
         SUM(sf.amount) OVER (PARTITION BY sf.folio_id ORDER BY sf.ord_key, sf.line_id) - sf.amount AS cum_start,
         SUM(sf.amount) OVER (PARTITION BY sf.folio_id ORDER BY sf.ord_key, sf.line_id) AS cum_end
  FROM (
    SELECT s.line_id, s.folio_id, s.ord_key,
           s.floor_share + CASE WHEN s.heavy_rank = 1
             THEN s.refund_total - (SELECT SUM(s2.floor_share) FROM share s2 WHERE s2.folio_id = s.folio_id)
             ELSE 0 END AS amount
    FROM share s
  ) sf
  WHERE sf.amount > 0
),
ref_cum AS (
  SELECT fp.id, fp.organization_id, fp.folio_id, fp.created_at,
         SUM(-fp.amount) OVER (PARTITION BY fp.folio_id ORDER BY fp.created_at, fp.id) + fp.amount AS cum_start,
         SUM(-fp.amount) OVER (PARTITION BY fp.folio_id ORDER BY fp.created_at, fp.id) AS cum_end
  FROM folio_payments fp
  JOIN folios f ON f.id = fp.folio_id AND f.status = 'cancelled'
  WHERE fp.entry_type = 'refund'
)
INSERT INTO folio_payment_allocations (id, organization_id, payment_id, folio_line_id, amount, backfilled, created_at)
SELECT
  'alc_' || r.id || '_' || sc.line_id,
  r.organization_id,
  r.id,
  sc.line_id,
  -(MIN(r.cum_end, sc.cum_end) - MAX(r.cum_start, sc.cum_start)),
  1,
  r.created_at
FROM ref_cum r
JOIN share_cum sc ON sc.folio_id = r.folio_id
WHERE MIN(r.cum_end, sc.cum_end) - MAX(r.cum_start, sc.cum_start) > 0
  AND NOT EXISTS (SELECT 1 FROM folio_payment_allocations a WHERE a.payment_id = r.id);
