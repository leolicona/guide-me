// Server-side phone normalization — mirrors app-turistear/src/features/pos/phone.ts (D7 of
// docs/affiliate-operators/spec.md). We store operator phones in a canonical wa.me-ready form so
// the active-phone-uniqueness constraint compares apples to apples and the WhatsApp link is exact.
// Default country code is +52 (Mexico): a bare 10-digit local number gets 52 prepended; a longer
// number is assumed to already carry its country code.

const DEFAULT_COUNTRY_CODE = '52'

export interface NormalizedPhone {
  e164: string // digits only, country-code-prefixed; '' when unusable
  valid: boolean // true for a plausibly dialable international number (11–15 digits)
}

export const normalizePhone = (raw: string | null | undefined): NormalizedPhone => {
  const digits = (raw ?? '').replace(/\D/g, '')
  if (digits.length === 0) return { e164: '', valid: false }
  const e164 = digits.length === 10 ? `${DEFAULT_COUNTRY_CODE}${digits}` : digits
  const valid = e164.length >= 11 && e164.length <= 15
  return { e164, valid }
}
