import { http, HttpResponse } from 'msw'

// Handlers mirror src/services/cashService.ts one-to-one. Response SHAPES are copied from what
// api-turistear/test/cash/*.test.ts asserts — a fixture no API test would produce is a fixture
// that proves the frontend agrees with itself (docs/TESTING.md § The known gap).

export const anAgentBalance = (over: Record<string, unknown> = {}) => ({
  carry_forward: 0,
  cash_collected: 250_000,
  commission_total: 25_000,
  expense_total: 10_000,
  pending_drops_total: 0,
  payouts_total: 0,
  balance: 215_000,
  last_drop: null,
  expenses: [],
  drops: [],
  pending_acknowledgments: [],
  pending_acknowledgments_count: 0,
  // The full SalesBreakdown / CommissionBreakdown the API returns — `total`, the per-method map
  // and the counts. The short version here used to omit them, which is a fixture no API test would
  // produce (docs/TESTING.md § The known gap).
  sales: {
    total: 250_000,
    cash: 250_000,
    electronic: 0,
    by_method: { card: 0, transfer: 0, link: 0 },
    cash_count: 2,
    electronic_count: 0,
  },
  commissions: { total: 25_000, cash: 25_000, electronic: 0 },
  ...over,
})

export const aBalanceRow = (over: Record<string, unknown> = {}) => ({
  agent: { id: 'agent-1', name: 'Ana', email: 'ana@example.com' },
  role: 'agent',
  affiliate_company: null,
  carry_forward: 0,
  cash_collected: 250_000,
  commission_total: 25_000,
  expense_total: 0,
  payouts_total: 0,
  balance: 225_000,
  last_drop: null,
  pending_drops_total: 0,
  pending_drops_count: 0,
  ...over,
})

export const aDrop = (over: Record<string, unknown> = {}) => ({
  id: 'drop-1',
  amount: 100_000,
  status: 'pending',
  created_at: 1_800_000_000,
  ...over,
})

export const cashHandlers = [
  http.get('/api/cash/me', () => HttpResponse.json({ balance: anAgentBalance() })),
  http.get('/api/cash/balances', () => HttpResponse.json({ balances: [aBalanceRow()] })),
  http.post('/api/cash/me/expenses', () =>
    HttpResponse.json({ expense: { id: 'exp-1', amount: 5_000, concept: 'Gasolina' } }),
  ),
  http.delete('/api/cash/me/expenses/:id', () => HttpResponse.json({ ok: true })),
  http.post('/api/cash/me/drops', () => HttpResponse.json({ drop: aDrop() })),
  http.delete('/api/cash/me/drops/:id', () => HttpResponse.json({ ok: true })),
  http.post('/api/cash/me/drops/:id/acknowledge', () =>
    HttpResponse.json({ drop: aDrop({ status: 'confirmed' }) }),
  ),
  http.post('/api/cash/me/drops/:id/dispute', () =>
    HttpResponse.json({ drop: aDrop({ status: 'disputed' }) }),
  ),
  http.get('/api/cash/drops', () => HttpResponse.json({ drops: [aDrop()] })),
  http.get('/api/cash/drops/:id', () => HttpResponse.json({ drop: aDrop() })),
  http.post('/api/cash/drops/:id/review', () =>
    HttpResponse.json({ drop: aDrop({ status: 'confirmed' }) }),
  ),
  http.post('/api/cash/payouts', () => HttpResponse.json({ payout: { id: 'payout-1', amount: 50_000 } })),
  http.post('/api/cash/collections', () => HttpResponse.json({ drop: aDrop({ status: 'confirmed' }) })),
  http.post('/api/cash/drops/:id/resolve-dispute', () =>
    HttpResponse.json({ drop: aDrop({ status: 'confirmed' }) }),
  ),
]
