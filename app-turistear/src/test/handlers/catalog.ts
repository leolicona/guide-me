import { http, HttpResponse } from 'msw'

// Mirrors src/services/{catalogService,schedulesService,zonesService,bookingsService}.ts.

export const aService = (over: Record<string, unknown> = {}) => ({
  id: 'svc-1',
  name: 'Tour Isla',
  base_price: 150_000,
  minimum_price: 120_000,
  category: 'tours',
  status: 'active',
  ...over,
})

export const catalogHandlers = [
  http.post('/api/services', () => HttpResponse.json({ service: aService() })),
  http.post('/api/services/:id/extras', () =>
    HttpResponse.json({ extra: { id: 'extra-1', name: 'Snorkel', price: 25_000 } }),
  ),
  http.post('/api/services/:id/slots', () =>
    HttpResponse.json({ slot: { id: 'slot-1', date: '2026-08-05', start_time: '09:00' } }),
  ),
  http.post('/api/services/:id/schedules', () =>
    HttpResponse.json({ schedule: { id: 'sch-1' }, created: 12 }),
  ),
  http.post('/api/services/:id/zones/enable', () =>
    HttpResponse.json({ zones: [{ id: 'z-1' }, { id: 'z-2' }] }),
  ),
  http.get('/api/services', () => HttpResponse.json({ services: [aService()] })),
]

export const bookingHandlers = [
  http.post('/api/pos/folios/:id/settle', () =>
    HttpResponse.json({ folio: { id: 'folio-1', status: 'paid' } }),
  ),
  http.post('/api/pos/folios/:id/cancel', () =>
    HttpResponse.json({ folio: { id: 'folio-1', status: 'cancelled' } }),
  ),
  http.post('/api/pos/folios/:id/reminder', () =>
    HttpResponse.json({ folio: { id: 'folio-1', reminder_status: 'sent' } }),
  ),
  http.post('/api/pos/folios/:id/verify', () =>
    HttpResponse.json({ folio: { id: 'folio-1', payment_verification: 'verified' } }),
  ),
  http.post('/api/pos/folios/:id/reject', () =>
    HttpResponse.json({ folio: { id: 'folio-1', status: 'cancelled' } }),
  ),
  http.post('/api/pos/folios/:id/ticket-delivery', () =>
    HttpResponse.json({ folio: { id: 'folio-1', tickets_sent_at: 1_800_000_000 } }),
  ),
  http.post('/api/folios/:id/ticket-delivery', () =>
    HttpResponse.json({ folio: { id: 'folio-1', tickets_sent_at: 1_800_000_000 } }),
  ),
]
