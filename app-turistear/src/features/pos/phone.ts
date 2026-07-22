// Phone normalization — the single source of truth for turning an agent-typed phone into a
// wa.me-ready international number, and for the checkout's "is this sendable?" gate.
//
// Spec: docs/whatsapp-qr-delivery/spec.md — D3. WhatsApp deep links (wa.me/<number>) need a full
// international number in digits (no '+'). The default country code is +52 (Mexico): a bare
// 10-digit local number gets 52 prepended; a number that already carries a country code (≥ 11
// digits) is kept as-is. This also fixes the recovery flow (BookingWhatsAppButton), which
// previously stripped formatting with NO country code — misrouting local numbers on wa.me.

const DEFAULT_COUNTRY_CODE = '52' // Mexico

export interface NormalizedPhone {
  /** Digits only, country-code-prefixed — drop straight into `wa.me/<e164>`. '' when unusable. */
  e164: string
  /** True when the input yields a plausibly dialable international number (E.164: 11–15 digits). */
  valid: boolean
}

/** Normalize a user-typed phone to a wa.me-ready number. See file header for the +52 rule. */
export function normalizePhone(raw: string | null | undefined): NormalizedPhone {
  const digits = (raw ?? '').replace(/\D/g, '')
  if (digits.length === 0) return { e164: '', valid: false }
  // A bare 10-digit number is a local MX number → prepend the default country code. Anything
  // longer is assumed to already include its country code (e.g. '52…', '1305…').
  const e164 = digits.length === 10 ? `${DEFAULT_COUNTRY_CODE}${digits}` : digits
  const valid = e164.length >= 11 && e164.length <= 15
  return { e164, valid }
}

/** Gate convenience: does this input normalize to a sendable number? */
export const isSendablePhone = (raw: string | null | undefined): boolean =>
  normalizePhone(raw).valid
