import { http, HttpResponse } from 'msw'

// Mirrors src/services/foliosService.ts. Shapes follow api-turistear/test/folios/*.test.ts and
// test/paid-ledger/*.test.ts.

export const aFolio = (over: Record<string, unknown> = {}) => ({
  id: 'folio-1',
  agent: { id: 'agent-1', name: 'Ana' },
  customer_name: 'Cliente Uno',
  customer_phone: '9981234567',
  status: 'paid',
  total: 150_000,
  amount_paid: 150_000,
  created_at: 1_800_000_000,
  cancelled_at: null,
  ...over,
})

export const aCancellationRequest = (over: Record<string, unknown> = {}) => ({
  id: 'req-1',
  folio_id: 'folio-1',
  status: 'pending',
  requested_at: 1_800_000_000,
  ...over,
})

/** US-A84 — the pending-work counts, all zero by default so a test opts INTO having work. */
export const aFolioCounts = (over: Partial<Record<string, number>> = {}) => ({
  verification: 0,
  cancellation_requests: 0,
  refunds: 0,
  overdue: 0,
  undelivered: 0,
  ...over,
})

export const folioHandlers = [
  // US-A84 — `window_days` rides along with the rows: the list is a union, and the screen says so.
  http.get('/api/folios', () => HttpResponse.json({ folios: [aFolio()], window_days: 30 })),
  // Registered BEFORE `/api/folios/:id` so the literal route is not swallowed by the param one.
  http.get('/api/folios/counts', () => HttpResponse.json(aFolioCounts())),
  http.get('/api/folios/cancellation-requests', () =>
    HttpResponse.json({ requests: [aCancellationRequest()] }),
  ),
  http.get('/api/folios/:id', () =>
    HttpResponse.json({ folio: aFolio(), cancellation_quote: null }),
  ),
  // The realised numbers live under `cancellation`, which the service unwraps to
  // { folio, cancellation } — see foliosService.cancelFolio.
  http.post('/api/folios/:id/cancel', () =>
    HttpResponse.json({
      folio: aFolio({ status: 'cancelled', cancelled_at: 1_800_000_100 }),
      cancellation: {
        refund: 120_000,
        retention: 30_000,
        kept_commission: 0,
        reversed_commission: 15_000,
      },
    }),
  ),
  http.post('/api/folios/cancellation-requests/:id/approve', () =>
    HttpResponse.json({ request: aCancellationRequest({ status: 'approved' }) }),
  ),
  http.post('/api/folios/cancellation-requests/:id/reject', () =>
    HttpResponse.json({ request: aCancellationRequest({ status: 'rejected' }) }),
  ),
  http.post('/api/folios/:id/refund/confirm', () =>
    HttpResponse.json({ folio: aFolio({ status: 'cancelled' }) }),
  ),
]
