import { request } from './authService'
import type { ScanResult } from '../features/scanner/types'

// US-AG15 / US-AG17 — verify a scanned QR token and redeem one pass. Agent role only
// (enforced server-side). Always resolves to a ScanResult on a 200; a rejected promise
// means a request-level failure (network, auth, role, validation).
export const scanTicket = (token: string): Promise<ScanResult> =>
  request<ScanResult>('/api/tickets/scan', {
    method: 'POST',
    body: JSON.stringify({ token }),
  })
