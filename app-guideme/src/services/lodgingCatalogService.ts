import { request } from './authService'
import type { AccommodationUnit, Blockout, Season } from '../features/catalog/types'
import type { AmenityKey } from '../features/catalog/lodging'

// Lodging admin CRUD (docs/lodging/accommodation-stays.spec.md §4.1). Units/seasons/blockouts
// live under a lodging service. All money fields are minor units (centavos) — callers convert
// from major-unit form values with amountToCents before calling these.

export interface UnitInput {
  name: string
  unit_type?: string | null
  beds: number
  base_occupancy: number
  max_capacity: number
  base_rate: number
  weekend_rate?: number | null
  extra_person_fee: number
  min_nights: number
  checkin_time: string
  checkout_time: string
  amenities: AmenityKey[]
  /** Commission override (waterfall): null/omitted ⇒ inherit the service rate. When set,
   * `commission_value` is basis points (percent) or minor units (fixed). */
  commission_type?: 'percent' | 'fixed' | null
  commission_value?: number | null
}

export interface SeasonInput {
  name: string
  start_date: string
  end_date: string
  nightly_rate: number
}

export interface BlockoutInput {
  start_date: string
  end_date: string
  reason?: string | null
}

// --- Units (US-A59) ---

export const listUnits = async (serviceId: string): Promise<AccommodationUnit[]> => {
  const res = await request<{ units: AccommodationUnit[] }>(
    `/api/services/${serviceId}/units`,
  )
  return res.units
}

export const createUnit = async (
  serviceId: string,
  data: UnitInput,
): Promise<AccommodationUnit> => {
  const res = await request<{ unit: AccommodationUnit }>(
    `/api/services/${serviceId}/units`,
    { method: 'POST', body: JSON.stringify(data) },
  )
  return res.unit
}

export const updateUnit = async (
  serviceId: string,
  unitId: string,
  data: UnitInput,
): Promise<AccommodationUnit> => {
  const res = await request<{ unit: AccommodationUnit }>(
    `/api/services/${serviceId}/units/${unitId}`,
    { method: 'PUT', body: JSON.stringify(data) },
  )
  return res.unit
}

export const deactivateUnit = (serviceId: string, unitId: string) =>
  request<{ unit: AccommodationUnit }>(
    `/api/services/${serviceId}/units/${unitId}/deactivate`,
    { method: 'POST' },
  )

export const reactivateUnit = (serviceId: string, unitId: string) =>
  request<{ unit: AccommodationUnit }>(
    `/api/services/${serviceId}/units/${unitId}/reactivate`,
    { method: 'POST' },
  )

// --- Seasons (US-A60) — overlap raises 409 SEASON_OVERLAP ---

export const listSeasons = async (
  serviceId: string,
  unitId: string,
): Promise<Season[]> => {
  const res = await request<{ seasons: Season[] }>(
    `/api/services/${serviceId}/units/${unitId}/seasons`,
  )
  return res.seasons
}

export const createSeason = async (
  serviceId: string,
  unitId: string,
  data: SeasonInput,
): Promise<Season> => {
  const res = await request<{ season: Season }>(
    `/api/services/${serviceId}/units/${unitId}/seasons`,
    { method: 'POST', body: JSON.stringify(data) },
  )
  return res.season
}

export const deleteSeason = (serviceId: string, unitId: string, seasonId: string) =>
  request<{ ok: boolean }>(
    `/api/services/${serviceId}/units/${unitId}/seasons/${seasonId}`,
    { method: 'DELETE' },
  )

// --- Blockouts (US-A61) ---

export const listBlockouts = async (
  serviceId: string,
  unitId: string,
): Promise<Blockout[]> => {
  const res = await request<{ blockouts: Blockout[] }>(
    `/api/services/${serviceId}/units/${unitId}/blockouts`,
  )
  return res.blockouts
}

export const createBlockout = async (
  serviceId: string,
  unitId: string,
  data: BlockoutInput,
): Promise<Blockout> => {
  const res = await request<{ blockout: Blockout }>(
    `/api/services/${serviceId}/units/${unitId}/blockouts`,
    { method: 'POST', body: JSON.stringify(data) },
  )
  return res.blockout
}

export const deleteBlockout = (
  serviceId: string,
  unitId: string,
  blockoutId: string,
) =>
  request<{ ok: boolean }>(
    `/api/services/${serviceId}/units/${unitId}/blockouts/${blockoutId}`,
    { method: 'DELETE' },
  )
