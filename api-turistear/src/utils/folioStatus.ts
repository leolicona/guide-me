import { sql } from 'drizzle-orm'

// US-A89 (docs/folios/line-autonomy.spec.md, D11 — completed by TECH_DEBT #25). The folio's
// roll-up FIELDS derive from the lines that own the facts; the columns behind them are gone
// (migration 0065). Every correlation names outer columns RAW (`folios.id`, the displayMethodSql
// trick): an interpolated column reference resolves in the subquery's own scope and silently
// correlates to nothing.

// The folio's status, worst-case from its lines:
//   every line cancelled                                → 'cancelled'
//   any LIVE line holding less than its line_total      → 'booking'
//   otherwise                                           → 'paid'
// A line's money comes from its allocations (US-LG09); its cancellation from its written stamp.
// The no-allocations fallback died with the column: 0062's backfill covered every real folio,
// and the fixtures now seed allocations through the shared helper (TECH_DEBT #25).
export const deriveStatusSql = sql<'paid' | 'booking' | 'cancelled'>`(
  select case
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

// D15 — facet/filter semantics are ANY-LINE, deliberately different from the field's worst-case
// above: the filter answers "is there work of this kind here?", and a mixed folio genuinely has
// both kinds (S-12: it may appear under two facets at once).
export const anyLineStatusSql = (status: 'paid' | 'booking' | 'cancelled') => {
  if (status === 'cancelled') {
    return sql`exists (
      select 1 from folio_lines fl where fl.folio_id = folios.id and fl.cancelled_at is not null
    )`
  }
  const lineCondition =
    status === 'paid'
      ? sql`coalesce((select sum(a.amount) from folio_payment_allocations a where a.folio_line_id = fl.id), 0) >= fl.line_total`
      : sql`coalesce((select sum(a.amount) from folio_payment_allocations a where a.folio_line_id = fl.id), 0) < fl.line_total`
  return sql`exists (
    select 1 from folio_lines fl
    where fl.folio_id = folios.id and fl.cancelled_at is null and ${lineCondition}
  )`
}

// The folio's hold clock: MIN over its LIVE lines' clocks — the exact roll-up the column held —
// falling back to MIN over ALL lines so a LAPSED apartado (every line expired and cancelled)
// still reads as one, which is how the UI tells a lapse from an admin cancellation.
export const deriveBookingExpiresAtSql = sql<number | null>`(
  select coalesce(
    (select min(fl.booking_expires_at) from folio_lines fl
      where fl.folio_id = folios.id and fl.cancelled_at is null and fl.booking_expires_at is not null),
    (select min(fl.booking_expires_at) from folio_lines fl
      where fl.folio_id = folios.id and fl.booking_expires_at is not null)
  )
)`

// The refund obligation, rolled up from the line debts (D6): pending while ANY line owes,
// refunded when something was handed back and nothing is owed, none otherwise.
export const deriveRefundStatusSql = sql<'none' | 'pending' | 'refunded'>`(
  select case
    when exists (select 1 from folio_lines fl where fl.folio_id = folios.id and fl.refund_status = 'pending')
      then 'pending'
    when exists (select 1 from folio_lines fl where fl.folio_id = folios.id and fl.refund_status = 'refunded')
      then 'refunded'
    else 'none'
  end
)`

// The obligation's amount: what is still OWED while anything is pending, else what was refunded.
// NULL when there is no obligation at all — the shape the column always had.
export const deriveRefundAmountSql = sql<number | null>`(
  select case
    when exists (select 1 from folio_lines fl where fl.folio_id = folios.id and fl.refund_status = 'pending')
      then (select sum(fl.refund_amount) from folio_lines fl
             where fl.folio_id = folios.id and fl.refund_status = 'pending')
    when exists (select 1 from folio_lines fl where fl.folio_id = folios.id and fl.refund_status = 'refunded')
      then (select sum(fl.refund_amount) from folio_lines fl
             where fl.folio_id = folios.id and fl.refund_status = 'refunded')
    else null
  end
)`
