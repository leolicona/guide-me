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
  | 'ALREADY_INVITED'
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
