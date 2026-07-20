export type SlotStatus = 'active' | 'inactive'

export interface Slot {
  id: string
  service_id: string
  /** null = one-off specific-date slot; set = materialized from a schedule. */
  schedule_id: string | null
  /** 'YYYY-MM-DD' (org-local calendar date). */
  date: string
  /** 'HH:MM' (24-hour, org-local). */
  start_time: string
  capacity: number
  /** Spots already sold. */
  booked: number
  /** Derived server-side: capacity − booked. */
  remaining: number
  status: SlotStatus
}

export interface Schedule {
  id: string
  service_id: string
  recurrence: 'weekly'
  /** ISO weekday numbers, 0 = Sunday … 6 = Saturday. */
  weekdays: number[]
  start_time: string
  capacity: number
  start_date: string
  end_date: string
  status: SlotStatus
}

/** Indexed by ISO weekday number (0 = Sunday … 6 = Saturday). */
export const WEEKDAY_LABELS = [
  'Dom',
  'Lun',
  'Mar',
  'Mié',
  'Jue',
  'Vie',
  'Sáb',
] as const

/** Full weekday names, same 0 = Sunday indexing (rule summaries read as prose). */
export const WEEKDAY_FULL_LABELS = [
  'Domingo',
  'Lunes',
  'Martes',
  'Miércoles',
  'Jueves',
  'Viernes',
  'Sábado',
] as const

/** Human label for a slot's recurring origin. */
export const isRecurring = (slot: Slot): boolean => slot.schedule_id !== null
