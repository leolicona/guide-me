// devolada-transfer-verification US1 — only Devolada can tell us a transfer cleared: a webhook is
// trusted only once its signature verifies against Devolada's published keys (FR-013; research D4).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env } from 'cloudflare:test'
import {
  DevoladaUnavailableError,
  resetSigningKeyCache,
  verifyDevoladaSignature,
} from '../../src/utils/devoladaSignature'
import { installFakeDevolada, SIGNING_KEY_ID, type FakeDevolada } from '../helpers/devolada'

const BODY = JSON.stringify({ eventId: 'evt_1', type: 'payment.confirmed', createdAt: 1, data: {} })

const inputOf = async (req: Request) => ({
  timestamp: req.headers.get('Devolada-Timestamp'),
  keyId: req.headers.get('Devolada-Key-Id'),
  signatureHeader: req.headers.get('Devolada-Signature'),
  rawBody: await req.text(),
})

let fake: FakeDevolada
beforeEach(async () => {
  fake = await installFakeDevolada()
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.setSystemTime(new Date('2026-06-14T12:00:00Z'))
  resetSigningKeyCache()
})

describe('webhook signature (D4)', () => {
  it('a valid signature verifies', async () => {
    const input = await inputOf(await fake.signedRaw(BODY))
    expect(await verifyDevoladaSignature(env, input)).toBe(true)
  })

  it('an altered body or timestamp does not verify', async () => {
    const input = await inputOf(await fake.signedRaw(BODY))
    expect(await verifyDevoladaSignature(env, { ...input, rawBody: BODY.replace('evt_1', 'evt_2') })).toBe(false)
    expect(await verifyDevoladaSignature(env, { ...input, timestamp: `${input.timestamp}1` })).toBe(false)
    expect(await verifyDevoladaSignature(env, await inputOf(await fake.signedRaw(BODY, { tamperBody: true })))).toBe(
      true, // tamperBody only rewrites askedCents, which BODY does not carry
    )
    const tampered = await inputOf(
      await fake.signedRaw(JSON.stringify({ data: { askedCents: 100 } }), { tamperBody: true }),
    )
    expect(await verifyDevoladaSignature(env, tampered)).toBe(false)
  })

  it('a signature by a key Devolada never published does not verify', async () => {
    const input = await inputOf(await fake.signedRaw(BODY, { wrongKey: true }))
    expect(await verifyDevoladaSignature(env, input)).toBe(false)
  })

  it('an unknown kid fetches the key set once, then serves it from the cache', async () => {
    const input = await inputOf(await fake.signedRaw(BODY))
    expect(await verifyDevoladaSignature(env, input)).toBe(true)
    expect(await verifyDevoladaSignature(env, input)).toBe(true)
    expect(await verifyDevoladaSignature(env, input)).toBe(true)
    expect(fake.callsTo('jwks')).toHaveLength(1)
  })

  it('a burst of unknown kids refetches the key set at most once a minute', async () => {
    const input = await inputOf(await fake.signedRaw(BODY))
    for (let i = 0; i < 5; i += 1) {
      expect(await verifyDevoladaSignature(env, { ...input, keyId: `forged-${i}` })).toBe(false)
    }
    expect(fake.callsTo('jwks')).toHaveLength(1)
    // The published kid was in that one fetch, so it still verifies without another call.
    expect(await verifyDevoladaSignature(env, input)).toBe(true)
    expect(fake.callsTo('jwks')).toHaveLength(1)

    vi.setSystemTime(new Date('2026-06-14T12:01:01Z'))
    expect(await verifyDevoladaSignature(env, { ...input, keyId: 'forged-later' })).toBe(false)
    expect(fake.callsTo('jwks')).toHaveLength(2)
  })

  it('a malformed header is false, without calling Devolada', async () => {
    const input = await inputOf(await fake.signedRaw(BODY))
    for (const bad of [
      { ...input, signatureHeader: input.signatureHeader!.slice(3) }, // no v1=
      { ...input, signatureHeader: 'v2=' + input.signatureHeader!.slice(3) },
      { ...input, signatureHeader: 'v1=not base64!' },
      { ...input, signatureHeader: 'v1=AAAA' }, // not 64 bytes
      { ...input, signatureHeader: null },
      { ...input, timestamp: null },
      { ...input, keyId: '' },
    ]) {
      expect(await verifyDevoladaSignature(env, bad)).toBe(false)
    }
    expect(fake.callsTo('jwks')).toHaveLength(0)
  })

  it('an unreachable key set throws DevoladaUnavailableError, so the webhook answers 503', async () => {
    const input = await inputOf(await fake.signedRaw(BODY))
    fake.failNext('jwks', 'unreachable')
    await expect(verifyDevoladaSignature(env, input)).rejects.toBeInstanceOf(DevoladaUnavailableError)
    // A minute later Devolada answers again, and the same delivery verifies.
    vi.setSystemTime(new Date('2026-06-14T12:01:01Z'))
    expect(await verifyDevoladaSignature(env, input)).toBe(true)
    expect(input.keyId).toBe(SIGNING_KEY_ID)
  })
})
