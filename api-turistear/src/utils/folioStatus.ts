import { sql } from 'drizzle-orm'

// US-A89 (docs/folios/line-autonomy.spec.md, D11 — F4 step one). The folio's `status` FIELD stops
// reading the column and derives, worst-case, from the lines that own the facts:
//
//   every line cancelled                                → 'cancelled'
//   any LIVE line holding less than its line_total      → 'booking'
//   otherwise                                           → 'paid'
//
// A line's money comes from its allocations (US-LG09); its cancellation from its written stamp.
// By construction this equals the column on every folio the write paths touch (they keep the
// column as the same worst-case while it lives), so responses are byte-identical — the point of
// this step is that the TRUTH now flows from the lines, provably, before any reader changes.
//
// The first branch is the transition's honesty valve: a folio with no allocations AT ALL (a
// hand-seeded legacy fixture — never a production folio, which 0062's backfill covered) falls
// back to the column rather than reading as an apartado it never was. PR-9 deletes the fallback
// together with the column.
//
// Correlations name outer columns RAW (`folios.id`, the displayMethodSql trick): an interpolated
// column reference resolves in the subquery's own scope and silently correlates to nothing.
export const deriveStatusSql = sql<'paid' | 'booking' | 'cancelled'>`(
  select case
    when not exists (
      select 1 from folio_payment_allocations a
      join folio_lines fl2 on a.folio_line_id = fl2.id
      where fl2.folio_id = folios.id
    ) then folios.status
    when coalesce(sum(case when fl.cancelled_at is null then 1 else 0 end), 0) = 0
      then 'cancelled'
    when coalesce(sum(case
      when fl.cancelled_at is null
       and coalesce((select sum(a2.amount) from folio_payment_allocations a2
                     where a2.folio_line_id = fl.id), 0) < fl.line_total
      then 1 else 0 end), 0) > 0
      then 'booking'
    else 'paid'
  end
  from folio_lines fl where fl.folio_id = folios.id
)`
