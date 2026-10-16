import { http, HttpResponse } from 'msw'

// devolada-transfer-verification — mirrors src/services/devoladaService.ts one to one. The shapes
// copy what api-turistear/test/devolada/connection.test.ts, checkout-link.test.ts and
// webhook.test.ts assert (constitution IV): a fixture no API test would produce is a fiction.

/** A connected test-mode connection, healthy, with no previous key still in use. */
export const aConnection = (over: Record<string, unknown> = {}) => ({
  status: 'connected',
  mode: 'test',
  key_hint: 'a1b2',
  connected_at: 1_800_000_000,
  connected_by: { id: 'admin-1', name: 'Ana Ruiz' },
  broken_reason: null,
  last_verdict_at: null,
  credit_paused_since: null,
  previous_keys: [],
  webhook: {
    url: 'https://api.turistearya.com/api/webhooks/devolada',
    is_ours: true,
    consecutive_failures: 0,
    last_success_at: null,
    last_failure_at: null,
    failed_deliveries: 0,
  },
  health_error: null,
  ...over,
})

/** A sale's open payment link, waiting for its first payment. */
export const aPaymentLink = (over: Record<string, unknown> = {}) => ({
  id: 'link-1',
  kind: 'sale',
  folio_line_id: null,
  state: 'open',
  amount: 150_000,
  url: 'https://link.devoladapago.com/p/kq7m2x9d4tbn3wpa',
  expires_at: 1_800_086_400,
  closed_reason: null,
  label: 'awaiting_payment',
  payment: null,
  ...over,
})

/** A link's current payment, as Devolada reported it. */
export const aLinkPayment = (over: Record<string, unknown> = {}) => ({
  id: 'dpay-1',
  status: 'validating',
  asked: 150_000,
  claimed: 150_000,
  received: null,
  match: null,
  receipt_number: null,
  verdict_at: null,
  awaiting: null,
  awaiting_reason: null,
  resolution: null,
  ...over,
})

export const devoladaHandlers = [
  http.get('/api/organizations/me/devolada', () => HttpResponse.json({ connection: null })),
  http.put('/api/organizations/me/devolada', () => HttpResponse.json({ connection: aConnection() })),
  http.delete('/api/organizations/me/devolada', () =>
    HttpResponse.json({
      connection: aConnection({ status: 'disconnected', mode: null, key_hint: null, webhook: null }),
    }),
  ),
]
