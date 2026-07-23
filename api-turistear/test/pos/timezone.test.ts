import { describe, it, expect } from 'vitest'
import { naiveEpoch, orgToday, orgWallClockMinute } from '../../src/utils/tz'

// US-A66 (docs/timezone/spec.md) — the org time-zone helpers that replace the naive-UTC arithmetic
// (BUG-007). Pure unit tests: no DB, exercising Intl-backed zone resolution in the workerd runtime.

const secOf = (y: number, mo: number, d: number, h: number, mi = 0): number =>
  Math.floor(Date.UTC(y, mo - 1, d, h, mi, 0) / 1000)

describe('orgToday — the org-local calendar day (no early UTC rollover)', () => {
  it('stays on the local day when UTC has already ticked past midnight', () => {
    // 2026-01-16 05:00 UTC is still 2026-01-15 23:00 in Mexico City (UTC-6).
    const now = Date.UTC(2026, 0, 16, 5, 0, 0)
    expect(orgToday('America/Mexico_City', now)).toBe('2026-01-15')
  })

  it('rolls to the next day at the org-local midnight', () => {
    // 2026-01-16 07:00 UTC is 2026-01-16 01:00 in Mexico City.
    const now = Date.UTC(2026, 0, 16, 7, 0, 0)
    expect(orgToday('America/Mexico_City', now)).toBe('2026-01-16')
  })

  it('differs across zones at the same instant', () => {
    // 2026-06-16 06:30 UTC: Cancun (UTC-5) → 01:30 the 16th; Tijuana (PDT, UTC-7) → 23:30 the 15th.
    const now = Date.UTC(2026, 5, 16, 6, 30, 0)
    expect(orgToday('America/Cancun', now)).toBe('2026-06-16')
    expect(orgToday('America/Tijuana', now)).toBe('2026-06-15')
  })
})

describe('naiveEpoch — wall-clock resolved in the org zone', () => {
  it('Mexico City (UTC-6, no DST) — 19:00 local is 01:00 UTC next day', () => {
    expect(naiveEpoch('2026-01-15', '19:00', 'America/Mexico_City')).toBe(secOf(2026, 1, 16, 1))
  })

  it('Cancun (UTC-5, no DST) — 19:00 local is 00:00 UTC next day', () => {
    expect(naiveEpoch('2026-01-15', '19:00', 'America/Cancun')).toBe(secOf(2026, 1, 16, 0))
  })

  it('border DST: Tijuana is PST (UTC-8) in January but PDT (UTC-7) in July', () => {
    // Same wall-clock 19:00, different absolute instant across the DST boundary.
    expect(naiveEpoch('2026-01-15', '19:00', 'America/Tijuana')).toBe(secOf(2026, 1, 16, 3))
    expect(naiveEpoch('2026-07-15', '19:00', 'America/Tijuana')).toBe(secOf(2026, 7, 16, 2))
  })

  it('is the inverse of a UTC-6 wall clock across a whole day', () => {
    // Midnight local (the ticket-expiry anchor) → 06:00 UTC that day in Mexico City.
    expect(naiveEpoch('2026-03-01', '00:00', 'America/Mexico_City')).toBe(secOf(2026, 3, 1, 6))
  })
})

describe('orgWallClockMinute — the sales-cutoff threshold string', () => {
  it('renders an absolute instant as the org-local YYYY-MM-DDTHH:MM', () => {
    // 2026-01-16 01:30 UTC → 2026-01-15 19:30 in Mexico City.
    expect(orgWallClockMinute(Date.UTC(2026, 0, 16, 1, 30, 0), 'America/Mexico_City')).toBe(
      '2026-01-15T19:30',
    )
  })

  it('is lexicographically comparable to a slot date||T||time', () => {
    // A slot at 2026-01-15T20:00 is still sellable when "now" (threshold) is 19:30 local.
    const threshold = orgWallClockMinute(Date.UTC(2026, 0, 16, 1, 30, 0), 'America/Mexico_City')
    expect('2026-01-15T20:00' > threshold).toBe(true)
    expect('2026-01-15T19:00' > threshold).toBe(false)
  })
})
