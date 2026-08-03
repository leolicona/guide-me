import { describe, it, expect } from 'vitest'
import { inviteAgentSchema, editAgentSchema } from './schemas'

describe('inviteAgentSchema', () => {
  it('accepts an email identity', () => {
    expect(inviteAgentSchema.safeParse({ identity: 'agente@example.com' }).success).toBe(true)
  })

  it.each(['agente', 'agente@', '', ' agente@example.com '])(
    'rejects the identity %j',
    (identity) => {
      expect(inviteAgentSchema.safeParse({ identity }).success).toBe(false)
    },
  )
})

describe('editAgentSchema', () => {
  it('accepts a name with or without a phone', () => {
    expect(editAgentSchema.safeParse({ name: 'Ana' }).success).toBe(true)
    expect(editAgentSchema.safeParse({ name: 'Ana', phone: '9981234567' }).success).toBe(true)
  })

  it('requires a name', () => {
    const result = editAgentSchema.safeParse({ name: '' })
    expect(result.success).toBe(false)
    expect(result.error?.issues.map((i) => i.path.join('.'))).toContain('name')
  })

  // Rev. 2026-06-11 — commission moved to the service (US-A12). An agent form that still carried a
  // rate would be the second source of truth this repo already paid for once.
  it('carries no commission field', () => {
    const parsed = editAgentSchema.parse({ name: 'Ana', phone: '9981234567' })
    expect(parsed).not.toHaveProperty('commission_rate')
    expect(Object.keys(parsed).sort()).toEqual(['name', 'phone'])
  })
})
