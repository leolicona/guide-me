import { describe, it, expect } from 'vitest'
import {
  serviceFormSchema,
  extraFormSchema,
  unitFormSchema,
  seasonFormSchema,
  blockoutFormSchema,
  rangesOverlap,
  seasonOverlaps,
} from './schemas'
import { FLEX_CAP_MAX_PCT } from './types'

const issuePaths = (result: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }) =>
  result.error?.issues.map((i) => i.path.join('.')) ?? []

// Money is entered in MAJOR units here (the admin types $1500.00); the form converts to minor
// units on submit. So every amount below is pesos, not cents.
const tourService = {
  name: 'Tour Isla Mujeres',
  base_price: 1500,
  minimum_price: 1200,
  default_capacity: 20,
  commission_type: 'percent' as const,
  commission_value: 10,
  category: 'tours' as const,
  is_flexible: false,
  flex_capacity_pct: 0,
}

describe('serviceFormSchema', () => {
  it('accepts a well-formed tour', () => {
    expect(serviceFormSchema.safeParse(tourService).success).toBe(true)
  })

  it('requires a category — the dropdown starts empty and must not submit blank (US-A37)', () => {
    const result = serviceFormSchema.safeParse({ ...tourService, category: '' })
    expect(result.success).toBe(false)
    expect(issuePaths(result)).toContain('category')
  })

  it('rejects negative money', () => {
    expect(serviceFormSchema.safeParse({ ...tourService, base_price: -1 }).success).toBe(false)
    expect(serviceFormSchema.safeParse({ ...tourService, minimum_price: -1 }).success).toBe(false)
  })

  describe('the price floor', () => {
    it('rejects a minimum above base, reporting it on minimum_price', () => {
      const result = serviceFormSchema.safeParse({
        ...tourService,
        base_price: 1000,
        minimum_price: 1200,
      })
      expect(result.success).toBe(false)
      expect(issuePaths(result)).toContain('minimum_price')
    })

    it('accepts a minimum EQUAL to base — a service sold at a fixed price', () => {
      expect(
        serviceFormSchema.safeParse({ ...tourService, base_price: 1500, minimum_price: 1500 })
          .success,
      ).toBe(true)
    })

    it('does not apply to a unit-based category, whose floor lives on the unit', () => {
      // Lodging prices per night on its units, so a service-level minimum > base is meaningless
      // rather than wrong. Without this carve-out a lodging service becomes un-editable.
      expect(
        serviceFormSchema.safeParse({
          ...tourService,
          category: 'lodging',
          base_price: 0,
          minimum_price: 0,
        }).success,
      ).toBe(true)
    })
  })

  describe('commission', () => {
    it('caps a percent commission at 100', () => {
      expect(
        serviceFormSchema.safeParse({ ...tourService, commission_type: 'percent', commission_value: 100 })
          .success,
      ).toBe(true)
      const result = serviceFormSchema.safeParse({
        ...tourService,
        commission_type: 'percent',
        commission_value: 101,
      })
      expect(result.success).toBe(false)
      expect(issuePaths(result)).toContain('commission_value')
    })

    it('never lets a fixed commission exceed the price floor (D3) — that would sell at a loss', () => {
      const result = serviceFormSchema.safeParse({
        ...tourService,
        commission_type: 'fixed',
        commission_value: 1300, // floor is 1200
      })
      expect(result.success).toBe(false)
      expect(issuePaths(result)).toContain('commission_value')
    })

    it('accepts a fixed commission exactly at the floor', () => {
      expect(
        serviceFormSchema.safeParse({
          ...tourService,
          commission_type: 'fixed',
          commission_value: 1200,
        }).success,
      ).toBe(true)
    })

    it('exempts unit-based categories from the fixed-commission floor cap', () => {
      expect(
        serviceFormSchema.safeParse({
          ...tourService,
          category: 'lodging',
          minimum_price: 0,
          commission_type: 'fixed',
          commission_value: 500,
        }).success,
      ).toBe(true)
    })
  })

  describe('capacity mode (US-A36)', () => {
    it('requires at least 1% tolerance once Flexible is chosen', () => {
      const result = serviceFormSchema.safeParse({
        ...tourService,
        is_flexible: true,
        flex_capacity_pct: 0,
      })
      expect(result.success).toBe(false)
      expect(issuePaths(result)).toContain('flex_capacity_pct')
    })

    it('accepts the 1% and max boundaries', () => {
      expect(
        serviceFormSchema.safeParse({ ...tourService, is_flexible: true, flex_capacity_pct: 1 })
          .success,
      ).toBe(true)
      expect(
        serviceFormSchema.safeParse({
          ...tourService,
          is_flexible: true,
          flex_capacity_pct: FLEX_CAP_MAX_PCT,
        }).success,
      ).toBe(true)
    })

    it('rejects a tolerance above the cap', () => {
      const result = serviceFormSchema.safeParse({
        ...tourService,
        is_flexible: true,
        flex_capacity_pct: FLEX_CAP_MAX_PCT + 1,
      })
      expect(result.success).toBe(false)
      expect(issuePaths(result)).toContain('flex_capacity_pct')
    })

    it('ignores a zero tolerance when Hard Cap is selected', () => {
      expect(
        serviceFormSchema.safeParse({ ...tourService, is_flexible: false, flex_capacity_pct: 0 })
          .success,
      ).toBe(true)
    })

    it('requires a whole-number capacity of at least one', () => {
      expect(serviceFormSchema.safeParse({ ...tourService, default_capacity: 0 }).success).toBe(false)
      expect(serviceFormSchema.safeParse({ ...tourService, default_capacity: 1.5 }).success).toBe(false)
    })
  })
})

