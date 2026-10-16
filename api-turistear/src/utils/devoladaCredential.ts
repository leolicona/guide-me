// devolada-transfer-verification D1 — custody of an organization's Devolada API key.
//
// The key is stored encrypted (AES-256-GCM) so reading the database alone never reveals it
// (FR-003). The AES key is derived per organization from the Worker secret DEVOLADA_CREDENTIAL_KEY
// with the label pattern of utils/qr.ts (`HMAC-SHA256(secret, label + organizationId)`), and the
// organization id is also bound as GCM additional data: a ciphertext copied into another
// organization's row fails to decrypt (constitution III). Every write takes a fresh 96-bit IV.
//
// A dedicated secret, not QR_SECRET or BETTER_AUTH_SECRET: rotating either of those would make
// every stored credential unreadable too (D1). Without a readable secret the API fails closed (D17):
// these functions throw, and the callers fall back to the manual path. Nothing here ever logs the
// key, the secret or the ciphertext.

const enc = new TextEncoder()
const dec = new TextDecoder()

const KEY_LABEL_PREFIX = 'guideme:devolada:v1:'

/** DEVOLADA_CREDENTIAL_KEY is missing, or does not decode to 32 bytes (D17). */
export class DevoladaCredentialKeyError extends Error {
  constructor() {
    super('DEVOLADA_CREDENTIAL_KEY is missing or does not decode to 32 bytes')
    this.name = 'DevoladaCredentialKeyError'
  }
}

export interface EncryptedCredential {
  ciphertext: string
  iv: string
}

const bytesToB64url = (bytes: Uint8Array): string => {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const b64urlToBytes = (s: string): Uint8Array => {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}

/** The environment's 32-byte secret, or null when it is missing or malformed (D17). */
const secretBytes = (env: Pick<CloudflareBindings, 'DEVOLADA_CREDENTIAL_KEY'>): Uint8Array | null => {
  const raw = env.DEVOLADA_CREDENTIAL_KEY
  if (!raw) return null
  try {
    const bytes = Uint8Array.from(atob(raw.trim()), (c) => c.charCodeAt(0))
    return bytes.length === 32 ? bytes : null
  } catch {
    return null
  }
}

/** Whether this environment can encrypt and decrypt Devolada credentials at all (D17). */
export const canStoreCredentials = (env: Pick<CloudflareBindings, 'DEVOLADA_CREDENTIAL_KEY'>): boolean =>
  secretBytes(env) !== null

const deriveOrgKey = async (secret: Uint8Array, organizationId: string): Promise<CryptoKey> => {
  const base = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ])
  const raw = await crypto.subtle.sign('HMAC', base, enc.encode(`${KEY_LABEL_PREFIX}${organizationId}`))
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

export async function encryptCredential(
  env: Pick<CloudflareBindings, 'DEVOLADA_CREDENTIAL_KEY'>,
  organizationId: string,
  plaintext: string,
): Promise<EncryptedCredential> {
  const secret = secretBytes(env)
  if (!secret) throw new DevoladaCredentialKeyError()
  const key = await deriveOrgKey(secret, organizationId)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: enc.encode(organizationId) },
    key,
    enc.encode(plaintext),
  )
  return { ciphertext: bytesToB64url(new Uint8Array(sealed)), iv: bytesToB64url(iv) }
}

/**
 * The plaintext key. Throws `DevoladaCredentialKeyError` without a usable secret, and the
 * platform's decrypt error when the ciphertext was sealed under another secret or for another
 * organization: either way, this environment cannot read the credential (D17).
 */
export async function decryptCredential(
  env: Pick<CloudflareBindings, 'DEVOLADA_CREDENTIAL_KEY'>,
  organizationId: string,
  sealed: EncryptedCredential,
): Promise<string> {
  const secret = secretBytes(env)
  if (!secret) throw new DevoladaCredentialKeyError()
  const key = await deriveOrgKey(secret, organizationId)
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64urlToBytes(sealed.iv), additionalData: enc.encode(organizationId) },
    key,
    b64urlToBytes(sealed.ciphertext),
  )
  return dec.decode(plain)
}

/** The last four characters: the only part of a key the API ever returns (D1). */
export const keyHint = (apiKey: string): string => apiKey.slice(-4)
