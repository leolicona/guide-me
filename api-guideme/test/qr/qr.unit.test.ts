import { describe, it, expect } from 'vitest'
import { env } from 'cloudflare:test'
import {
  deriveOrgKey,
  signTicket,
  verifyTicket,
  type TicketPayload,
} from '../../src/utils/qr'

// Unit tests for the signed-QR crypto util.
// Spec: docs/qr/folio-qr-signing.spec.md (Scenario 9 + the tamper/cross-key invariants
// behind Scenarios 3 and 4). Runs on the same workerd/Miniflare runtime as production,
// so crypto.subtle here is the real edge implementation.

const SECRET = env.QR_SECRET

const makePayload = (over: Partial<TicketPayload> = {}): TicketPayload => ({
  v: 1,
  folio_id: 'fol_1',
  folio_line_id: 'fl_1',
  organization_id: 'org_a',
  service_id: 'svc_1',
  slot_id: 'slot_1',
  client_identity: 'Jane Tourist',
  passes_total: 3,
  issued_at: 1_750_000_000,
  expires_at: 1_750_172_800,
  ...over,
})

// Replace one char with a different base64url char (stays in-alphabet, changes bytes).
const flipAt = (token: string, i: number): string => {
  const repl = token[i] === 'A' ? 'B' : 'A'
  return token.slice(0, i) + repl + token.slice(i + 1)
}

describe('qr signing util', () => {
  it('roundtrips: signTicket → verifyTicket returns the exact payload', async () => {
    const key = await deriveOrgKey(SECRET, 'org_a')
    const payload = makePayload()
    const token = await signTicket(payload, key)

    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
    const verified = await verifyTicket(token, key)
    expect(verified).toEqual(payload)
  })

  it('is deterministic: same payload + key yields the same token', async () => {
    const key = await deriveOrgKey(SECRET, 'org_a')
    const payload = makePayload()
    const a = await signTicket(payload, key)
    const b = await signTicket(payload, key)
    expect(a).toBe(b)
  })

  it('rejects a tampered payload segment', async () => {
    const key = await deriveOrgKey(SECRET, 'org_a')
    const token = await signTicket(makePayload(), key)
    const tampered = flipAt(token, 5) // inside the payload segment
    expect(tampered).not.toBe(token)
    expect(await verifyTicket(tampered, key)).toBeNull()
  })

  it('rejects a tampered signature segment', async () => {
    const key = await deriveOrgKey(SECRET, 'org_a')
    const token = await signTicket(makePayload(), key)
    const tampered = flipAt(token, token.length - 1) // last sig char
    expect(tampered).not.toBe(token)
    expect(await verifyTicket(tampered, key)).toBeNull()
  })

  it('does not verify under a different org-derived key (cross-org isolation)', async () => {
    const keyA = await deriveOrgKey(SECRET, 'org_a')
    const keyB = await deriveOrgKey(SECRET, 'org_b')
    const token = await signTicket(makePayload({ organization_id: 'org_a' }), keyA)
    expect(await verifyTicket(token, keyA)).not.toBeNull()
    expect(await verifyTicket(token, keyB)).toBeNull()
  })

  it('returns null for malformed tokens', async () => {
    const key = await deriveOrgKey(SECRET, 'org_a')
    for (const bad of ['', 'no-dot-here', '.onlysig', 'onlypayload.', 'a.b', '!!!.@@@']) {
      expect(await verifyTicket(bad, key)).toBeNull()
    }
  })
})
