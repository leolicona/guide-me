import { z } from 'zod'
import { MAX_HORIZON_DAYS, daysBetween } from './slots.dates'

// 'YYYY-MM-DD' that also parses to a real calendar date.
const dateStr = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), 'Invalid calendar date')

// 'HH:MM' 24-hour wall-clock time.
const timeStr = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:MM (24h)')

const capacity = z.number().int().min(1)

// No `organizationId` / `status` / `booked` / `schedule_id` fields — Multitenancy
// Rule 1 (taken from context, never the body). Zod strips unknown keys, so an
// injected value in the payload is silently dropped.

// capacity optional → handler defaults to service.default_capacity.
export const createSlotSchema = z.object({
  date: dateStr,
  start_time: timeStr,
  capacity: capacity.optional(),
})

// PUT is a full replace; capacity is required on edit.
export const updateSlotSchema = z.object({
  date: dateStr,
  start_time: timeStr,
  capacity,
})

export const createScheduleSchema = z
  .object({
    weekdays: z
      .array(z.number().int().min(0).max(6))
      .nonempty('At least one weekday is required')
      .refine((a) => new Set(a).size === a.length, 'weekdays must be distinct'),
    start_time: timeStr,
    capacity: capacity.optional(),
    start_date: dateStr,
    end_date: dateStr,
  })
  .refine((v) => v.start_date <= v.end_date, {
    message: 'end_date must be ≥ start_date',
    path: ['end_date'],
  })
  .refine((v) => daysBetween(v.start_date, v.end_date) <= MAX_HORIZON_DAYS, {
    message: `window may not exceed ${MAX_HORIZON_DAYS} days`,
    path: ['end_date'],
  })

export type CreateSlotInput = z.infer<typeof createSlotSchema>
export type UpdateSlotInput = z.infer<typeof updateSlotSchema>
export type CreateScheduleInput = z.infer<typeof createScheduleSchema>
