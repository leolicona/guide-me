import { describe, it, expect } from 'vitest'
import { buildDayState } from './dayState'

const MONTH = '2026-08'
const TODAY = '2026-08-10'

describe('US-AG57 — buildDayState', () => {
  it('seeds every day of the month, so absence is never "the server decides"', () => {
    const s = buildDayState(MONTH, { days: [], sold_out: [] }, TODAY)
    expect(s.size).toBe(31)
    expect([...s.values()].every((v) => v === 'non_operating')).toBe(true)
  })

  it('classifies the three states from the two arrays', () => {
    const s = buildDayState(
      MONTH,
      { days: ['2026-08-27'], sold_out: ['2026-08-21'] },
      TODAY,
    )
    expect(s.get('2026-08-27')).toBe('available')
    expect(s.get('2026-08-21')).toBe('sold_out')
    // Present in neither → the service does not run that day (D9).
    expect(s.get('2026-08-22')).toBe('non_operating')
  })

  it('an undefined month is inert, never optimistically available', () => {
    const s = buildDayState(MONTH, undefined, TODAY)
    expect(s.get('2026-08-27')).toBe('non_operating')
  })

  it('a stale cached month cannot resurrect a past day', () => {
    const s = buildDayState(MONTH, { days: ['2026-08-09'], sold_out: [] }, TODAY)
    expect(s.get('2026-08-09')).toBe('non_operating')
  })

  it('available wins over sold_out if the server ever reported both', () => {
    const s = buildDayState(
      MONTH,
      { days: ['2026-08-27'], sold_out: ['2026-08-27'] },
      TODAY,
    )
    expect(s.get('2026-08-27')).toBe('available')
  })
})
