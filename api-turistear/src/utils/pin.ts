// Operator PIN → auth-service secret (US-OP01/OP02).
//
// Operators authenticate with a 4-digit PIN, but the agnostic-auth /auth/hash + /auth/verify-password
// endpoints enforce a PASSWORD policy — a bare PIN is rejected (too short / a common password →
// 400 → a 502 for us). Rather than fork in a second hasher, we wrap the PIN into a policy-satisfying
// secret and hash THAT through the same service:
//
//   secret = hex( SHA-256( QR_SECRET + "::gm-op-pin::" + pin ) )   → 64 hex chars
//
// The result is long, uncommon (clears any length/blocklist policy), and PEPPERED with the app
// secret (QR_SECRET, never stored in the DB). So even if the affiliate_operators rows leak, the
// tiny 10^4 PIN space cannot be brute-forced offline without the app secret. The identical
// derivation runs on verify. Deterministic: same PIN + secret ⇒ same string.

const enc = new TextEncoder()

export const derivePinSecret = async (
  env: CloudflareBindings,
  pin: string,
): Promise<string> => {
  const data = enc.encode(`${env.QR_SECRET}::gm-op-pin::${pin}`)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
