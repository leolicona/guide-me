import { describe, it, expect } from 'vitest'
import { slotFormSchema, scheduleFormSchema } from './schemas'

const issuePaths = (result: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }) =>
  result.error?.issues.map((i) => i.path.join('.')) ?? []

// These mirror the backend's slots.schema.ts. The point of the mirror is to block bad input before
// the round-trip — so the mirror has to reject exactly what the server would.
describe('slotFormSchema', () => {
  const valid = { date: '2026-08-05', start_time: '09:00', capacity: 20 }

  it('accepts a well-formed slot', () => {
    expect(slotFormSchema.safeParse(valid).success).toBe(true)
  })

  it.each(['05-08-2026', '2026/08/05', '2026-8-5', 'mañana', ''])(
    'rejects the date %j — the API only speaks YYYY-MM-DD',
    (date) => {
      const result = slotFormSchema.safeParse({ ...valid, date })
      expect(result.success).toBe(false)
      expect(issuePaths(result)).toContain('date')
    },
  )

  it('rejects an out-of-range month', () => {
    expect(slotFormSchema.safeParse({ ...valid, date: '2026-13-01' }).success).toBe(false)
    expect(slotFormSchema.safeParse({ ...valid, date: '2026-00-10' }).success).toBe(false)
  })

  // KNOWN GAP, pinned rather than wished away (docs/BUGS.md BUG-019): the refine is
  // `!Number.isNaN(Date.parse(...))`, and Date.parse REJECTS an out-of-range month but silently
  // ROLLS OVER an out-of-range day — '2026-02-31' parses as 2026-03-03. So the check labelled
  // "Fecha de calendario inválida" catches only half of what its message promises, and the API
  // receives the literal '2026-02-31'. When it is fixed, these flip to `false`.
  it.each(['2026-02-31', '2026-02-30', '2026-04-31'])(
    'still accepts the non-existent date %s (known gap)',
    (date) => {
      expect(slotFormSchema.safeParse({ ...valid, date }).success).toBe(true)
    },
  )

  it.each(['9:00', '24:00', '23:60', '09:0', '0900', ''])(
    'rejects the time %j',
    (start_time) => {
      expect(slotFormSchema.safeParse({ ...valid, start_time }).success).toBe(false)
    },
  )

  it('accepts the 24-hour boundaries', () => {
    expect(slotFormSchema.safeParse({ ...valid, start_time: '00:00' }).success).toBe(true)
    expect(slotFormSchema.safeParse({ ...valid, start_time: '23:59' }).success).toBe(true)
  })

  it('requires a capacity of at least one whole seat', () => {
    expect(slotFormSchema.safeParse({ ...valid, capacity: 0 }).success).toBe(false)
    expect(slotFormSchema.safeParse({ ...valid, capacity: -5 }).success).toBe(false)
    expect(slotFormSchema.safeParse({ ...valid, capacity: 2.5 }).success).toBe(false)
    expect(slotFormSchema.safeParse({ ...valid, capacity: 1 }).success).toBe(true)
  })

  it('rejects a capacity typed as a string rather than silently coercing it', () => {
    const result = slotFormSchema.safeParse({ ...valid, capacity: '20' })
    expect(result.success).toBe(false)
    expect(issuePaths(result)).toContain('capacity')
  })
})

describe('scheduleFormSchema', () => {
  const valid = {
    weekdays: [1, 3, 5],
    start_time: '09:00',
    capacity: 20,
    start_date: '2026-08-01',
    end_date: '2026-08-31',
  }

  it('accepts a well-formed recurring schedule', () => {
    expect(scheduleFormSchema.safeParse(valid).success).toBe(true)
  })

  it('requires at least one weekday', () => {
    const result = scheduleFormSchema.safeParse({ ...valid, weekdays: [] })
    expect(result.success).toBe(false)
    expect(issuePaths(result)).toContain('weekdays')
  })

  it('bounds weekdays to 0–6', () => {
    expect(scheduleFormSchema.safeParse({ ...valid, weekdays: [7] }).success).toBe(false)
    expect(scheduleFormSchema.safeParse({ ...valid, weekdays: [-1] }).success).toBe(false)
    expect(scheduleFormSchema.safeParse({ ...valid, weekdays: [0, 6] }).success).toBe(true)
  })

  it('rejects an end date before the start, reporting it on end_date', () => {
    const result = scheduleFormSchema.safeParse({
      ...valid,
      start_date: '2026-08-31',
      end_date: '2026-08-01',
    })
    expect(result.success).toBe(false)
    expect(issuePaths(result)).toContain('end_date')
  })

  it('accepts a single-day range — start equal to end is valid', () => {
    expect(
      scheduleFormSchema.safeParse({ ...valid, start_date: '2026-08-05', end_date: '2026-08-05' })
        .success,
    ).toBe(true)
  })

  it('compares dates lexicographically across a year boundary', () => {
    expect(
      scheduleFormSchema.safeParse({ ...valid, start_date: '2026-12-28', end_date: '2027-01-04' })
        .success,
    ).toBe(true)
  })
})
