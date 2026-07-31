// Online QR Scanner types. The scan endpoint always returns 200 with this shape; the
// ✓/✗ outcome is data, not an HTTP error. Spec: docs/scanner/online-qr-scanner.spec.md.

export type ScanReason =
  | 'INVALID_SIGNATURE'
  | 'EXPIRED'
  | 'ALREADY_CONSUMED'
  | 'CANCELLED'
  | 'NOT_PAID'
  | 'NOT_FOUND'

export interface ScannedTicket {
  client_identity: string
  service_name: string | null
  slot_date: string | null
  slot_start_time: string | null
  passes_total: number | null
  redeemed_count: number | null
  /** Present only on a valid PER-PASS scan: the pass just consumed (= redeemed_count). */
  pass_number?: number
  /** US-AG48 — present only on a valid ALL-PASSES scan: how many passes THIS scan took (the
   * whole remainder). Mutually exclusive with pass_number (group-redemption D6). */
  redeemed_now?: number
}

export interface ScanResult {
  result: 'valid' | 'invalid'
  /** Present only when `result === 'invalid'`. */
  reason?: ScanReason
  ticket: ScannedTicket | null
}
