import { describe, it, expect, beforeAll } from 'vitest'
import { http, HttpResponse } from 'msw'
import { renderWithProviders, screen } from '../../../test/renderWithProviders'
import { server } from '../../../test/server'
import { FolioCard, type FolioCardFolio } from './FolioCard'
import { FolioStatusChip } from './FolioStatusChip'

// US-A82 / US-AG49 — the card as RENDERED.
// Spec: docs/oversight/folio-list-scanability.spec.md — S-10, plus the render-level facts the pure
// functions in folioCardState.test.ts cannot reach: what a screen reader is told, and how many
// action buttons actually exist in the tree.

// The WhatsApp buttons read the session and the org to build their message. `onUnhandledRequest:
// 'error'` means an unstubbed call fails the test rather than warning, which is the point.
beforeAll(() => {
  server.use(
    http.get('/api/auth/me', () =>
      HttpResponse.json({ user: { id: 'u1', name: 'Ana Ramírez', email: 'ana@x.com', role: 'admin' } }),
    ),
    http.get('/api/organizations/me', () =>
      HttpResponse.json({ organization: { id: 'o1', name: 'Turistear Ya!', timezone: 'America/Cancun' } }),
    ),
  )
})

const aFolio = (over: Partial<FolioCardFolio> = {}): FolioCardFolio => ({
  id: 'f1',
  status: 'paid',
  customer_name: 'María González',
  customer_phone: '5215512345678',
  total: 240000,
  amount_paid: 240000,
  deliverable: true,
  tickets_sent_at: 1000,
  tickets_viewed_at: null,
  lines: [
    {
      service_name: 'Tour Isla Mujeres',
      line_type: 'slot',
      slot_date: '2026-08-08',
      slot_start_time: '09:00',
      check_in: null,
      check_out: null,
      guests: null,
      quantity: 2,
    },
  ],
  ...over,
})

describe('S-10 — the byline follows the audience', () => {
  it('the admin list names the agent', () => {
    renderWithProviders(
      <FolioCard folio={aFolio()} to="/folios/f1" byline="Ana Ramírez" soldAt="hoy 14:32" />,
    )
    expect(screen.getByText(/Ana Ramírez/)).toBeInTheDocument()
  })

  it("the seller's own list names the shift operator instead", () => {
    renderWithProviders(
      <FolioCard folio={aFolio()} to="/history/f1" byline="Luis Palma" soldAt="hoy 14:32" surface="seller" />,
    )
    expect(screen.getByText(/Luis Palma/)).toBeInTheDocument()
  })

  it('a direct sale collapses the byline — no placeholder, no stray separator', () => {
    renderWithProviders(
      <FolioCard folio={aFolio()} to="/history/f1" byline={null} soldAt="hoy 14:32" />,
    )
    // The identity line is customer + soldAt and nothing between them. A `· ·` here would be the
    // placeholder-dash bug this decision exists to avoid.
    expect(screen.getByText('María González · hoy 14:32')).toBeInTheDocument()
    expect(screen.queryByText(/· ·|—/)).not.toBeInTheDocument()
  })
})

describe('S-2 — "Sin nombre" is gone from the rendered card', () => {
  it('an Express folio renders the masked identity, not an apology', () => {
    renderWithProviders(
      <FolioCard
        folio={aFolio({ customer_name: null })}
        to="/folios/f1"
        byline="Ana Ramírez"
        soldAt="hoy 14:32"
      />,
    )
    // The visible text is split so the mask's bullets can carry their own tracking (D18), so the
    // accessible name is what proves a screen reader hears ONE identity rather than stray bullets.
    expect(screen.getByLabelText(/Cliente ••5678 · Ana Ramírez · hoy 14:32/)).toBeInTheDocument()
    expect(screen.queryByText(/Sin nombre/)).not.toBeInTheDocument()
  })
})

describe('S-6 — exactly one action button is rendered', () => {
  it('a folio with a pending delivery offers the ticket send and nothing else', () => {
    renderWithProviders(
      <FolioCard
        folio={aFolio({ tickets_sent_at: null, portal_link: 'https://api.test/portal/tok' })}
        to="/folios/f1"
        byline="Ana Ramírez"
        soldAt="hoy 14:32"
      />,
    )
    expect(screen.getByRole('button', { name: /Enviar boletos/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Enviar mensaje/ })).not.toBeInTheDocument()
  })

  it('a settled folio rests on the neutral verb', () => {
    renderWithProviders(
      <FolioCard folio={aFolio()} to="/folios/f1" byline="Ana Ramírez" soldAt="hoy 14:32" />,
    )
    expect(screen.getByRole('button', { name: /Enviar mensaje/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Enviar boletos/ })).not.toBeInTheDocument()
  })
})

