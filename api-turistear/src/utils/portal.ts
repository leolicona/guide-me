// Tourist portal primitives (US-T01/T05): the folio-scoped access token and the Refund PIN.
// Spec: docs/tourist-portal/tourist-self-service-portal.spec.md (D3, D6)
//
// The portal token is a CAPABILITY, not an identity: it sits in a URL for weeks on a public
// surface, so it gets ≥128-bit entropy (32 random bytes → base64url) — deliberately stronger
// than the 1-hour password-reset UUID. The Refund PIN is a 6-digit crypto-random code whose
// whole purpose is proving the tourist was PRESENT to receive cash, so it lives only in the
// portal page (never in any email).

const bytesToB64url = (bytes: Uint8Array): string => {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// 32 random bytes → 43-char base64url URL secret (US-T01, D3).
export const generatePortalToken = (): string => {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return bytesToB64url(bytes)
}

// 6-digit crypto-random PIN, rejection-sampled to avoid modulo bias (D6/S19).
export const generateRefundPin = (): string => {
  const buf = new Uint32Array(1)
  // 4294967296 % 1000000 ≠ 0 — reject the top sliver so every PIN is equally likely.
  const limit = 4294967296 - (4294967296 % 1000000)
  let n: number
  do {
    crypto.getRandomValues(buf)
    n = buf[0]
  } while (n >= limit)
  return String(n % 1000000).padStart(6, '0')
}

const DAY_SECONDS = 86400
const POST_TRIP_GRACE_DAYS = 7
const MAX_LIFETIME_DAYS = 90

// Token lifetime (D3): end-of-day (UTC) of the LATEST slot date + 7 days, capped at 90 days
// from issuance. The tourist reopens the link to show QRs during the trip, so the token must
// outlive the last service. Falls back to the cap when no parseable slot date exists.
export const portalTokenExpiry = (slotDates: string[], now = new Date()): Date => {
  const cap = now.getTime() + MAX_LIFETIME_DAYS * DAY_SECONDS * 1000
  let latest = 0
  for (const d of slotDates) {
    const endOfDay = Date.parse(`${d}T23:59:59Z`)
    if (Number.isFinite(endOfDay) && endOfDay > latest) latest = endOfDay
  }
  if (latest === 0) return new Date(cap)
  const target = latest + POST_TRIP_GRACE_DAYS * DAY_SECONDS * 1000
  return new Date(Math.min(target, cap))
}
