import { request } from './authService'
import type { AccommodationUnitType, Blockout, Season } from '../features/catalog/types'
import type { AmenityKey } from '../features/catalog/lodging'

// Lodging admin CRUD (docs/lodging/accommodation-stays.spec.md §4.1, v2 — unit-type inventory).
// Unit types/seasons/blockouts live under a lodging service. All money fields are minor units
// (centavos) — callers convert from major-unit form values with amountToCents before calling these.

export interface UnitTypeInput {
  name: string
  unit_type?: string | null
  /** v2 — how many interchangeable rooms of this type exist (≥ 1; 1 = boutique). */
  inventory_count: number
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
  /** v2 (D11) — rooms of the type taken out of inventory (1 ≤ q ≤ inventory_count). */
  quantity: number
  reason?: string | null
}

// --- Unit types (US-A59) ---

export const listUnitTypes = async (serviceId: string): Promise<AccommodationUnitType[]> => {
  const res = await request<{ unit_types: AccommodationUnitType[] }>(
    `/api/services/${serviceId}/unit-types`,
  )
  return res.unit_types
}

export const createUnitType = async (
  serviceId: string,
  data: UnitTypeInput,
): Promise<AccommodationUnitType> => {
  const res = await request<{ unit_type: AccommodationUnitType }>(
    `/api/services/${serviceId}/unit-types`,
    { method: 'POST', body: JSON.stringify(data) },
  )
  return res.unit_type
}

export const updateUnitType = async (
  serviceId: string,
  typeId: string,
  data: UnitTypeInput,
): Promise<AccommodationUnitType> => {
  const res = await request<{ unit_type: AccommodationUnitType }>(
    `/api/services/${serviceId}/unit-types/${typeId}`,
    { method: 'PUT', body: JSON.stringify(data) },
  )
  return res.unit_type
}

export const deactivateUnitType = (serviceId: string, typeId: string) =>
  request<{ unit_type: AccommodationUnitType }>(
    `/api/services/${serviceId}/unit-types/${typeId}/deactivate`,
    { method: 'POST' },
  )

export const reactivateUnitType = (serviceId: string, typeId: string) =>
  request<{ unit_type: AccommodationUnitType }>(
    `/api/services/${serviceId}/unit-types/${typeId}/reactivate`,
    { method: 'POST' },
  )

// --- Seasons (US-A60) — overlap raises 409 SEASON_OVERLAP ---

export const listSeasons = async (
  serviceId: string,
  typeId: string,
): Promise<Season[]> => {
  const res = await request<{ seasons: Season[] }>(
    `/api/services/${serviceId}/unit-types/${typeId}/seasons`,
  )
  return res.seasons
}

export const createSeason = async (
  serviceId: string,
  typeId: string,
  data: SeasonInput,
): Promise<Season> => {
  const res = await request<{ season: Season }>(
    `/api/services/${serviceId}/unit-types/${typeId}/seasons`,
    { method: 'POST', body: JSON.stringify(data) },
  )
  return res.season
}

export const deleteSeason = (serviceId: string, typeId: string, seasonId: string) =>
  request<{ ok: boolean }>(
    `/api/services/${serviceId}/unit-types/${typeId}/seasons/${seasonId}`,
    { method: 'DELETE' },
  )

// --- Blockouts (US-A61, v2 quantity-based) ---

export const listBlockouts = async (
  serviceId: string,
  typeId: string,
): Promise<Blockout[]> => {
  const res = await request<{ blockouts: Blockout[] }>(
    `/api/services/${serviceId}/unit-types/${typeId}/blockouts`,
  )
  return res.blockouts
}

export const createBlockout = async (
  serviceId: string,
  typeId: string,
  data: BlockoutInput,
): Promise<Blockout> => {
  const res = await request<{ blockout: Blockout }>(
    `/api/services/${serviceId}/unit-types/${typeId}/blockouts`,
    { method: 'POST', body: JSON.stringify(data) },
  )
  return res.blockout
}

export const deleteBlockout = (
  serviceId: string,
  typeId: string,
  blockoutId: string,
) =>
  request<{ ok: boolean }>(
    `/api/services/${serviceId}/unit-types/${typeId}/blockouts/${blockoutId}`,
    { method: 'DELETE' },
  )
