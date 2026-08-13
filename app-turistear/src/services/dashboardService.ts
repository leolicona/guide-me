import { request } from './authService'

// US-A14/A15/A16/A90 — the Daily Operations Dashboard read (docs/dashboard/occupancy-dashboard.spec.md).
// One payload per day: occupancy + departed + the day's money. Money in minor units.

export interface DashboardOccupancyRow {
  slot_id: string
  service_id: string
  service_name: string
  start_time: string
  capacity: number
  booked: number
  remaining: number
  vendidos: number
  apartados: number
  is_flexible: boolean
  flex_extra: number
}

export interface DashboardDepartedRow {
  slot_id: string
  service_name: string
  start_time: string
  vendidos: number
  abordaron: number
  sin_usar: number
}

export interface DashboardSeller {
  user_id: string
  name: string
  operator_name: string | null
  collected_cents: number
}

export interface DashboardSales {
  collected_cents: number
  folios_created: number
  per_seller: DashboardSeller[]
}

export interface DashboardDay {
  date: string
  occupancy: DashboardOccupancyRow[]
  departed: DashboardDepartedRow[]
  sales: DashboardSales
}

export const getDashboardDay = (date?: string): Promise<DashboardDay> =>
  request<DashboardDay>(`/api/dashboard/day${date ? `?date=${date}` : ''}`)