describe('extraFormSchema', () => {
  it('accepts a named, non-negative extra — including a free one', () => {
    expect(extraFormSchema.safeParse({ name: 'Snorkel', price: 250 }).success).toBe(true)
    expect(extraFormSchema.safeParse({ name: 'Agua', price: 0 }).success).toBe(true)
  })

  it('rejects a blank name or a negative price', () => {
    expect(extraFormSchema.safeParse({ name: '', price: 250 }).success).toBe(false)
    expect(extraFormSchema.safeParse({ name: 'Snorkel', price: -1 }).success).toBe(false)
  })
})

describe('unitFormSchema', () => {
  const validUnit = {
    name: 'Suite Caribe',
    inventory_count: 3,
    beds: 2,
    base_occupancy: 2,
    max_capacity: 4,
    base_rate: 2500,
    weekend_rate: null,
    extra_person_fee: 300,
    min_nights: 1,
    checkin_time: '15:00',
    checkout_time: '11:00',
    amenities: ['wifi', 'pool'],
    commission_type: 'inherit' as const,
    commission_value: null,
  }

  it('accepts a well-formed unit type inheriting its commission', () => {
    expect(unitFormSchema.safeParse(validUnit).success).toBe(true)
  })

  it('accepts a null weekend rate — "use base" is a real answer, not a missing one', () => {
    expect(unitFormSchema.safeParse({ ...validUnit, weekend_rate: null }).success).toBe(true)
    expect(unitFormSchema.safeParse({ ...validUnit, weekend_rate: 3200 }).success).toBe(true)
  })

  it('rejects a max capacity below the base occupancy', () => {
    const result = unitFormSchema.safeParse({ ...validUnit, base_occupancy: 4, max_capacity: 2 })
    expect(result.success).toBe(false)
    expect(issuePaths(result)).toContain('max_capacity')
  })

  it('accepts max capacity equal to base occupancy', () => {
    expect(
      unitFormSchema.safeParse({ ...validUnit, base_occupancy: 2, max_capacity: 2 }).success,
    ).toBe(true)
  })

  it.each(['inventory_count', 'beds', 'base_occupancy', 'min_nights'])(
    'requires %s to be a whole number of at least one',
    (field) => {
      expect(unitFormSchema.safeParse({ ...validUnit, [field]: 0 }).success).toBe(false)
      expect(unitFormSchema.safeParse({ ...validUnit, [field]: 1.5 }).success).toBe(false)
    },
  )

  it('rejects an unknown amenity key', () => {
    expect(unitFormSchema.safeParse({ ...validUnit, amenities: ['jacuzzi'] }).success).toBe(false)
    expect(unitFormSchema.safeParse({ ...validUnit, amenities: [] }).success).toBe(true)
  })

  describe('the commission waterfall', () => {
    it('demands a value once the unit stops inheriting', () => {
      const result = unitFormSchema.safeParse({
        ...validUnit,
        commission_type: 'percent',
        commission_value: null,
      })
      expect(result.success).toBe(false)
      expect(issuePaths(result)).toContain('commission_value')
    })

    it('caps a percent override at 100', () => {
      expect(
        unitFormSchema.safeParse({ ...validUnit, commission_type: 'percent', commission_value: 100 })
          .success,
      ).toBe(true)
      expect(
        unitFormSchema.safeParse({ ...validUnit, commission_type: 'percent', commission_value: 101 })
          .success,
      ).toBe(false)
    })

    it('ignores a stray value while inheriting rather than erroring', () => {
      expect(
        unitFormSchema.safeParse({ ...validUnit, commission_type: 'inherit', commission_value: 50 })
          .success,
      ).toBe(true)
    })
  })
})

