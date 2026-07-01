import { request } from './authService'
import type {
  LodgingAvailability,
  UnitCalendarDay,
} from '../features/pos/types'

// POS lodging reads (US-AG36/AG37). Range-first availability + unit-first calendar.

export interface AvailabilityQuery {
  check_in: string
  check_out: string
  guests: number
}

// US-AG36 — range-first: units available for the whole [check_in, check_out) range, with totals.
export const getLodgingAvailability = async (
  serviceId: string,
  q: AvailabilityQuery,
): Promise<LodgingAvailability> => {
  const params = new URLSearchParams({
    check_in: q.check_in,
    check_out: q.check_out,
    guests: String(q.guests),
  })
  return request<LodgingAvailability>(
    `/api/pos/lodging/${serviceId}/availability?${params.toString()}`,
  )
}

// US-AG37 — unit-first: a unit's day-by-day status + rate over [from, to].
export const getUnitCalendar = async (
  unitId: string,
  range: { from: string; to: string },
): Promise<UnitCalendarDay[]> => {
  const params = new URLSearchParams({ from: range.from, to: range.to })
  const res = await request<{ unit_id: string; days: UnitCalendarDay[] }>(
    `/api/pos/lodging/units/${unitId}/calendar?${params.toString()}`,
  )
  return res.days
}
