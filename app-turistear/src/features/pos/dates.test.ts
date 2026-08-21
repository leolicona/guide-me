import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  todayStr,
  addDays,
  monthOf,
  addMonths,
  daysInMonth,
  firstWeekdayMondayBased,
  defaultWindow,
  defaultWindowLabel,
  posWindow,
  eachDay,
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

// US-AG55 (D15) — `defaultWindow` replaces `contextPills`, whose second pill and labels were never
// read. Every concrete expectation below is PORTED VERBATIM from the retired suite's index 0: this
// block is the equivalence proof that collapsing the function moved no date (spec S-13).
describe('defaultWindow', () => {
  it('runs from today to the coming Sunday, mid-week', () => {
    expect(defaultWindow('2026-08-05')).toEqual({ from: '2026-08-05', to: '2026-08-09' })
  })

  it('starts the week on Monday, not on the ISO-week boundary of the device', () => {
    expect(defaultWindow('2026-08-03')).toEqual({ from: '2026-08-03', to: '2026-08-09' })
  })

  it('still reaches Sunday from Thursday — the last Mon–Thu day', () => {
    expect(defaultWindow('2026-08-06')).toEqual({ from: '2026-08-06', to: '2026-08-09' })
  })

  it('is the weekend from Friday', () => {
    expect(defaultWindow('2026-08-07')).toEqual({ from: '2026-08-07', to: '2026-08-09' })
  })

  it('collapses to today alone on Sunday — it never offers a range already in the past', () => {
    expect(defaultWindow('2026-08-09')).toEqual({ from: '2026-08-09', to: '2026-08-09' })
  })

  it('never ends before it starts, and always leads with today, on any day of the week', () => {
    for (let i = 0; i < 14; i++) {
      const day = addDays('2026-08-03', i)
      const w = defaultWindow(day)
      expect(w.from, day).toBe(day)
      expect(w.from <= w.to, day).toBe(true)
    }
  })
})

// US-AG55 (D14) — the label names how much of the week the window still covers. The range is the
// same formula every day; only its extent moves, and that is what the agent needs to read.
describe('defaultWindowLabel', () => {
  it('reads «Esta semana» from Monday to Thursday', () => {
    expect(['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06'].map(defaultWindowLabel)).toEqual(
      ['Esta semana', 'Esta semana', 'Esta semana', 'Esta semana'],
    )
  })

  it('reads «Fin de semana» on Friday and Saturday — when what is left IS the weekend', () => {
    expect(['2026-08-07', '2026-08-08'].map(defaultWindowLabel)).toEqual([
      'Fin de semana',
      'Fin de semana',
    ])
  })

  it('reads «Hoy» on Sunday, where the window is a single day', () => {
    expect(defaultWindowLabel('2026-08-09')).toBe('Hoy')
    expect(defaultWindow('2026-08-09')).toEqual({ from: '2026-08-09', to: '2026-08-09' })
  })

  it('labels every day of the week, never falling through to empty', () => {
    for (let i = 0; i < 7; i++) {
      const day = addDays('2026-08-03', i)
      expect(defaultWindowLabel(day), day).toBeTruthy()
    }
  })
})

// BUG-032 — the window every POS surface resolves. The catalog list and the service detail read
// the agent's filter through this one function; when they disagreed, a card advertising Saturday's
// departure opened on a Thursday with no horarios.
describe('posWindow', () => {
  it('keeps a range WHOLE — the bug was reading only `from`', () => {
    expect(posWindow({ from: '2026-08-21', to: '2026-08-23' }, '2026-08-21')).toEqual({
      from: '2026-08-21',
      to: '2026-08-23',
    })
  })

  it('collapses a single-day pick to that day (a hyper-specific search gets no extra noise)', () => {
    expect(posWindow({ from: '2026-08-22' }, '2026-08-21')).toEqual({
      from: '2026-08-22',
      to: '2026-08-22',
    })
  })

  it('falls back to the contextual week when nothing is picked', () => {
    // Friday 2026-08-07 → through Sunday the 9th, exactly what the catalog lists.
    expect(posWindow(null, '2026-08-07')).toEqual(defaultWindow('2026-08-07'))
  })

  it('resolves the SAME window the catalog queries, for every shape of selection', () => {
    const today = '2026-08-21'
    for (const sel of [null, { from: today }, { from: today, to: '2026-08-23' }]) {
      const w = posWindow(sel, today)
      // The catalog's own expression: `selection ?? defaultWindow(today)`, `to ?? from`.
      const catalog = sel ?? defaultWindow(today)
      expect(w).toEqual({ from: catalog.from, to: catalog.to ?? catalog.from })
    }
  })
})

describe('eachDay', () => {
  it('spells out an inclusive range — the 21st through the 23rd is three days, not one', () => {
    expect(eachDay('2026-08-21', '2026-08-23')).toEqual([
      '2026-08-21',
      '2026-08-22',
      '2026-08-23',
    ])
  })

  it('yields a single day when both bounds are the same day', () => {
    expect(eachDay('2026-08-22', '2026-08-22')).toEqual(['2026-08-22'])
  })

  it('crosses a month boundary without skipping or repeating a day', () => {
    expect(eachDay('2026-08-30', '2026-09-02')).toEqual([
      '2026-08-30',
      '2026-08-31',
      '2026-09-01',
      '2026-09-02',
    ])
  })

  it('degrades to the start day on an inverted window rather than rendering no days at all', () => {
    expect(eachDay('2026-08-23', '2026-08-21')).toEqual(['2026-08-23'])
  })
})
