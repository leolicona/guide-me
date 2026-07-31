// Signed QR access tickets (HMAC-SHA256) for folio lines.
// Spec: docs/qr/folio-qr-signing.spec.md
//
// One ticket is minted per folio line at sale-confirm time. The token is a compact,
// URL-safe, offline-verifiable string: `<payload_b64url>.<signature_b64url>`, signed
// with a PER-ORGANIZATION key derived from a single app secret (QR_SECRET):
//
//   orgKey = HMAC-SHA256(QR_SECRET, "guideme:qr:v1:" + organizationId)
//
// Per-org keys mean a ticket minted for one org cannot verify under another's derived
// key — multitenancy enforced in the signature itself. Pure WebCrypto (crypto.subtle),
// available natively on the Workers runtime; no dependency.
//
// `verifyTicket` is exported for the Online QR Scanner feature (its production consumer)
// and is exercised here by this feature's unit tests — a signer is only meaningfully
// testable against its verifier.

const enc = new TextEncoder()
const dec = new TextDecoder()

// Reserved for a future versioned key-rotation scheme; bump alongside payload `v`.
// Historical label from the GuideMe era — kept verbatim: it feeds the HMAC key
// derivation, so changing it would invalidate every QR code already issued.
const KEY_LABEL_PREFIX = 'guideme:qr:v1:'

export interface TicketPayload {
  v: 1
  folio_id: string
  folio_line_id: string
  organization_id: string
  service_id: string
  slot_id: string
  client_identity: string
  passes_total: number
  issued_at: number // unix seconds
  expires_at: number // unix seconds
}

// --- base64url (no padding) ---

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

// US-T07 (docs/pos/express-sale.spec.md, D9) — the QR now ENCODES a URL, `${API_BASE_URL}/t/<token>`,
// so a tourist's plain camera resolves to their ticket page while the agent's scanner still redeems.
// The stored token is unchanged; this strips a URL wrapper (either origin — dev/prod) back to the
// raw token before verification, and passes a bare token through untouched, so every QR already in
// an inbox keeps scanning.
export const stripTicketUrl = (scanned: string): string => {
  const trimmed = scanned.trim()
  const match = /^https?:\/\/[^/]+\/t\/([^/?#\s]+)/i.exec(trimmed)
  return match ? match[1] : trimmed
}

// UNVERIFIED payload peek — for KEY SELECTION ONLY (the public /t/:token page has no caller org
// to derive from, so it reads organization_id out of the payload, derives that org's key, and
// then verifies properly — express-sale D12). Never trust any field from this before verifyTicket
// has passed.
export const peekTicketPayload = (token: string): TicketPayload | null => {
  const dot = token.indexOf('.')
  if (dot <= 0) return null
  try {
    return JSON.parse(dec.decode(b64urlToBytes(token.slice(0, dot)))) as TicketPayload
  } catch {
    return null
  }
}

// Derive the per-organization signing key from the app secret. The resulting key can
// both sign (issuance) and verify (scanner / tests).
export async function deriveOrgKey(
  secret: string,
  organizationId: string,
): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const raw = await crypto.subtle.sign(
    'HMAC',
    base,
    enc.encode(`${KEY_LABEL_PREFIX}${organizationId}`),
  )
  return crypto.subtle.importKey(
    'raw',
    raw,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
}

// Sign a ticket payload → `<payload_b64url>.<signature_b64url>`. HMAC is deterministic:
// the same payload + key always yields the same token.
export async function signTicket(
  payload: TicketPayload,
  key: CryptoKey,
): Promise<string> {
  const p = bytesToB64url(enc.encode(JSON.stringify(payload)))
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(p))
  return `${p}.${bytesToB64url(sig)}`
}

// Returns the payload iff the signature verifies under `key`; otherwise null (bad
// format, bad base64, signature mismatch, or unparseable payload). The signature is
// checked via crypto.subtle.verify (native compare) BEFORE the payload is trusted.
// Expiry / redemption are the caller's concern (the scanner feature), not checked here.
export async function verifyTicket(
  token: string,
  key: CryptoKey,
): Promise<TicketPayload | null> {
  const dot = token.indexOf('.')
  if (dot <= 0 || dot === token.length - 1) return null

  const p = token.slice(0, dot)
  let sig: Uint8Array
  try {
    sig = b64urlToBytes(token.slice(dot + 1))
  } catch {
    return null
  }

  let ok: boolean
  try {
    ok = await crypto.subtle.verify('HMAC', key, sig, enc.encode(p))
  } catch {
    return null
  }
  if (!ok) return null

  try {
    return JSON.parse(dec.decode(b64urlToBytes(p))) as TicketPayload
  } catch {
    return null
  }
}