describe('D10/D11 — structure and the accessible name of the marks', () => {
  it('the link region and the action are separate controls, not one nested in the other', () => {
    renderWithProviders(
      <FolioCard folio={aFolio()} to="/folios/f1" byline="Ana Ramírez" soldAt="hoy 14:32" />,
    )
    const link = screen.getByRole('link')
    const button = screen.getByRole('button', { name: /Enviar mensaje/ })
    // The defect this replaces: the whole card was one <a> with a <button> inside it.
    expect(link.contains(button)).toBe(false)
  })

  it('a checkmark announces what it means, because a glyph alone is not state', () => {
    const { rerender } = renderWithProviders(
      <FolioCard folio={aFolio()} to="/folios/f1" byline="Ana" soldAt="hoy 14:32" />,
    )
    expect(screen.getByLabelText('Boletos enviados')).toBeInTheDocument()

    rerender(
      <FolioCard
        folio={aFolio({ tickets_viewed_at: 2000 })}
        to="/folios/f1"
        byline="Ana"
        soldAt="hoy 14:32"
      />,
    )
    expect(screen.getByLabelText('Boletos vistos por el cliente')).toBeInTheDocument()
  })
})

// --- BUG-026 / BUG-027 — the two labels that lied (folio-state-machine.spec.md, Phase 1) ---------

describe('S-1 — one word for one state', () => {
  it('the status chip calls a booking an Apartado, never a Reserva', () => {
    renderWithProviders(<FolioStatusChip status="booking" />)
    expect(screen.getByText('Apartado')).toBeInTheDocument()
    expect(screen.queryByText('Reserva')).not.toBeInTheDocument()
  })

  // The card carries no status chip by design (US-A82: one channel per axis), so the word reaches
  // it through the time chip. Both surfaces must agree — disagreeing is the whole defect.
  it('an apartado with no clock resolved yet still reads Apartado on the card', async () => {
    renderWithProviders(
      <FolioCard
        folio={aFolio({ status: 'booking', amount_paid: 90000, booking_expires_at: 99999 })}
        to="/folios/f1"
        soldAt="hoy 14:32"
        nowSeconds={null}
      />,
    )
    expect(await screen.findByText('Apartado')).toBeInTheDocument()
    expect(screen.queryByText('Reserva')).not.toBeInTheDocument()
  })
})

describe('S-2 — a cancellation that refunded nothing does not claim it refunded', () => {
  it('renders "(sin reembolso)" and never "(reembolsado)"', async () => {
    renderWithProviders(
      <FolioCard
        folio={aFolio({
          status: 'cancelled',
          total: 150000,
          amount_paid: 150000,
          refund_status: 'none',
          refund_amount: 0,
          deliverable: false,
          tickets_sent_at: null,
        })}
        to="/folios/f1"
        soldAt="hoy 14:32"
      />,
    )
    expect(await screen.findByText('(sin reembolso)')).toBeInTheDocument()
    expect(screen.queryByText('(reembolsado)')).not.toBeInTheDocument()
    // The screen reader is told the same thing the sighted user is — a glyph-free caption is not
    // enough when the figure alone reads as an ordinary amount.
    expect(screen.getByLabelText(/Pagado, sin reembolso/)).toBeInTheDocument()
  })

  it('S-3 — a confirmed refund still says so', async () => {
    renderWithProviders(
      <FolioCard
        folio={aFolio({
          status: 'cancelled',
          total: 150000,
          amount_paid: 150000,
          refund_status: 'refunded',
          refund_amount: 150000,
          deliverable: false,
          tickets_sent_at: null,
        })}
        to="/folios/f1"
        soldAt="hoy 14:32"
      />,
    )
    expect(await screen.findByText('(reembolsado)')).toBeInTheDocument()
    expect(screen.queryByText('(sin reembolso)')).not.toBeInTheDocument()
  })
})
