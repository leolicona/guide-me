import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  todayStr,
  addDays,
  monthOf,
  addMonths,
  daysInMonth,
  firstWeekdayMondayBased,
  contextPills,
} from './dates'

// Calendar arithmetic, which is where off-by-one lives. Every clock-dependent test pins the system
// time — a suite that passes on Tuesday and fails on Sunday is worse than no suite.

afterEach(() => {
  vi.useRealTimers()
})

describe('todayStr', () => {
  it('resolves the ORG-local day, not the device day (US-A66 / BUG-007)', () => {
    // 2026-08-06 01:30 UTC. In Cancún (UTC-5) it is still the evening of the 5th — an agent
    // selling at 20:30 must not see the catalog roll over to "Hoy = the 6th".
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-06T01:30:00Z'))
    expect(todayStr('America/Cancun')).toBe('2026-08-05')
    expect(todayStr('UTC')).toBe('2026-08-06')
  })

  it('resolves the other side of the boundary too', () => {
    // 2026-08-05 23:00 UTC → Tokyo (UTC+9) is already the 6th.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-05T23:00:00Z'))
    expect(todayStr('Asia/Tokyo')).toBe('2026-08-06')
    expect(todayStr('America/Cancun')).toBe('2026-08-05')
  })

  it('always returns a zero-padded YYYY-MM-DD', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-02T12:00:00Z'))
    expect(todayStr('UTC')).toBe('2026-01-02')
    // The no-tz fallback (org not loaded yet) reads the device calendar — assert the SHAPE, since
    // the value depends on the runner's zone and asserting it would be asserting the runner.
    expect(todayStr()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('addDays', () => {
  it('adds and subtracts whole days', () => {
    expect(addDays('2026-08-05', 1)).toBe('2026-08-06')
    expect(addDays('2026-08-05', -1)).toBe('2026-08-04')
    expect(addDays('2026-08-05', 0)).toBe('2026-08-05')
  })

  it('crosses a month end', () => {
    expect(addDays('2026-08-31', 1)).toBe('2026-09-01')
    expect(addDays('2026-09-01', -1)).toBe('2026-08-31')
  })

  it('crosses a year end', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2027-01-01', -1)).toBe('2026-12-31')
  })

  it('crosses a leap day', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29')
    expect(addDays('2028-02-29', 1)).toBe('2028-03-01')
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01') // not a leap year
  })

  it('is unaffected by the runner timezone — the arithmetic is UTC-midnight based', () => {
    const original = process.env.TZ
    try {
      process.env.TZ = 'Pacific/Kiritimati' // UTC+14, the most aggressive offset there is
      expect(addDays('2026-08-05', 1)).toBe('2026-08-06')
    } finally {
      process.env.TZ = original
    }
  })
})

describe('monthOf / addMonths / daysInMonth', () => {
  it('takes the YYYY-MM of a date', () => {
    expect(monthOf('2026-08-05')).toBe('2026-08')
  })

  it('shifts months forward and back', () => {
    expect(addMonths('2026-08', 1)).toBe('2026-09')
    expect(addMonths('2026-08', -1)).toBe('2026-07')
  })

  it('rolls the year over in both directions', () => {
    expect(addMonths('2026-12', 1)).toBe('2027-01')
    expect(addMonths('2026-01', -1)).toBe('2025-12')
    expect(addMonths('2026-06', 12)).toBe('2027-06')
  })

  it('counts days including leap February', () => {
    expect(daysInMonth('2026-01')).toBe(31)
    expect(daysInMonth('2026-04')).toBe(30)
    expect(daysInMonth('2026-02')).toBe(28)
    expect(daysInMonth('2028-02')).toBe(29) // leap
    expect(daysInMonth('2000-02')).toBe(29) // divisible by 400 — a leap year
    expect(daysInMonth('1900-02')).toBe(28) // divisible by 100, not 400 — NOT a leap year
    expect(daysInMonth('2026-12')).toBe(31)
  })
})

describe('firstWeekdayMondayBased', () => {
  it('counts the leading blanks in a Monday-first grid', () => {
    expect(firstWeekdayMondayBased('2026-08')).toBe(5) // 2026-08-01 is a Saturday
    expect(firstWeekdayMondayBased('2026-06')).toBe(0) // a Monday — no blanks
  })

  it('returns 6 for a month starting on Sunday — the value a Sunday-first grid gets wrong', () => {
    expect(firstWeekdayMondayBased('2026-02')).toBe(6) // 2026-02-01 is a Sunday
    expect(firstWeekdayMondayBased('2026-11')).toBe(6)
  })
})

// US-AG35 — the pills adapt to the day of week, and the FIRST pill is the contextual default.
describe('contextPills', () => {
  it('offers ESTA SEMANA (default) + ESTE FIN from Monday to Thursday', () => {
    const wednesday = contextPills('2026-08-05')
    expect(wednesday.map((p) => p.key)).toEqual(['esta_semana', 'este_fin'])
    expect(wednesday[0]).toMatchObject({
      label: 'ESTA SEMANA',
      from: '2026-08-05', // today
      to: '2026-08-09', // the coming Sunday
    })
    expect(wednesday[1]).toMatchObject({
      label: 'ESTE FIN',
      from: '2026-08-07', // Friday
      to: '2026-08-09',
    })
  })

  it('starts the week on Monday, not on the ISO-week boundary of the device', () => {
    const monday = contextPills('2026-08-03')
    expect(monday[0]).toMatchObject({ from: '2026-08-03', to: '2026-08-09' })
    expect(monday[1]).toMatchObject({ from: '2026-08-07', to: '2026-08-09' })
  })

  it('still includes today in ESTE FIN on Thursday — the last Mon–Thu day', () => {
    const thursday = contextPills('2026-08-06')
    expect(thursday.map((p) => p.key)).toEqual(['esta_semana', 'este_fin'])
    expect(thursday[0].from).toBe('2026-08-06')
    expect(thursday[1].from).toBe('2026-08-07')
  })

  it('flips to ESTE FIN (default) + SIG. SEMANA from Friday', () => {
    const friday = contextPills('2026-08-07')
    expect(friday.map((p) => p.key)).toEqual(['este_fin', 'sig_semana'])
    expect(friday[0]).toMatchObject({ from: '2026-08-07', to: '2026-08-09' })
    expect(friday[1]).toMatchObject({ from: '2026-08-10', to: '2026-08-16' })
  })

  it('on Sunday, ESTE FIN is today only — it never offers a range already in the past', () => {
    const sunday = contextPills('2026-08-09')
    expect(sunday[0]).toMatchObject({ key: 'este_fin', from: '2026-08-09', to: '2026-08-09' })
    expect(sunday[1]).toMatchObject({ key: 'sig_semana', from: '2026-08-10', to: '2026-08-16' })
  })

  it('never produces a range that ends before it starts, on any day of the week', () => {
    for (let i = 0; i < 14; i++) {
      const day = addDays('2026-08-03', i)
      for (const pill of contextPills(day)) {
        expect(pill.from <= pill.to, `${day} · ${pill.key}`).toBe(true)
      }
    }
  })

  it('always leads with the pill that contains today', () => {
    for (let i = 0; i < 14; i++) {
      const day = addDays('2026-08-03', i)
      const [first] = contextPills(day)
      expect(first.from, `${day} · ${first.key}`).toBe(day)
    }
  })
})
