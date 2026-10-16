// devolada-transfer-verification US1 — an organization's Devolada key is stored so that reading
// the database alone never reveals it (FR-003; research D1, D17).
import { describe, it, expect } from 'vitest'
import { env } from 'cloudflare:test'
import {
  DevoladaCredentialKeyError,
  canStoreCredentials,
  decryptCredential,
  encryptCredential,
  keyHint,
} from '../../src/utils/devoladaCredential'

const KEY = 'dk_0123456789abcdef0123456789abcdef'
const ORG_A = 'org-a'
const ORG_B = 'org-b'
// Another valid secret: 32 bytes, base64.
const OTHER_SECRET = btoa('another_devolada_credential_k_32')

describe('devolada credential cipher (D1)', () => {
  it('round-trips the key', async () => {
    const sealed = await encryptCredential(env, ORG_A, KEY)
    expect(sealed.ciphertext).not.toContain(KEY)
    expect(await decryptCredential(env, ORG_A, sealed)).toBe(KEY)
  })

  it('takes a fresh IV per write, so two encryptions of one key differ', async () => {
    const one = await encryptCredential(env, ORG_A, KEY)
    const two = await encryptCredential(env, ORG_A, KEY)
    expect(one.iv).not.toBe(two.iv)
    expect(one.ciphertext).not.toBe(two.ciphertext)
    expect(await decryptCredential(env, ORG_A, two)).toBe(KEY)
  })

  it("does not decrypt as another organization: a row copied across tenants is unreadable (constitution III)", async () => {
    const sealed = await encryptCredential(env, ORG_A, KEY)
    await expect(decryptCredential(env, ORG_B, sealed)).rejects.toThrow()
  })

  it('does not decrypt under another environment secret (D17)', async () => {
    const sealed = await encryptCredential(env, ORG_A, KEY)
    await expect(
      decryptCredential({ DEVOLADA_CREDENTIAL_KEY: OTHER_SECRET }, ORG_A, sealed),
    ).rejects.toThrow()
  })

  it('throws without a secret, or with one that is not 32 bytes of base64 (D17)', async () => {
    expect(canStoreCredentials(env)).toBe(true)
    for (const secret of ['', 'not-base64!', btoa('too short')]) {
      expect(canStoreCredentials({ DEVOLADA_CREDENTIAL_KEY: secret })).toBe(false)
      await expect(
        encryptCredential({ DEVOLADA_CREDENTIAL_KEY: secret }, ORG_A, KEY),
      ).rejects.toBeInstanceOf(DevoladaCredentialKeyError)
    }
    const sealed = await encryptCredential(env, ORG_A, KEY)
    await expect(
      decryptCredential({ DEVOLADA_CREDENTIAL_KEY: '' }, ORG_A, sealed),
    ).rejects.toBeInstanceOf(DevoladaCredentialKeyError)
  })

  it('keyHint returns the last four characters only', () => {
    expect(keyHint(KEY)).toBe('cdef')
  })
})
