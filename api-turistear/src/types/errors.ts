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
  // US-A77 — an apartado opened too close to departure. Distinct from SLOT_CLOSED, which is the
  // sales cutoff and applies to every folio: this one rejects only the DEPOSIT path, so the agent
  // can still sell the same slot by collecting the full amount.
  | 'BOOKING_TOO_LATE'
  | 'SERVICE_INACTIVE'
  | 'SERVICE_NOT_ALLOWED'
  | 'SERVICE_HAS_FOLIOS'
  // Accommodation/lodging (docs/lodging/accommodation-stays.spec.md §4.6, v2) — introduced &
  // consumed by this feature (see docs/TECH_DEBT.md). INSUFFICIENT_INVENTORY replaced the v1
  // UNIT_UNAVAILABLE when the per-unit overlap guard became the per-night count guard (D10).
  | 'INSUFFICIENT_INVENTORY'
  | 'SEASON_OVERLAP'
  | 'MIN_STAY_NOT_MET'
  // Zoned Capacity (US-A64 — docs/catalog/zoned-capacity.spec.md). A sale into a physical zone
  // (Turibus deck) whose snapshotted per-departure seats are exhausted. Introduced & consumed by
  // this feature: thrown by confirmSale's atomic zone guard, asserted by the zoned-capacity tests.
  | 'ZONE_UNAVAILABLE'
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
