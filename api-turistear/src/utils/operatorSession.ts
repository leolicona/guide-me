// Operator shift sessions (US-OP01/OP02, docs/affiliate-operators/spec.md).
//
// Operators are NOT `users` and don't go through the external agnostic-auth service. Instead an
// operator "shift" is a short-lived, stateless, HMAC-signed token carried in its own httpOnly
// cookie (`gm_op`): `<payload_b64url>.<signature_b64url>`, signed with the app secret (QR_SECRET)
// under a domain-separated label so it can never be confused with a QR ticket.
//
// The token only names the operator id + expiry; the middleware re-loads the operator row on every
// request and re-checks status='active', so a REMOVED operator's shift dies immediately regardless
// of the token's remaining lifetime (revocation without server-side session state).

const enc = new TextEncoder()
const dec = new TextDecoder()

// Domain separation from QR ticket signing (utils/qr.ts uses "guideme:qr:v1:").
const KEY_LABEL = 'guideme:op:v1'
export const OPERATOR_SESSION_TTL_SECONDS = 60 * 60 * 24 // 24h shift (D4)

interface OperatorSessionPayload {
  v: 1
  op: string // operator id
  exp: number // unix seconds
}

const bytesToB64url = (bytes: ArrayBuffer | Uint8Array): string => {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let binary = ''
  for (let i = 0; i < arr.length; i++) binary += String.fromCharCode(arr[i])
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const b64urlToBytes = (s: string): Uint8Array => {
  const norm = s.replace(/-/g, '+').replace(/_/g, '/')
  const pad = norm.length % 4 === 0 ? '' : '='.repeat(4 - (norm.length % 4))
  const binary = atob(norm + pad)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

const deriveKey = async (secret: string): Promise<CryptoKey> => {
  const base = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const raw = await crypto.subtle.sign('HMAC', base, enc.encode(KEY_LABEL))
  return crypto.subtle.importKey(
    'raw',
    raw,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
}

// Mint a 24h shift token for `operatorId`.
export const signOperatorSession = async (
  secret: string,
  operatorId: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<string> => {
  const payload: OperatorSessionPayload = {
    v: 1,
    op: operatorId,
    exp: now + OPERATOR_SESSION_TTL_SECONDS,
  }
  const key = await deriveKey(secret)
  const p = bytesToB64url(enc.encode(JSON.stringify(payload)))
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(p))
  return `${p}.${bytesToB64url(sig)}`
}

// Returns the operator id iff the token verifies AND is unexpired; otherwise null.
export const verifyOperatorSession = async (
  secret: string,
  token: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<string | null> => {
  const dot = token.indexOf('.')
  if (dot <= 0 || dot === token.length - 1) return null

  const p = token.slice(0, dot)
  let sig: Uint8Array
  try {
    sig = b64urlToBytes(token.slice(dot + 1))
  } catch {
    return null
  }

  const key = await deriveKey(secret)
  let ok: boolean
  try {
    ok = await crypto.subtle.verify('HMAC', key, sig, enc.encode(p))
  } catch {
    return null
  }
  if (!ok) return null

  let payload: OperatorSessionPayload
  try {
    payload = JSON.parse(dec.decode(b64urlToBytes(p))) as OperatorSessionPayload
  } catch {
    return null
  }
  if (payload.v !== 1 || typeof payload.op !== 'string') return null
  if (typeof payload.exp !== 'number' || payload.exp <= now) return null
  return payload.op
}
