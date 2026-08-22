import { describe, it, expect, beforeEach } from 'vitest'
import { http, HttpResponse } from 'msw'
import { Route, Routes } from 'react-router-dom'
import { server } from '../../../test/server'
import { renderWithProviders, screen } from '../../../test/renderWithProviders'
import { FolioDetailScreen } from './FolioDetailScreen'

// US-A93 (docs/oversight/folio-surface-parity.spec.md D7/D8/D13) — ONE detail screen, two
// audiences. What is asserted here is the line between them: the seller reads the same folio,
// through their own caller-scoped endpoint, and is offered none of the verbs they do not hold.
//
// The screen-level test exists because the gating is spread over a long component — a rung, a
// per-line button, a bottom action block and three overlays — and "the seller must not be able to
// cancel a sale" is not a claim any one of those files can make on its own.

const aDetailFolio = (over: Record<string, unknown> = {}) => ({
  id: 'f1',
  agent: { id: 'a1', name: 'Ana' },
  operator_name: null,
  status: 'paid',
  customer_name: 'María Fernández',
  customer_email: 'maria@example.com',
  customer_phone: '9981234567',
  payment_method: 'cash',
  payment_verification: 'not_required',
  subtotal: 150_000,
  discount_total: 0,
  total: 150_000,
  amount_paid: 150_000,
  pending_balance: 0,
  commission_amount: 15_000,
  cancelled_at: null,
  cancelled_by: null,
  cancellation_reason: null,
  refund_status: 'none',
  refund_amount: null,
  refund_note: null,
  refunded_at: null,
  refunded_by: null,
  credit_amount: null,
  credit_expires_at: null,
  portal_link: 'https://api.local/portal/tok',
  tickets_sent_at: null,
  tickets_viewed_at: null,
  created_at: 1_800_000_000,
  folio_requests: [],
  payments: [],
  lines: [
    {
      id: 'l1',
      line_type: 'slot',
      service_id: 's1',
      slot_id: 'sl1',
      service_name: 'Tour Isla Mujeres',
      slot_date: '2030-06-15',
      slot_start_time: '06:00',
      quantity: 2,
      base_price: 75_000,
      minimum_price: 50_000,
      unit_price: 75_000,
      line_total: 150_000,
      money_state: 'paid',
      qr_token: 'tok',
      qr: {
        folio_id: 'f1',
        folio_line_id: 'l1',
        service_id: 's1',
        slot_id: 'sl1',
        client_identity: 'María Fernández',
        passes_total: 2,
        expires_at: 1_900_000_000,
      },
      extras: [],
    },
  ],
  ...over,
})

/** Both endpoints return the same payload since #126 — which is why one fixture serves both. */
const withDetail = (folio: Record<string, unknown> = aDetailFolio()) =>
  server.use(
    http.get('/api/folios/:id', () =>
      HttpResponse.json({ folio, cancellation_quote: null, events: [] }),
    ),
    http.get('/api/pos/folios/:id', () =>
      HttpResponse.json({ folio, cancellation_quote: null, events: [] }),
    ),
  )

beforeEach(() => {
  server.use(
    http.get('/api/me', () =>
      HttpResponse.json({ user: { id: 'u1', name: 'Ana', email: 'ana@x.com', role: 'admin' } }),
    ),
    http.get('/api/organizations/me', () =>
      HttpResponse.json({
        organization: { id: 'o1', name: 'Turistear Ya!', timezone: 'America/Cancun' },
      }),
    ),
  )
})

const renderDetail = (surface: 'admin' | 'seller') =>
  renderWithProviders(
    <Routes>
      <Route path="/:base/:id" element={<FolioDetailScreen surface={surface} />} />
    </Routes>,
    { initialEntries: [surface === 'admin' ? '/folios/f1' : '/history/f1'] },
  )

const SURFACES = ['admin', 'seller'] as const

describe.each(SURFACES)('US-A93 — %s: the detail reads the same folio', (surface) => {
  it('the heading is the CUSTOMER, not the word "Folio"', async () => {
    withDetail()
    renderDetail(surface)
    // The seller's screen used to title itself with the class of thing it was showing. Both now
    // answer the question the reader opened it with: whose sale is this.
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('María Fernández')
  })

  it('the money reads first, and the sale is attributed', async () => {
    withDetail()
    renderDetail(surface)
    // The name appears on the line AND on its access ticket — one assertion per fact, not per node.
    expect((await screen.findAllByText('Tour Isla Mujeres')).length).toBeGreaterThan(0)
    expect(screen.getByText(/Vendido por Ana/)).toBeInTheDocument()
  })

  it('a cancelled sale states where the money went (BUG-034, both surfaces)', async () => {
    withDetail(
      aDetailFolio({
        status: 'cancelled',
        cancelled_at: 1_800_100_000,
        refund_status: 'pending',
        refund_amount: 75_000,
      }),
    )
    renderDetail(surface)
    expect(await screen.findByText('Se devuelve al cliente')).toBeInTheDocument()
    expect(screen.getByText('La empresa retiene')).toBeInTheDocument()
  })
})

describe('US-A93 — the verbs are what differ', () => {
  it('the seller is offered no destructive verb', async () => {
    withDetail()
    renderDetail('seller')
    await screen.findAllByText('Tour Isla Mujeres')

    expect(screen.queryByRole('button', { name: 'Cancelar folio' })).toBeNull()
    expect(screen.queryByRole('button', { name: /Cancelar esta actividad/ })).toBeNull()
  })

  it('the admin keeps theirs', async () => {
    withDetail()
    renderDetail('admin')
    await screen.findAllByText('Tour Isla Mujeres')

    expect(screen.getByRole('button', { name: 'Cancelar folio' })).toBeInTheDocument()
  })

  it('D8 — the QR is open for the seller and collapsed for the admin', async () => {
    withDetail()
    const seller = renderDetail('seller')
    // The seller shows it across a counter, so it is already there.
    expect(await screen.findByRole('button', { name: 'Ocultar' })).toBeInTheDocument()
    seller.unmount()

    withDetail()
    renderDetail('admin')
    // Present — «mi QR no funciona» reaches the admin — but not in the way of the money.
    expect(await screen.findByRole('button', { name: 'Ver' })).toBeInTheDocument()
  })
})
