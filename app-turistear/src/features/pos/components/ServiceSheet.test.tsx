import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../../../test/server'
import { renderWithProviders, screen, waitFor } from '../../../test/renderWithProviders'
import { usePosFilters } from '../../../store/posFilters'
import { ServiceSheet } from './ServiceSheet'

// BUG-032 — the reported scenario, kept as a whole: the agent filters the catalog to 21–23 Aug,
// the card for «Taller del alfarero» reads «Próximo: Sáb 22», and opening it said *No hay horarios
// disponibles para este servicio*. The sheet read only `selection.from`, so it asked the API for
// the 21st alone — a Friday this service does not run — and the detail contradicted the card that
// opened it.
//
// The service is deliberately given NO slot on the 21st. That is what makes this a regression
// test rather than a smoke test: on the old code the request is `from=21&to=21`, the response is
// empty, and the empty-state string renders. Both halves are asserted — the query that goes out
// (the defect) and the departure that comes back (what the agent loses).

const TODAY = '2026-08-21' // Friday
const SATURDAY = '2026-08-22'

/** Every `/api/pos/services/:id` request this render made, in order. */
let detailRequests: URL[] = []

const aSlot = (over: Record<string, unknown> = {}) => ({
  id: 'slot-sat',
  date: SATURDAY,
  start_time: '10:00',
  capacity: 12,
  booked: 4,
  remaining: 8,
  ...over,
})

/** The service detail, answering with only the slots that fall inside the requested window —
 *  the server's own `from`/`to` filter, which is what makes the client's query observable. */
const withService = (slots: ReturnType<typeof aSlot>[]) =>
  server.use(
    http.get('/api/pos/services/:id', ({ request }) => {
      const url = new URL(request.url)
      detailRequests.push(url)
      const from = url.searchParams.get('from') ?? '0000-00-00'
      const to = url.searchParams.get('to') ?? from
      return HttpResponse.json({
        service: {
          id: 'svc-alfarero',
          name: 'Taller del alfarero',
          description: null,
          base_price: 45_000,
          minimum_price: 40_000,
          is_flexible: false,
          flex_capacity_pct: 0,
          zones_enabled: false,
          category: 'tours',
          express_eligible: false,
          extras: [],
          slots: slots.filter((s) => s.date >= from && s.date <= to),
        },
      })
    }),
  )

beforeEach(() => {
  detailRequests = []
  usePosFilters.setState({ selection: null })
  // Only Date is faked — Testing Library's `waitFor` and React Query both need real timers.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(`${TODAY}T15:00:00Z`))
  server.use(
    http.get('/api/organizations/me', () =>
      HttpResponse.json({
        organization: { id: 'o1', name: 'Turistear Ya!', timezone: 'America/Cancun' },
      }),
    ),
  )
})

afterEach(() => {
  vi.useRealTimers()
  usePosFilters.setState({ selection: null })
})

describe('BUG-032 — the sheet reads the WHOLE selected range, not just its first day', () => {
  it('shows Saturday\'s departure when the catalog is filtered 21–23 Aug', async () => {
    usePosFilters.setState({ selection: { from: TODAY, to: '2026-08-23' } })
    withService([aSlot()])

    renderWithProviders(
      <ServiceSheet serviceId="svc-alfarero" onClose={() => {}} onAdded={() => {}} />,
    )

    // The departure the card advertised is on screen…
    expect(await screen.findByText('10:00')).toBeInTheDocument()
    expect(screen.getByText(/Sáb 22/)).toBeInTheDocument()
    // …and the contradiction is gone.
    expect(screen.queryByText(/No hay horarios disponibles/)).not.toBeInTheDocument()
  })

  it('asks the API for the range the agent selected — `to` is not dropped', async () => {
    usePosFilters.setState({ selection: { from: TODAY, to: '2026-08-23' } })
    withService([aSlot()])

    renderWithProviders(
      <ServiceSheet serviceId="svc-alfarero" onClose={() => {}} onAdded={() => {}} />,
    )

    await waitFor(() => expect(detailRequests.length).toBeGreaterThan(0))
    const q = detailRequests[0].searchParams
    expect(q.get('from')).toBe(TODAY)
    expect(q.get('to')).toBe('2026-08-23') // was TODAY before the fix
  })

  it('still collapses a single-day pick to that day — a precise search stays precise', async () => {
    usePosFilters.setState({ selection: { from: SATURDAY } })
    withService([aSlot(), aSlot({ id: 'slot-sun', date: '2026-08-23', start_time: '11:00' })])

    renderWithProviders(
      <ServiceSheet serviceId="svc-alfarero" onClose={() => {}} onAdded={() => {}} />,
    )

    expect(await screen.findByText('10:00')).toBeInTheDocument()
    expect(screen.queryByText('11:00')).not.toBeInTheDocument()
    const q = detailRequests[0].searchParams
    expect(q.get('from')).toBe(SATURDAY)
    expect(q.get('to')).toBe(SATURDAY)
  })

  it('opens on the whole contextual week when nothing is picked — not a 3-day slice of it', async () => {
    // Monday 17 Aug: the catalog's default window runs through Sunday the 23rd (a full week),
    // where the sheet's own rolling window used to stop on Wednesday the 19th. A service running
    // only on Thursday was invisible in the detail while its card advertised it.
    vi.setSystemTime(new Date('2026-08-17T15:00:00Z'))
    withService([aSlot({ id: 'slot-thu', date: '2026-08-20', start_time: '11:00' })])

    renderWithProviders(
      <ServiceSheet serviceId="svc-alfarero" onClose={() => {}} onAdded={() => {}} />,
    )

    expect(await screen.findByText('11:00')).toBeInTheDocument()
    const q = detailRequests[0].searchParams
    expect(q.get('from')).toBe('2026-08-17')
    expect(q.get('to')).toBe('2026-08-23') // was 2026-08-19 before the fix
  })

  it('keeps ⚡ Express pinned to today whatever the catalog is filtered to (US-AG45 D5)', async () => {
    usePosFilters.setState({ selection: { from: SATURDAY, to: '2026-08-23' } })
    withService([aSlot({ id: 'slot-today', date: TODAY, start_time: '09:00' })])

    renderWithProviders(
      <ServiceSheet serviceId="svc-alfarero" express onClose={() => {}} onAdded={() => {}} />,
    )

    await waitFor(() => expect(detailRequests.length).toBeGreaterThan(0))
    const q = detailRequests[0].searchParams
    expect(q.get('from')).toBe(TODAY)
    expect(q.get('to')).toBe(TODAY)
  })
})