describe('seasonFormSchema', () => {
  const valid = {
    name: 'Temporada alta',
    start_date: '2026-12-15',
    end_date: '2027-01-06',
    nightly_rate: 4200,
  }

  it('accepts a season crossing a year boundary', () => {
    expect(seasonFormSchema.safeParse(valid).success).toBe(true)
  })

  it('accepts a single-day season — seasons are inclusive on both ends', () => {
    expect(
      seasonFormSchema.safeParse({ ...valid, start_date: '2026-12-25', end_date: '2026-12-25' })
        .success,
    ).toBe(true)
  })

  it('rejects an end before the start', () => {
    const result = seasonFormSchema.safeParse({
      ...valid,
      start_date: '2027-01-06',
      end_date: '2026-12-15',
    })
    expect(result.success).toBe(false)
    expect(issuePaths(result)).toContain('end_date')
  })
})

describe('blockoutFormSchema', () => {
  const valid = { start_date: '2026-08-01', end_date: '2026-08-05', quantity: 1 }

  it('accepts a multi-day blockout', () => {
    expect(blockoutFormSchema.safeParse(valid).success).toBe(true)
  })

  // A blockout is exclusive where a season is inclusive: end MUST be strictly after start, because
  // a zero-night block would take rooms out of inventory for no nights at all.
  it('rejects a same-day blockout, unlike a season', () => {
    const result = blockoutFormSchema.safeParse({
      ...valid,
      start_date: '2026-08-01',
      end_date: '2026-08-01',
    })
    expect(result.success).toBe(false)
    expect(issuePaths(result)).toContain('end_date')
  })

  it('requires at least one room (D11)', () => {
    expect(blockoutFormSchema.safeParse({ ...valid, quantity: 0 }).success).toBe(false)
  })

  it('treats the reason as optional', () => {
    expect(blockoutFormSchema.safeParse({ ...valid, reason: 'Mantenimiento' }).success).toBe(true)
  })
})

describe('rangesOverlap / seasonOverlaps', () => {
  const range = (start_date: string, end_date: string) => ({ start_date, end_date })

  it('treats touching ranges as overlapping — both ends are inclusive', () => {
    expect(rangesOverlap(range('2026-08-01', '2026-08-10'), range('2026-08-10', '2026-08-20'))).toBe(
      true,
    )
  })

  it('treats adjacent ranges as clear', () => {
    expect(rangesOverlap(range('2026-08-01', '2026-08-09'), range('2026-08-10', '2026-08-20'))).toBe(
      false,
    )
  })

  it('is symmetric, and catches full containment either way round', () => {
    const outer = range('2026-08-01', '2026-08-31')
    const inner = range('2026-08-10', '2026-08-12')
    expect(rangesOverlap(outer, inner)).toBe(true)
    expect(rangesOverlap(inner, outer)).toBe(true)
  })

  it('flags a draft season that collides with an existing one', () => {
    const existing = [{ id: 's1', ...range('2026-12-15', '2027-01-06') }]
    expect(seasonOverlaps(range('2026-12-20', '2026-12-28'), existing)).toBe(true)
    expect(seasonOverlaps(range('2027-02-01', '2027-02-10'), existing)).toBe(false)
  })

  it('does not flag a season against itself while it is being edited', () => {
    const existing = [{ id: 's1', ...range('2026-12-15', '2027-01-06') }]
    expect(seasonOverlaps(range('2026-12-15', '2027-01-10'), existing, 's1')).toBe(false)
    // …but a DIFFERENT season in the same list still collides.
    expect(
      seasonOverlaps(range('2026-12-15', '2027-01-10'), [...existing, { id: 's2', ...range('2027-01-08', '2027-01-20') }], 's1'),
    ).toBe(true)
  })
})
