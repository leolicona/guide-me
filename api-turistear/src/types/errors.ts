export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'EMAIL_ALREADY_EXISTS'
  | 'IDENTITY_ALREADY_EXISTS'
  | 'INVALID_TOKEN'
  | 'INVALID_CREDENTIALS'
  | 'EMAIL_NOT_VERIFIED'
  | 'ACCOUNT_SUSPENDED'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'PRICE_BELOW_MINIMUM'
  | 'SLOT_UNAVAILABLE'
  | 'SLOT_CLOSED'
  | 'DOWN_PAYMENT_BELOW_MINIMUM'
  | 'SERVICE_INACTIVE'
  | 'SERVICE_NOT_ALLOWED'
  | 'SERVICE_HAS_FOLIOS'
  // Accommodation/lodging (docs/lodging/accommodation-stays.spec.md §4.6, v2) — introduced &
  // consumed by this feature (see docs/TECH_DEBT.md). INSUFFICIENT_INVENTORY replaced the v1
  // UNIT_UNAVAILABLE when the per-unit overlap guard became the per-night count guard (D10).
  | 'INSUFFICIENT_INVENTORY'
  | 'SEASON_OVERLAP'
  | 'MIN_STAY_NOT_MET'
  | 'ALREADY_INVITED'
  | 'DROP_EXCEEDS_BALANCE'
  | 'INTERNAL_ERROR'

export class ApiError extends Error {
  readonly code: ErrorCode
  readonly status: number

  constructor(code: ErrorCode, status: number, message: string) {
    super(message)
    this.code = code
    this.status = status
    this.name = 'ApiError'
  }
}
