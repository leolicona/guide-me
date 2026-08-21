import { describe, it, expect } from 'vitest'
import {
  buildDayState,
  sellableDayAxis,
  nextSellableDay,
  prevSellableDay,
} from './dayState'

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

describe('US-AG57 D17 — the pager axis skips days that cannot be sold', () => {
  const AUG = { days: ['2026-08-21', '2026-08-14'], sold_out: ['2026-08-15'] }
  const SEP = { days: ['2026-09-02'], sold_out: [] }
  const TODAY = '2026-08-10'

  it('sorts, and never lets a sold-out day become a step target', () => {
    const axis = sellableDayAxis([AUG], TODAY)
    expect(axis).toEqual(['2026-08-14', '2026-08-21'])
    expect(axis).not.toContain('2026-08-15')
  })

  it('drops past days a stale cached month still carries', () => {
    const axis = sellableDayAxis([{ days: ['2026-08-01', '2026-08-14'], sold_out: [] }], TODAY)
    expect(axis).toEqual(['2026-08-14'])
  })

  it('deduplicates overlapping months, so one tap never appears to do nothing', () => {
    expect(sellableDayAxis([AUG, AUG], TODAY)).toEqual(['2026-08-14', '2026-08-21'])
  })

  it('steps over the gap, not into it', () => {
    const axis = sellableDayAxis([AUG], TODAY)
    // 15 is sold out and 16–20 do not run; ▶ from the 14th lands on the 21st.
    expect(nextSellableDay(axis, '2026-08-14')).toBe('2026-08-21')
    expect(prevSellableDay(axis, '2026-08-21')).toBe('2026-08-14')
  })

  it('crosses a month boundary once the neighbour is loaded', () => {
    expect(nextSellableDay(sellableDayAxis([AUG], TODAY), '2026-08-21')).toBeUndefined()
    expect(nextSellableDay(sellableDayAxis([AUG, SEP], TODAY), '2026-08-21')).toBe('2026-09-02')
  })

  it('an undefined month contributes nothing rather than throwing', () => {
    expect(sellableDayAxis([undefined, AUG, undefined], TODAY)).toEqual([
      '2026-08-14',
      '2026-08-21',
    ])
  })
})
