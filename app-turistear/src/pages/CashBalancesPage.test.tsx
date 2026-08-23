import { describe, it, expect, beforeEach } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../test/server'
import { aBalanceRow, aDrop } from '../test/handlers/cash'
import { renderWithProviders, screen, waitFor, userEvent } from '../test/renderWithProviders'
import { expectHeadingOutline } from '../test/axe'
import CashBalancesPage from './CashBalancesPage'

// US-A98 — «Caja del equipo». This screen used to stack THREE levels of horizontal navigation
// (Mi caja | Equipo → Saldos | Entregas → four drop filters, the fourth clipping at 375px), so the
// one thing an admin opens it for — «¿qué entregas necesitan que las confirme?» — sat three taps
// deep while the badge announcing it was repeated on two of those rows.
//
// Testing a `pages/` file is against the usual rule (docs/TESTING.md D6: route assembly has no
// logic worth asserting). The exception is deliberate: "there is no tablist" is a fact about the
// assembly itself and is invisible from any single component.

beforeEach(() => {
  server.use(
    http.get('/api/organizations/me', () =>
      HttpResponse.json({
        organization: { id: 'o1', name: 'Turistear Ya!', timezone: 'America/Cancun' },
      }),
    ),
  )
})

const aTeamDrop = (over: Record<string, unknown> = {}) =>
  aDrop({
    agent: { id: 'agent-1', name: 'Ana Ramírez' },
    source: 'agent',
    acknowledgment: 'not_required',
    note: 'Entrega de media tarde',
    ...over,
  })

// The one handler both blocks read, keyed on the query the hook actually sends.
const withDrops = ({
  pending = [] as ReturnType<typeof aTeamDrop>[],
  disputed = [] as ReturnType<typeof aTeamDrop>[],
} = {}) =>
  server.use(
    http.get('/api/cash/drops', ({ request }) => {
      const url = new URL(request.url)
      if (url.searchParams.get('ack') === 'disputed') return HttpResponse.json({ drops: disputed })
      if (url.searchParams.get('status') === 'pending') return HttpResponse.json({ drops: pending })
      return HttpResponse.json({ drops: [...pending, ...disputed] })
    }),
  )

describe('Caja del equipo', () => {
  // S-15 — the whole point of the redesign, and unprovable from a component test.
  it('has no tabs at all', async () => {
    withDrops()
    renderWithProviders(<CashBalancesPage />)
    await screen.findByRole('heading', { level: 2, name: /Efectivo en la calle/ })
    expect(screen.queryAllByRole('tab')).toHaveLength(0)
    expect(screen.queryAllByRole('tablist')).toHaveLength(0)
  })

  it('is named for the team, not for «Caja»', async () => {
    withDrops()
    renderWithProviders(<CashBalancesPage />)
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Caja del equipo' }),
    ).toBeInTheDocument()
  })

  // S-16 — pending confirmations lead the page, named and counted.
  it('leads with the hand-ins waiting for a human', async () => {
    withDrops({ pending: [aTeamDrop()] })
    renderWithProviders(<CashBalancesPage />)
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Una entrega necesita tu confirmación' }),
    ).toBeInTheDocument()
    expect(screen.getByText('Ana Ramírez', { exact: false })).toBeInTheDocument()
  })

  it('counts them in the plural', async () => {
    withDrops({ pending: [aTeamDrop(), aTeamDrop({ id: 'drop-2' })] })
    renderWithProviders(<CashBalancesPage />)
    expect(
      await screen.findByRole('heading', { level: 2, name: '2 entregas necesitan tu confirmación' }),
    ).toBeInTheDocument()
  })

  // S-17 — an empty attention block is a demand for attention that is not owed.
  it('renders no pending block and no disputes block when there are none', async () => {
    withDrops()
    renderWithProviders(<CashBalancesPage />)
    await screen.findByRole('heading', { level: 2, name: /Efectivo en la calle/ })
    expect(screen.queryByText(/necesita.* tu confirmación/)).not.toBeInTheDocument()
    expect(screen.queryByText(/en disputa/i)).not.toBeInTheDocument()
  })

  it('names an open dispute when there is one', async () => {
    withDrops({
      disputed: [aTeamDrop({ id: 'drop-9', status: 'confirmed', acknowledgment: 'disputed', ack_note: 'Faltaban $200' })],
    })
    renderWithProviders(<CashBalancesPage />)
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Una entrega en disputa' }),
    ).toBeInTheDocument()
  })

  it('keeps a navigable heading outline', async () => {
    withDrops({ pending: [aTeamDrop()] })
    renderWithProviders(<CashBalancesPage />)
    await screen.findByRole('heading', { level: 2, name: /Efectivo en la calle/ })
    expectHeadingOutline('Caja del equipo')
  })
})

