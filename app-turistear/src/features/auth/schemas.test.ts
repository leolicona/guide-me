import { describe, it, expect } from 'vitest'
import {
  registerSchema,
  inviteCompleteSchema,
  emailCodeRequestSchema,
  emailCodeSchema,
  passkeyNameSchema,
} from './schemas'

// Form schemas gate every auth screen. Assert the ISSUE PATH, not just that parsing threw — the
// path is what puts the message under the right field, and a wrong path is a silent form.
//
// passkey-auth US1, US3, US4 — no schema asks for a password any more (FR-060); the password
// floors and confirmation rules left with the fields they guarded.
const issuePaths = (result: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }) =>
  result.error?.issues.map((i) => i.path.join('.')) ?? []

const validRegister = {
  name: 'Ana López',
  email: 'ana@example.com',
  company_name: 'Tours del Caribe',
  phone: '9981234567',
}

describe('registerSchema', () => {
  it('accepts a complete registration — with no password (passkey-auth US3)', () => {
    expect(registerSchema.safeParse(validRegister).success).toBe(true)
  })

  it.each([
    ['name', ''],
    ['company_name', ''],
    ['phone', ''],
    ['name', '   '],
  ])('rejects an empty %s', (field, value) => {
    const result = registerSchema.safeParse({ ...validRegister, [field]: value })
    expect(result.success).toBe(false)
    expect(issuePaths(result)).toContain(field)
  })

  it.each(['not-an-email', 'ana@', '@example.com', 'ana example.com', ''])(
    'rejects the malformed email %j',
    (email) => {
      const result = registerSchema.safeParse({ ...validRegister, email })
      expect(result.success).toBe(false)
      expect(issuePaths(result)).toContain('email')
    },
  )

  it('lowercases and trims the email at our edge (passkey-auth R11)', () => {
    const result = registerSchema.safeParse({ ...validRegister, email: '  Ana@Example.COM ' })
    expect(result.success && result.data.email).toBe('ana@example.com')
  })

  it('rejects a missing field rather than coercing it', () => {
    const withoutPhone: Record<string, unknown> = { ...validRegister }
    delete withoutPhone.phone
    expect(registerSchema.safeParse(withoutPhone).success).toBe(false)
  })
})

describe('inviteCompleteSchema', () => {
  it('accepts a name alone — no job title (retire-affiliates FR-004), no password (passkey-auth US4)', () => {
    expect(inviteCompleteSchema.safeParse({ name: 'Ana' }).success).toBe(true)
  })

  it('requires a name', () => {
    const result = inviteCompleteSchema.safeParse({ name: '' })
    expect(result.success).toBe(false)
    expect(issuePaths(result)).toContain('name')
  })
})

describe('emailCodeRequestSchema', () => {
  it('accepts an address and lowercases it (passkey-auth US1)', () => {
    const result = emailCodeRequestSchema.safeParse({ email: 'Luis@Ejemplo.MX' })
    expect(result.success && result.data.email).toBe('luis@ejemplo.mx')
  })

  it('rejects anything that is not an address', () => {
    const result = emailCodeRequestSchema.safeParse({ email: 'luis' })
    expect(issuePaths(result)).toContain('email')
  })
})

describe('emailCodeSchema', () => {
  it('accepts exactly six digits — Better Auth’s emailOTP length (passkey-auth D7)', () => {
    expect(emailCodeSchema.safeParse({ code: '012345' }).success).toBe(true)
  })

  it.each(['12345', '1234567', '12a456', ''])('rejects %j', (code) => {
    const result = emailCodeSchema.safeParse({ code })
    expect(result.success).toBe(false)
    expect(issuePaths(result)).toContain('code')
  })
})

describe('passkeyNameSchema', () => {
  it('accepts a name up to 50 characters (passkey-auth US5)', () => {
    expect(passkeyNameSchema.safeParse({ name: 'x'.repeat(50) }).success).toBe(true)
    expect(passkeyNameSchema.safeParse({ name: 'x'.repeat(51) }).success).toBe(false)
  })

  it('rejects a blank name', () => {
    const result = passkeyNameSchema.safeParse({ name: '   ' })
    expect(issuePaths(result)).toContain('name')
  })
})
