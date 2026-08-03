import { describe, it, expect } from 'vitest'
import { affiliateCompanySchema } from './schemas'

// The CompanyInfoSheet: contact fields are OPTIONAL (empty maps to null at save), but a non-empty
// email must be valid. That "empty or valid, never half-typed" rule is the whole point of the file.
describe('affiliateCompanySchema', () => {
  const valid = { name: 'Hotel Maya', contact_email: 'contacto@maya.mx', contact_phone: '9981234567' }

  it('accepts a fully filled company', () => {
    expect(affiliateCompanySchema.safeParse(valid).success).toBe(true)
  })

  it('accepts blank contact fields — they are optional', () => {
    expect(
      affiliateCompanySchema.safeParse({ name: 'Hotel Maya', contact_email: '', contact_phone: '' })
        .success,
    ).toBe(true)
  })

  it('rejects a non-empty but malformed email', () => {
    const result = affiliateCompanySchema.safeParse({ ...valid, contact_email: 'contacto@' })
    expect(result.success).toBe(false)
    expect(result.error?.issues.map((i) => i.path.join('.'))).toContain('contact_email')
  })

  it('treats a whitespace-only email as blank, not as malformed', () => {
    // `.trim()` runs before the refine, so "   " becomes "" and passes the empty branch.
    const result = affiliateCompanySchema.safeParse({ ...valid, contact_email: '   ' })
    expect(result.success).toBe(true)
    expect(result.data?.contact_email).toBe('')
  })

  it('requires a name, and rejects one that is only whitespace', () => {
    expect(affiliateCompanySchema.safeParse({ ...valid, name: '' }).success).toBe(false)
    expect(affiliateCompanySchema.safeParse({ ...valid, name: '   ' }).success).toBe(false)
  })

  it('trims what it stores, so a padded name is saved clean', () => {
    const result = affiliateCompanySchema.safeParse({ ...valid, name: '  Hotel Maya  ' })
    expect(result.data?.name).toBe('Hotel Maya')
  })
})