describe('Caja del equipo — confirming a hand-in', () => {
  // S-18 — and the assertion that matters most in this PR. `amount` MUST be absent: sending
  // `drop.amount` would look harmless and turn a plain confirm into an ADJUSTED one, which by
  // US-A28 owes the agent a signature. The screen would silently mint acknowledgment obligations.
  it('confirms as requested — never with an amount', async () => {
    const bodies: unknown[] = []
    withDrops({ pending: [aTeamDrop()] })
    server.use(
      http.post('/api/cash/drops/:id/review', async ({ request }) => {
        bodies.push(await request.json())
        return HttpResponse.json({ drop: aTeamDrop({ status: 'confirmed' }) })
      }),
    )

    const user = userEvent.setup({ delay: null })
    renderWithProviders(<CashBalancesPage />)
    await user.click(await screen.findByRole('button', { name: 'Confirmar' }))

    // One tap on money still asks, and the sheet repeats WHAT is being confirmed — the amount
    // and the person. «Confirmar» on a row is only safe when the sheet says what it confirms.
    expect(await screen.findByText('¿Recibiste este efectivo?')).toBeInTheDocument()
    expect(
      screen.getByText(/Confirmas que Ana Ramírez te entregó este monto/),
    ).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Confirmar recibo' }))
    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]).toEqual({ decision: 'confirmed' })
    expect(bodies[0]).not.toHaveProperty('amount')
  })

  // S-19 — a corrected figure and a written reason need room, so they stay on the detail.
  it('sends adjusting and rejecting to the drop detail', async () => {
    withDrops({ pending: [aTeamDrop({ id: 'drop-7' })] })
    renderWithProviders(<CashBalancesPage />)
    const revisar = await screen.findByRole('link', { name: 'Revisar' })
    expect(revisar).toHaveAttribute('href', '/cash/drops/drop-7')
  })

  it('offers the history as a route, not a tab', async () => {
    withDrops()
    renderWithProviders(<CashBalancesPage />)
    const link = await screen.findByRole('link', { name: /Ver historial de entregas/ })
    expect(link).toHaveAttribute('href', '/cash/entregas')
  })
})

// The balances list keeps its anatomy — the scope boundary says so — but the row's name may not
// clip: at 375px «Sofía Reyes» beside the affiliate chip rendered as «So…», which is not a name.
describe('Caja del equipo — the team list', () => {
  it('renders each holder with their money', async () => {
    withDrops()
    server.use(
      http.get('/api/cash/balances', () =>
        HttpResponse.json({
          balances: [
            aBalanceRow(),
            aBalanceRow({
              agent: { id: 'aff-1', name: 'Sofía Reyes', email: 's@x.com' },
              role: 'affiliate',
              affiliate_company: 'Hotel Riviera Maya',
            }),
          ],
        }),
      ),
    )
    renderWithProviders(<CashBalancesPage />)
    expect(await screen.findByText('Sofía Reyes')).toBeInTheDocument()
    expect(screen.getByText('Hotel Riviera Maya')).toBeInTheDocument()
  })
})

