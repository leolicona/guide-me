import { request } from './authService'
import type { Schedule, Slot, SlotStatus } from '../features/schedules/types'

// US-A10 — slots & schedules are nested under a service. All endpoints are
// admin-only (enforced server-side); these clients just shape the calls.

export interface SlotInput {
  date: string
  start_time: string
  /** Omit to default to the service's default_capacity (create only). */
  capacity?: number
}

export interface UpdateSlotInput {
  date: string
  start_time: string
  capacity: number
}

export interface ScheduleInput {
  weekdays: number[]
  start_time: string
  /** Omit to default to the service's default_capacity. */
  capacity?: number
  start_date: string
  end_date: string
}

export interface SlotListFilters {
  from?: string
  to?: string
  /** 'active' (default server-side) | 'inactive' | 'all'. */
  status?: 'active' | 'inactive' | 'all'
}

const slotQuery = (filters?: SlotListFilters): string => {
  const params = new URLSearchParams()
  if (filters?.from) params.set('from', filters.from)
  if (filters?.to) params.set('to', filters.to)
  if (filters?.status) params.set('status', filters.status)
  const qs = params.toString()
  return qs ? `?${qs}` : ''
}

// --- Slots -----------------------------------------------------------------

export const listSlots = async (
  serviceId: string,
  filters?: SlotListFilters,
): Promise<Slot[]> => {
  const res = await request<{ slots: Slot[] }>(
    `/api/services/${serviceId}/slots${slotQuery(filters)}`,
  )
  return res.slots
}

export const createSlot = async (
  serviceId: string,
  data: SlotInput,
): Promise<Slot> => {
  const res = await request<{ slot: Slot }>(`/api/services/${serviceId}/slots`, {
    method: 'POST',
    body: JSON.stringify(data),
  })
  return res.slot
}

export const updateSlot = async (
  serviceId: string,
  slotId: string,
  data: UpdateSlotInput,
): Promise<Slot> => {
  const res = await request<{ slot: Slot }>(
    `/api/services/${serviceId}/slots/${slotId}`,
    { method: 'PUT', body: JSON.stringify(data) },
  )
  return res.slot
}

export const deactivateSlot = async (
  serviceId: string,
  slotId: string,
): Promise<Slot> => {
  const res = await request<{ slot: Slot }>(
    `/api/services/${serviceId}/slots/${slotId}/deactivate`,
    { method: 'POST' },
  )
  return res.slot
}

export const reactivateSlot = async (
  serviceId: string,
  slotId: string,
): Promise<Slot> => {
  const res = await request<{ slot: Slot }>(
    `/api/services/${serviceId}/slots/${slotId}/reactivate`,
    { method: 'POST' },
  )
  return res.slot
}

// --- Schedules -------------------------------------------------------------

export const listSchedules = async (
  serviceId: string,
  status?: SlotStatus,
): Promise<Schedule[]> => {
  const query = status ? `?status=${status}` : ''
  const res = await request<{ schedules: Schedule[] }>(
    `/api/services/${serviceId}/schedules${query}`,
  )
  return res.schedules
}

export interface CreateScheduleResult {
  schedule: Schedule
  slots_generated: number
}

export const createSchedule = (
  serviceId: string,
  data: ScheduleInput,
): Promise<CreateScheduleResult> =>
  request<CreateScheduleResult>(`/api/services/${serviceId}/schedules`, {
    method: 'POST',
    body: JSON.stringify(data),
  })

export interface DeactivateScheduleResult {
  schedule: { id: string; status: SlotStatus }
  slots_closed: number
}

export const deactivateSchedule = (
  serviceId: string,
  scheduleId: string,
): Promise<DeactivateScheduleResult> =>
  request<DeactivateScheduleResult>(
    `/api/services/${serviceId}/schedules/${scheduleId}/deactivate`,
    { method: 'POST' },
  )
