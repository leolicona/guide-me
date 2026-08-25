import { describe, it, expect, beforeEach } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../test/server'
import { aDrop } from '../test/handlers/cash'
import { renderWithProviders, screen, waitFor, userEvent } from '../test/renderWithProviders'
import CashDropsHistoryPage from './CashDropsHistoryPage'

// US-A98 / D15 — the drop history as a ROUTE. It used to be the third of three stacked tab rows,
// filtered by an exclusive five-value ToggleButtonGroup whose fourth value clipped at 375px and
// whose state lived in `useState`, so it was lost on every return from a drop detail.

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
    ...over,
  })

const withHistory = (drops: ReturnType<typeof aTeamDrop>[]) =>
  server.use(http.get('/api/cash/drops', () => HttpResponse.json({ drops })))

const aMixedHistory = () => [
  aTeamDrop({ id: 'd1', status: 'pending', amount: 20_000 }),
  aTeamDrop({ id: 'd2', status: 'confirmed', amount: 30_000 }),
  aTeamDrop({ id: 'd3', status: 'rejected', amount: 40_000 }),
  aTeamDrop({ id: 'd4', status: 'confirmed', acknowledgment: 'disputed', amount: 50_000 }),
]

const cards = () => [...document.querySelectorAll('.MuiCard-root')]

// The `h1` is static, so awaiting it proves only that the page mounted — the drops arrive a tick
// later. Every count has to wait for the data, or it measures an empty list and passes for the
// wrong reason.
const expectCards = (n: number) => waitFor(() => expect(cards()).toHaveLength(n))

describe('Entregas — the history', () => {
  it('is a route with no tabs', async () => {
    withHistory(aMixedHistory())
    renderWithProviders(<CashDropsHistoryPage />, { initialEntries: ['/cash/entregas'] })
    expect(await screen.findByRole('heading', { level: 1, name: 'Entregas' })).toBeInTheDocument()
    expect(screen.queryAllByRole('tab')).toHaveLength(0)
  })

  it('shows every drop when nothing is filtered', async () => {
    withHistory(aMixedHistory())
    renderWithProviders(<CashDropsHistoryPage />, { initialEntries: ['/cash/entregas'] })
    await expectCards(4)
  })

  // S-20 — the facet is MULTI-select and lives in the URL. Both halves matter: the exclusive
  // toggle made «rechazadas o en disputa» unaskable, and `useState` lost the answer on the way
  // back from a detail.
  it('reads its facets from the URL, and accepts more than one', async () => {
    withHistory(aMixedHistory())
    renderWithProviders(<CashDropsHistoryPage />, {
      initialEntries: ['/cash/entregas?estado=rejected,disputed'],
    })
    await expectCards(2)
    expect(screen.getByRole('button', { name: /2 estados/ })).toBeInTheDocument()
  })

  it('writes a chosen facet back to the URL', async () => {
    withHistory(aMixedHistory())
    const user = userEvent.setup({ delay: null })
    renderWithProviders(<CashDropsHistoryPage />, { initialEntries: ['/cash/entregas'] })

    await user.click(await screen.findByRole('button', { name: /Todas las entregas/ }))
    await user.click(await screen.findByRole('button', { name: 'Rechazadas' }))

    // The pill now names the single active facet — which is what a reader checks before trusting
    // a short list.
    expect(await screen.findByRole('button', { name: /Rechazadas/ })).toBeInTheDocument()
  })

  // A dispute rides on an already-confirmed drop, so matching it by `status` would either miss it
  // or double-count it under «Confirmadas».
  it('matches a dispute by its acknowledgment, not its status', async () => {
    withHistory(aMixedHistory())
    renderWithProviders(<CashDropsHistoryPage />, {
      initialEntries: ['/cash/entregas?estado=disputed'],
    })
    await expectCards(1)
  })

  // The sentence «no hay entregas» when a FILTER is what emptied the list is the exact untruth
  // US-A83 D15 retired one screen over.
  it('names the filter when the filter is what emptied the list', async () => {
    withHistory([aTeamDrop({ id: 'd1', status: 'confirmed' })])
    renderWithProviders(<CashDropsHistoryPage />, {
      initialEntries: ['/cash/entregas?estado=rejected'],
    })
    expect(await screen.findByText(/Ninguna entrega está en rechazadas/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Quitar filtros' })).toBeInTheDocument()
  })

  it('says something different when there is genuinely nothing', async () => {
    withHistory([])
    renderWithProviders(<CashDropsHistoryPage />, { initialEntries: ['/cash/entregas'] })
    expect(await screen.findByText('Todavía no hay entregas registradas.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Quitar filtros' })).not.toBeInTheDocument()
  })

  it('leads back to the team caja', async () => {
    withHistory([])
    renderWithProviders(<CashDropsHistoryPage />, { initialEntries: ['/cash/entregas'] })
    expect(await screen.findByRole('link', { name: /Caja del equipo/ })).toHaveAttribute(
      'href',
      '/cash',
    )
  })
})
