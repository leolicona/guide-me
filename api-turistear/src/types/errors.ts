export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'EMAIL_ALREADY_EXISTS'
  | 'IDENTITY_ALREADY_EXISTS'
  | 'INVALID_TOKEN'
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
  // BUG-030 — cancelling while a transfer awaits verification would run the ladder over money the
  // company never confirmed and mint a refund PIN for it. Verify or reject the payment first.
  | 'PAYMENT_UNVERIFIED'
  | 'SERVICE_INACTIVE'
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
  // A cancelled sale refused by a write that needs it alive. In use before it was declared
  // (devolada-transfer-verification research defect 9); the resolve endpoint raises it too.
  | 'FOLIO_CANCELLED'
  // A settlement refused (US-AG07, US-AG54): in use before they were declared (research defect 9),
  // declared now that the settle core shared with Devolada raises them (devolada D8).
  | 'ALREADY_SETTLED'
  | 'BOOKING_EXPIRED'
  | 'FOLIO_LINE_NOT_FOUND'
  | 'LINE_ALREADY_CANCELLED'
  | 'LINE_ALREADY_PAID'
  // Automatic transfer verification with Devolada (specs/006-devolada-transfer-verification
  // FR-023; contracts/turistear-api.md § Error codes). Connecting (D2, D3):
  | 'DEVOLADA_CREDENTIAL_REJECTED'
  | 'DEVOLADA_MODE_NOT_ALLOWED'
  | 'DEVOLADA_CHANNEL_UNAVAILABLE'
  | 'DEVOLADA_BUSINESS_SUSPENDED'
  | 'DEVOLADA_WEBHOOK_CONFLICT'
  // Devolada unreachable, timed out or answered 5xx: 502 on connect, 503 on the webhook (D4, D5).
  | 'DEVOLADA_UNAVAILABLE'
  // The admin's resolve action does not apply to that payment now (D15).
  | 'DEVOLADA_PAYMENT_NOT_RESOLVABLE'
  // The public webhook (D4): a signature that does not verify, or a malformed/oversized body.
  | 'WEBHOOK_SIGNATURE_INVALID'
  | 'WEBHOOK_PAYLOAD_INVALID'
  // An apartado's balance is being collected by a settlement enlace (D8, D13).
  | 'SETTLEMENT_IN_PROGRESS'
  // Never an HTTP error: the link would stay open less than 15 minutes, so none was created at
  // Devolada. It only travels as `payment_link_error` (D7).
  | 'PAYMENT_LINK_TOO_SHORT'

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
