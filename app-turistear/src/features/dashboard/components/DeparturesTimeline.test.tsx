import { describe, it, expect } from 'vitest'
import { renderWithProviders, screen } from '../../../test/renderWithProviders'
import { DeparturesTimeline } from './DeparturesTimeline'
import type { DashboardDay } from '../../../services/dashboardService'

// US-A14/A90 — the «Ocupación» card as RENDERED.
// Spec: docs/dashboard/occupancy-dashboard.spec.md (D23–D27; scenarios S-14, S-15).
//
// timeline.test.ts pins WHICH side of the split a row lands on. These pin WHAT the row then says,
// which is the whole point of the card and the one thing a pure test cannot reach. Every departure
// here is dated far in the past or future so the org clock cannot move rows mid-test.

const occupancy = (over: Partial<DashboardDay['occupancy'][0]> = {}) => ({
  slot_id: 'slot-up',
  service_id: 'svc-1',
  service_name: 'Noche de leyendas',
  start_time: '23:30',
  capacity: 150,
  booked: 90,
  remaining: 60,
  vendidos: 90,
  apartados: 0,
  is_flexible: false,
  flex_extra: 0,
  ...over,
})

const departed = (over: Partial<DashboardDay['departed'][0]> = {}) => ({
  slot_id: 'slot-past',
  service_name: 'Noche de leyendas',
  start_time: '00:01',
  vendidos: 90,
  abordaron: 85,
  sin_usar: 5,
  ...over,
})

const day = (over: Partial<DashboardDay> = {}): DashboardDay => ({
  date: '2026-08-17',
  occupancy: [],
  departed: [],
  sales: { collected_cents: 0, folios_created: 0, per_seller: [] },
  ...over,
})

const renderCard = (d: DashboardDay, isToday = true) =>
  renderWithProviders(
    <DeparturesTimeline day={d} isToday={isToday} tz="America/Cancun" loading={false} />,
  )

// The emphasised lead figure is its own <span>, so a line like «1 asistente de 1 vendido» is split
// across nodes. getByText's default matcher only reads an element's DIRECT text children and would
// miss it — assert against the paragraph's full textContent instead.
const readsLine = (re: RegExp) =>
  screen.getByText((_content, el) => el?.tagName === 'P' && re.test(el.textContent ?? ''))

describe('DeparturesTimeline — D23, the row reads occupancy', () => {
  it('an upcoming departure reads availability first, then what is sold', () => {
    renderCard(day({ occupancy: [occupancy()] }))
    expect(screen.getByText(/60 disponibles/)).toBeInTheDocument()
    expect(screen.getByText(/90 vendidos/)).toBeInTheDocument()
  })

  it('D24 — held seats count as sold, so availability + sold always equals capacity', () => {
    // 150 capacity, 100 booked of which 10 are merely held: the row must read 50 + 100, never
    // 50 + 90, which would leave 10 seats unaccounted for on screen.
    renderCard(
      day({
        occupancy: [occupancy({ capacity: 150, booked: 100, remaining: 50, vendidos: 90, apartados: 10 })],
      }),
    )
    expect(screen.getByText(/50 disponibles/)).toBeInTheDocument()
    expect(screen.getByText(/100 vendidos/)).toBeInTheDocument()
    expect(screen.queryByText(/90 vendidos/)).not.toBeInTheDocument()
  })

  it('a departed slot reads attendance out of what was sold', () => {
    renderCard(day({ departed: [departed()] }))
    // The past segment auto-opens when nothing is upcoming (D21).
    expect(screen.getByText(/85 asistentes/)).toBeInTheDocument()
    expect(screen.getByText(/de 90 vendidos/)).toBeInTheDocument()
  })

  it('a departure that sold nothing says so, instead of "0 asistentes de 0 vendidos"', () => {
    renderCard(day({ departed: [departed({ vendidos: 0, abordaron: 0, sin_usar: 0 })] }))
    expect(screen.getByText('Sin ventas')).toBeInTheDocument()
    expect(screen.queryByText(/asistente/)).not.toBeInTheDocument()
  })

  it('singularises rather than printing "1 asistentes"', () => {
    renderCard(day({ departed: [departed({ vendidos: 1, abordaron: 1, sin_usar: 0 })] }))
    expect(readsLine(/^1 asistente de 1 vendido$/)).toBeInTheDocument()
  })

  it('D25 — surfaces the flex margin that "0 disponibles" would otherwise hide', () => {
    renderCard(
      day({ occupancy: [occupancy({ capacity: 12, booked: 12, remaining: 0, vendidos: 12, flex_extra: 5 })] }),
    )
    expect(screen.getByText(/0 disponibles/)).toBeInTheDocument()
    expect(screen.getByText(/\+5 extra/)).toBeInTheDocument()
  })

  it('hides the flex margin while seats remain, where it means nothing', () => {
    renderCard(day({ occupancy: [occupancy({ flex_extra: 5 })] }))
    expect(screen.queryByText(/extra/)).not.toBeInTheDocument()
  })
})

describe('DeparturesTimeline — D26/D27, the implicit axis', () => {
  it('leads each row with its hour, in order, with no «Ahora» marker drawn', () => {
    renderCard(
      day({
        occupancy: [
          occupancy({ slot_id: 'a', start_time: '23:30', service_name: 'Catamarán' }),
          occupancy({ slot_id: 'b', start_time: '23:45', service_name: 'Nado con delfines' }),
        ],
      }),
    )
    expect(readsLine(/^23:30 · Catamarán$/)).toBeInTheDocument()
    expect(readsLine(/^23:45 · Nado con delfines$/)).toBeInTheDocument()
    // The marker was retired with the rail — order alone carries the axis.
    expect(screen.queryByRole('separator')).not.toBeInTheDocument()
  })

  it('titles the card «Ocupación», not «Salidas»', () => {
    renderCard(day({ occupancy: [occupancy()] }))
    expect(screen.getByText('Ocupación')).toBeInTheDocument()
  })
})

describe('DeparturesTimeline — the collapsed past summary (D21-rev)', () => {
  it('aggregates attendance in the same vocabulary the rows use', () => {
    renderCard(
      day({
        departed: [
          departed({ slot_id: 'p1', vendidos: 90, abordaron: 85 }),
          departed({ slot_id: 'p2', vendidos: 90, abordaron: 85 }),
        ],
        occupancy: [occupancy()],
      }),
    )
    expect(screen.getByText(/2 ya salieron/)).toBeInTheDocument()
    expect(screen.getByText(/170 de 180 asistieron/)).toBeInTheDocument()
  })

  it('says nothing about attendance when the departures sold nothing', () => {
    // «0 de 0 asistieron» is true and useless. Seen live with slots that had no folios.
    renderCard(
      day({
        departed: [departed({ vendidos: 0, abordaron: 0, sin_usar: 0 })],
        occupancy: [occupancy()],
      }),
    )
    expect(screen.getByText(/1 ya salió/)).toBeInTheDocument()
    expect(screen.queryByText(/asistieron/)).not.toBeInTheDocument()
  })
})
