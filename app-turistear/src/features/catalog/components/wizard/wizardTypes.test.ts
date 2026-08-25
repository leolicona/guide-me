import { describe, it, expect } from 'vitest'
import { totalSteps, stepTitle } from './wizardTypes'
import { stepFields } from './wizardSchema'

// US-A91 — the step machinery is where "attaching a unit is a different act from creating a
// property" becomes mechanical. Asserted here rather than through the DOM: these are pure
// functions, and the claim is about which steps EXIST, not how they render.

describe('step machinery (US-A59 · US-A91)', () => {
  it('keeps the slot track at four steps whatever the mode', () => {
    expect(totalSteps('tours')).toBe(4)
    expect(totalSteps('tours', 'attach')).toBe(4)
    expect(totalSteps('dining')).toBe(4)
    // The pre-selection empty state defaults to the common slot model.
    expect(totalSteps('')).toBe(4)
  })

  it('creating a lodging property is three steps, ending in Comisión', () => {
    expect(totalSteps('lodging')).toBe(3)
    expect(stepTitle('lodging', 2)).toBe('Unidades')
    expect(stepTitle('lodging', 3)).toBe('Comisión')
  })

  it('attaching to an existing property is two steps, with NO Comisión step', () => {
    expect(totalSteps('lodging', 'attach')).toBe(2)
    expect(stepTitle('lodging', 2, 'attach')).toBe('Unidades')
    // D7 — the step that would rewrite the property's service-level commission does not exist.
    expect(stepTitle('lodging', 3, 'attach')).toBe('')
  })

  it('attach mode never validates `name` — it belongs to a property being created', () => {
    expect(stepFields('lodging', 1)).toContain('name')
    expect(stepFields('lodging', 1, 'attach')).toEqual(['category'])
    // …and never the commission fields, which live on the service.
    expect(stepFields('lodging', 3)).toEqual(['commission_type', 'commission_value'])
    expect(stepFields('lodging', 3, 'attach')).toEqual([])
  })

  it('leaves the slot track’s step fields untouched', () => {
    expect(stepFields('tours', 1)).toEqual(['name', 'category'])
    expect(stepFields('tours', 2)).toEqual([
      'base_price',
      'minimum_price',
      'commission_type',
      'commission_value',
    ])
  })
})
