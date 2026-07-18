import { request } from './authService'
import type {
  LodgingAvailability,
  UnitTypeCalendarDay,
} from '../features/pos/types'

// POS lodging reads (US-AG36/AG37, v2 — unit-type inventory). Range-first availability +
// the type's remaining-count calendar.

export interface AvailabilityQuery {
  check_in: string
  check_out: string
  guests: number
  /** Rooms requested (D12); defaults to 1. */
  quantity?: number
}

// US-AG36 — range-first: unit types with enough per-night inventory for the whole
// [check_in, check_out) range × quantity, each with its quoted total.
export const getLodgingAvailability = async (
  serviceId: string,
  q: AvailabilityQuery,
): Promise<LodgingAvailability> => {
  const params = new URLSearchParams({
    check_in: q.check_in,
    check_out: q.check_out,
    guests: String(q.guests),
    quantity: String(q.quantity ?? 1),
  })
  return request<LodgingAvailability>(
    `/api/pos/lodging/${serviceId}/availability?${params.toString()}`,
  )
}

export interface UnitTypeCalendar {
  /** Total rooms of the type — caps the sheet's rooms stepper. */
  inventory_count: number
  days: UnitTypeCalendarDay[]
}

// US-AG37 — type-first: a unit type's day-by-day REMAINING rooms + rate over [from, to],
// plus the type's total inventory (the rooms-stepper ceiling).
export const getUnitTypeCalendar = async (
  typeId: string,
  range: { from: string; to: string },
): Promise<UnitTypeCalendar> => {
  const params = new URLSearchParams({ from: range.from, to: range.to })
  const res = await request<{
    unit_type_id: string
    inventory_count: number
    days: UnitTypeCalendarDay[]
  }>(`/api/pos/lodging/unit-types/${typeId}/calendar?${params.toString()}`)
  return { inventory_count: res.inventory_count, days: res.days }
}
