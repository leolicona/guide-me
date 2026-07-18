import { z } from 'zod'

// Mirrors the backend's slots.schema.ts so the client blocks bad input before
// the round-trip. Dates are 'YYYY-MM-DD', times 'HH:MM' (24h).
const dateStr = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida (YYYY-MM-DD)')
  .refine(
    (s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)),
    'Fecha de calendario inválida',
  )

const timeStr = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Hora inválida (HH:MM)')

const capacity = z
  .number({ message: 'Ingresa una capacidad válida' })
  .int('La capacidad debe ser un entero')
  .min(1, 'La capacidad mínima es 1')

export const slotFormSchema = z.object({
  date: dateStr,
  start_time: timeStr,
  capacity,
})

export type SlotFormData = z.infer<typeof slotFormSchema>

export const scheduleFormSchema = z
  .object({
    weekdays: z
      .array(z.number().int().min(0).max(6))
      .nonempty('Selecciona al menos un día'),
    start_time: timeStr,
    capacity,
    start_date: dateStr,
    end_date: dateStr,
  })
  .refine((v) => v.start_date <= v.end_date, {
    message: 'La fecha final debe ser ≥ a la inicial',
    path: ['end_date'],
  })

export type ScheduleFormData = z.infer<typeof scheduleFormSchema>
