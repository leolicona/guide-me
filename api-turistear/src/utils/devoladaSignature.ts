import { getSigningKeys, type DevoladaJwk } from '../services/devolada'

// devolada-transfer-verification D4 — proving that a webhook came from Devolada.
//
// `Devolada-Signature: v1=<base64url, no padding>` is an ES256 signature (ECDSA P-256 over SHA-256,
// raw r‖s, 64 bytes) of `${Devolada-Timestamp}.${raw body}`, made with the key whose `kid` is
// `Devolada-Key-Id` in Devolada's public key set. The set is cached per isolate by `kid`, for the
// max-age its Cache-Control gives. An unknown `kid` refetches the set once, as Devolada's contract
// says, and at most once a minute per isolate: a forged request with a random `kid` cannot make
// every webhook call Devolada. The set is fetched only through services/devolada.ts (D5).
//
// The signature proves Devolada sent the message, not which business it concerns: the webhook
// still resolves the organization by the link id and re-reads with that organization's own
// credential (D4, D21).

/** Devolada's key set could not be fetched: the webhook answers 503 so Devolada retries (D4). */
export class DevoladaUnavailableError extends Error {
  constructor() {
    super("Devolada's signing keys are unavailable")
    this.name = 'DevoladaUnavailableError'
  }
}

const REFETCH_INTERVAL_MS = 60_000

let cachedKeys = new Map<string, CryptoKey>()
let cacheExpiresAt = 0
let lastFetchAt = 0

/** Empties this isolate's key cache and its refetch throttle. The test fake calls it per install. */
export const resetSigningKeyCache = (): void => {
  cachedKeys = new Map()
  cacheExpiresAt = 0
  lastFetchAt = 0
}

const importKey = (jwk: DevoladaJwk): Promise<CryptoKey> =>
  crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  )

// Refetches the set unless it was fetched less than a minute ago. Throws when Devolada cannot be
// reached; answers false when the throttle held the call back.
const refresh = async (env: Pick<CloudflareBindings, 'DEVOLADA_API_BASE_URL'>): Promise<boolean> => {
  const now = Date.now()
  if (lastFetchAt && now >= lastFetchAt && now - lastFetchAt < REFETCH_INTERVAL_MS) return false
  lastFetchAt = now
  const set = await getSigningKeys(env)
  if (!set.ok) throw new DevoladaUnavailableError()
  const next = new Map<string, CryptoKey>()
  for (const jwk of set.keys) {
    try {
      next.set(jwk.kid, await importKey(jwk))
    } catch {
      // A key this runtime cannot import verifies nothing; the others still do.
    }
  }
  cachedKeys = next
  cacheExpiresAt = now + set.maxAge * 1000
  return true
}

const keyFor = async (
  env: Pick<CloudflareBindings, 'DEVOLADA_API_BASE_URL'>,
  kid: string,
): Promise<CryptoKey | null> => {
  const cached = cachedKeys.get(kid)
  if (cached && Date.now() < cacheExpiresAt) return cached
  let refreshed: boolean
  try {
    refreshed = await refresh(env)
  } catch (err) {
    // Past its max-age, a key Devolada still lists for 7 days after retiring it beats no key.
    if (cached) return cached
    throw err
  }
  // A fresh set is the truth; a throttled refetch keeps what the isolate already had.
  return cachedKeys.get(kid) ?? (refreshed ? null : (cached ?? null))
}

const b64urlToBytes = (s: string): Uint8Array | null => {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  try {
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
    return Uint8Array.from(bin, (c) => c.charCodeAt(0))
  } catch {
    return null
  }
}

export interface DevoladaSignatureInput {
  timestamp: string | null | undefined
  keyId: string | null | undefined
  signatureHeader: string | null | undefined
  rawBody: string
}

/**
 * True only when the signature verifies against Devolada's key named by `keyId`. Any malformed
 * input is false. Throws `DevoladaUnavailableError` when the key set is needed and unreachable.
 */
export async function verifyDevoladaSignature(
  env: Pick<CloudflareBindings, 'DEVOLADA_API_BASE_URL'>,
  { timestamp, keyId, signatureHeader, rawBody }: DevoladaSignatureInput,
): Promise<boolean> {
  if (!timestamp || !keyId || !signatureHeader) return false
  if (!signatureHeader.startsWith('v1=')) return false
  const signature = b64urlToBytes(signatureHeader.slice(3))
  if (!signature || signature.length !== 64) return false

  const key = await keyFor(env, keyId)
  if (!key) return false
  try {
    return await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      signature,
      new TextEncoder().encode(`${timestamp}.${rawBody}`),
    )
  } catch {
    return false
  }
}
