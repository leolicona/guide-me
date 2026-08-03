import { describe, it, expect } from 'vitest'
import {
  registerSchema,
  loginSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  inviteCompleteSchema,
} from './schemas'

// Form schemas gate every auth screen. Assert the ISSUE PATH, not just that parsing threw — the
// path is what puts the message under the right field, and a wrong path is a silent form.
const issuePaths = (result: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }) =>
  result.error?.issues.map((i) => i.path.join('.')) ?? []

const validRegister = {
  name: 'Ana López',
  email: 'ana@example.com',
  password: 'contrasena8',
  company_name: 'Tours del Caribe',
  phone: '9981234567',
}

describe('registerSchema', () => {
  it('accepts a complete registration', () => {
    expect(registerSchema.safeParse(validRegister).success).toBe(true)
  })

  it.each([
    ['name', ''],
    ['company_name', ''],
    ['phone', ''],
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

  it('enforces the 8-character password floor at the boundary', () => {
    expect(registerSchema.safeParse({ ...validRegister, password: '1234567' }).success).toBe(false)
    expect(registerSchema.safeParse({ ...validRegister, password: '12345678' }).success).toBe(true)
  })

  it('rejects a missing field rather than coercing it', () => {
    const withoutPhone: Record<string, unknown> = { ...validRegister }
    delete withoutPhone.phone
    expect(registerSchema.safeParse(withoutPhone).success).toBe(false)
  })
})

describe('loginSchema', () => {
  it('accepts an email and any non-empty password', () => {
    // Deliberately NOT the 8-char rule: an existing account may predate it, and enforcing the
    // floor at login would lock those users out of their own accounts.
    expect(loginSchema.safeParse({ email: 'ana@example.com', password: 'x' }).success).toBe(true)
  })

  it('rejects an empty password', () => {
    const result = loginSchema.safeParse({ email: 'ana@example.com', password: '' })
    expect(result.success).toBe(false)
    expect(issuePaths(result)).toContain('password')
  })

  it('rejects a malformed email', () => {
    expect(loginSchema.safeParse({ email: 'nope', password: 'x' }).success).toBe(false)
  })
})

describe('forgotPasswordSchema', () => {
  it('accepts a valid email and rejects anything else', () => {
    expect(forgotPasswordSchema.safeParse({ email: 'ana@example.com' }).success).toBe(true)
    expect(forgotPasswordSchema.safeParse({ email: '' }).success).toBe(false)
  })
})

describe('resetPasswordSchema', () => {
  const valid = { password: 'contrasena8', confirmPassword: 'contrasena8' }

  it('accepts a matching pair at the length floor', () => {
    expect(resetPasswordSchema.safeParse(valid).success).toBe(true)
  })

  it('puts the mismatch error on confirmPassword, where the user can see it', () => {
    const result = resetPasswordSchema.safeParse({ ...valid, confirmPassword: 'otracosa8' })
    expect(result.success).toBe(false)
    expect(issuePaths(result)).toContain('confirmPassword')
    expect(issuePaths(result)).not.toContain('password')
  })

  it('rejects a short password before ever comparing the pair', () => {
    const result = resetPasswordSchema.safeParse({ password: 'corto', confirmPassword: 'corto' })
    expect(result.success).toBe(false)
    expect(issuePaths(result)).toContain('password')
  })
})

describe('inviteCompleteSchema', () => {
  const valid = { name: 'Ana', password: 'contrasena8', confirmPassword: 'contrasena8' }

  it('accepts an invite without a position — the field is affiliate-only (US-AF01)', () => {
    expect(inviteCompleteSchema.safeParse(valid).success).toBe(true)
    expect(inviteCompleteSchema.safeParse({ ...valid, position: 'Recepción' }).success).toBe(true)
  })

  it('requires a name', () => {
    const result = inviteCompleteSchema.safeParse({ ...valid, name: '' })
    expect(result.success).toBe(false)
    expect(issuePaths(result)).toContain('name')
  })

  it('enforces the same confirmation rule as a reset', () => {
    const result = inviteCompleteSchema.safeParse({ ...valid, confirmPassword: 'distinta8' })
    expect(result.success).toBe(false)
    expect(issuePaths(result)).toContain('confirmPassword')
  })
})
