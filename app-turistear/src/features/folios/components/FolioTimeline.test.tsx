import { describe, it, expect, beforeAll } from 'vitest'
import { http, HttpResponse } from 'msw'
import { renderWithProviders, screen } from '../../../test/renderWithProviders'
import { server } from '../../../test/server'
import { FolioTimeline } from './FolioTimeline'
import type { FolioEvent } from '../types'

// US-A24 / US-AG53 — the timeline as RENDERED (docs/folios/folio-timeline.spec.md, Phase 2):
// server order preserved, the D10 actor fallbacks, the D8 copy per event, and the derived Salida
// marker (D7) interleaving without ever being an event.

// The date caption reads through useOrgDateFormatter, which fetches the org.
beforeAll(() => {
  server.use(
    http.get('/api/organizations/me', () =>
      HttpResponse.json({
        organization: { id: 'o1', name: 'Turistear Ya!', timezone: 'America/Cancun' },
      }),
    ),
  )
})

let seq = 0
const anEvent = (over: Partial<FolioEvent> = {}): FolioEvent => ({
  id: `e${++seq}`,
  type: 'created',
  at: 1000,
  actor: { id: 'u1', name: 'Ana R.' },
  operator_name: null,
  backfilled: false,
  payload: null,
  ...over,
})

/** DOM position of the first row containing `text` — for order assertions. */
const posOf = (container: HTMLElement, text: string) => {
  const idx = container.textContent!.indexOf(text)
  expect(idx, `"${text}" not rendered`).toBeGreaterThanOrEqual(0)
  return idx
}

describe('D8 — server order is preserved, never re-sorted', () => {
  it('renders events in array order even when their timestamps disagree', () => {
    // A backfill tie can arrive with `at` out of order; the server order (rowid) is the truth.
    const { container } = renderWithProviders(
      <FolioTimeline
        events={[
          anEvent({ type: 'created', at: 1000, payload: { sale_mode: 'standard', initial_status: 'booking' } }),
          anEvent({ type: 'tickets_sent', at: 3000 }),
          anEvent({ type: 'tickets_viewed', at: 2000, actor: null }),
        ]}
      />,
    )
    const created = posOf(container, 'Creado (apartado)')
    const sent = posOf(container, 'Boletos enviados')
    const viewed = posOf(container, 'Visto por el cliente')
    expect(created).toBeLessThan(sent)
    expect(sent).toBeLessThan(viewed)
  })
})

describe('D10 — the null actor renders Sistema, or Cliente on the Visto beacon', () => {
  it("the sweep's cancellation names the system", () => {
    renderWithProviders(
      <FolioTimeline
        events={[anEvent({ type: 'cancelled', actor: null, payload: { source: 'system_expiry', clawback: false } })]}
      />,
    )
    expect(screen.getByText('Apartado vencido — cancelado por el sistema')).toBeInTheDocument()
    expect(screen.getByText(/^Sistema · /)).toBeInTheDocument()
  })

  it('the Visto beacon names the client', () => {
    renderWithProviders(<FolioTimeline events={[anEvent({ type: 'tickets_viewed', actor: null })]} />)
    expect(screen.getByText('Visto por el cliente')).toBeInTheDocument()
    expect(screen.getByText(/^Cliente · /)).toBeInTheDocument()
  })
})

describe('US-A22 (line-autonomy D13) — a line-scoped cancellation names its protagonist', () => {
  it('renders the line name + date from the payload, never a join', () => {
    renderWithProviders(
      <FolioTimeline
        events={[
          anEvent({
            type: 'cancelled',
            payload: {
              source: 'admin',
              clawback: false,
              refund_amount: 50000,
              line: { service_name: 'Isla Mujeres', slot_date: '2026-08-20' },
            },
          }),
        ]}
      />,
    )
    expect(
      screen.getByText('Canceló Isla Mujeres (2026-08-20) — por administración'),
    ).toBeInTheDocument()
  })

  it('a folio-scoped cancellation (no line in the payload) keeps the original copy', () => {
    renderWithProviders(
      <FolioTimeline
        events={[anEvent({ type: 'cancelled', payload: { source: 'admin', clawback: false } })]}
      />,
    )
    expect(screen.getByText('Cancelado por administración')).toBeInTheDocument()
  })
})

describe('D11 — payment copy by kind, amount through MoneyText', () => {
  it('a deposit reads Abono with its formatted amount and method', () => {
    const { container } = renderWithProviders(
      <FolioTimeline
        events={[anEvent({ type: 'payment', payload: { amount: 50000, method: 'cash', kind: 'deposit' } })]}
      />,
    )
    // MoneyText's SR label proves the copy and the figure travel together.
    expect(screen.getByLabelText('Abono: $500.00')).toBeInTheDocument()
    expect(container.textContent).toContain('en efectivo')
  })

  it('a settlement reads Saldo liquidado', () => {
    renderWithProviders(
      <FolioTimeline
        events={[anEvent({ type: 'payment', payload: { amount: 190000, method: 'card', kind: 'settlement' } })]}
      />,
    )
    expect(screen.getByLabelText('Saldo liquidado: $1,900.00')).toBeInTheDocument()
  })

  it('a backfilled row without kind falls back to Pago', () => {
    renderWithProviders(
      <FolioTimeline
        events={[anEvent({ type: 'payment', backfilled: true, payload: { amount: 240000, method: 'cash' } })]}
      />,
    )
    expect(screen.getByLabelText('Pago: $2,400.00')).toBeInTheDocument()
  })
})

describe('D7 (as amended) — the Salida marker renders only once the departure occurred', () => {
  // History records FACTS: a departed marker exists and says what happened; a future one does not.
  const pastDate = new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10)
  const futureDate = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10)
  const departure = Date.parse(`${pastDate}T09:00:00Z`) / 1000
  const lines = [{ slot_date: pastDate, slot_start_time: '09:00' }]

  it('interleaves at its chronological slot among the events', () => {
    const { container } = renderWithProviders(
      <FolioTimeline
        events={[
          anEvent({ type: 'created', at: departure - 86400, payload: { sale_mode: 'standard', initial_status: 'booking' } }),
          anEvent({ type: 'cancelled', actor: null, at: departure + 3600, payload: { source: 'system_expiry', clawback: false } }),
        ]}
        lines={lines}
      />,
    )
    const created = posOf(container, 'Creado (apartado)')
    const salida = posOf(container, 'Salida')
    const cancelled = posOf(container, 'Apartado vencido')
    expect(created).toBeLessThan(salida)
    expect(salida).toBeLessThan(cancelled)
  })

  it('a departure nobody used reads Salida — sin uso', () => {
    renderWithProviders(<FolioTimeline events={[]} lines={lines} fulfillment="no_show" />)
    expect(screen.getByText('Salida — sin uso')).toBeInTheDocument()
    expect(screen.getByText(`${pastDate} · 09:00`)).toBeInTheDocument()
  })

  it('a used departure reads Salida — completada', () => {
    renderWithProviders(<FolioTimeline events={[]} lines={lines} fulfillment="fulfilled" />)
    expect(screen.getByText('Salida — completada')).toBeInTheDocument()
  })

  it('a FUTURE departure renders no marker — it is the service line\'s fact, not history', () => {
    const { container } = renderWithProviders(
      <FolioTimeline
        events={[anEvent({ type: 'created', at: 1000 })]}
        lines={[{ slot_date: futureDate, slot_start_time: '08:00' }]}
        collapsible
      />,
    )
    expect(container.textContent).not.toContain('Salida')
    // Only the created event: no phantom row inflates the count.
    expect(screen.queryByRole('button', { name: /Ver todo/ })).toBeNull()
  })

  it('a folio with no dated lines renders no marker', () => {
    renderWithProviders(
      <FolioTimeline events={[anEvent()]} lines={[{ slot_date: null, slot_start_time: null }]} />,
    )
    expect(screen.queryByText(/Salida/)).not.toBeInTheDocument()
  })
})

describe('D8 — a reschedule finally reads as a move', () => {
  it('states from → to with times', () => {
    const { container } = renderWithProviders(
      <FolioTimeline
        events={[
          anEvent({
            type: 'rescheduled',
            payload: {
              origin: 'counter',
              from_date: '2026-08-08',
              from_time: '09:00',
              to_date: '2026-08-10',
              to_time: '14:00',
            },
          }),
        ]}
      />,
    )
    expect(container.textContent).toContain('Reagendado: 2026-08-08 09:00 → 2026-08-10 14:00')
  })
})

describe('the absorbed petition history — one Historial, not two', () => {
  const request = (over: Record<string, unknown> = {}) => ({
    id: 'r1',
    status: 'rejected' as const,
    reason: 'Nos cambió el vuelo',
    resolution_note: 'Fuera de ventana',
    resolved_by: null,
    resolved_at: 2000,
    created_at: 1500,
    ...over,
  })

  it('a rejected cancellation petition interleaves as a derived row, with motivo and resolución', () => {
    const { container } = renderWithProviders(
      <FolioTimeline
        events={[
          anEvent({ type: 'created', at: 1000 }),
          anEvent({ type: 'tickets_sent', at: 3000 }),
        ]}
        requests={[request()]}
      />,
    )
    // The rejection left the folio untouched — this derived row is its ONLY surface.
    const rejectedAt = posOf(container, 'Solicitud de cancelación rechazada')
    expect(posOf(container, 'Creado')).toBeLessThan(rejectedAt)
    expect(rejectedAt).toBeLessThan(posOf(container, 'Boletos enviados'))
    expect(screen.getByText('Motivo del cliente: Nos cambió el vuelo')).toBeInTheDocument()
    expect(screen.getByText('Resolución: Fuera de ventana')).toBeInTheDocument()
  })

  it('a rejected reschedule petition names the departure it asked for', () => {
    renderWithProviders(
      <FolioTimeline
        events={[anEvent({ at: 1000 })]}
        requests={[
          request({
            id: 'r2',
            kind: 'reschedule',
            to_slot_date: '2026-06-21',
            to_slot_start_time: '09:00',
          }),
        ]}
      />,
    )
    expect(screen.getByText('Solicitud de reagenda rechazada')).toBeInTheDocument()
    expect(screen.getByText('Horario solicitado: 2026-06-21 09:00')).toBeInTheDocument()
  })

  it('approved and pending petitions get no derived row — their events tell the story', () => {
    const { container } = renderWithProviders(
      <FolioTimeline
        events={[anEvent({ at: 1000 })]}
        requests={[
          request({ id: 'r3', status: 'approved' }),
          request({ id: 'r4', status: 'pending', resolved_at: null }),
        ]}
      />,
    )
    expect(container.textContent).not.toContain('Solicitud')
  })
})

describe('collapsible — context above the money without pushing the money down', () => {
  const three = () => [
    anEvent({ type: 'created', at: 1000 }),
    anEvent({ type: 'payment', at: 2000, payload: { amount: 260000, method: 'cash', kind: 'full' } }),
    anEvent({ type: 'tickets_sent', at: 3000 }),
  ]

  it('collapsed shows only the LATEST row plus Ver todo (n)', async () => {
    const { container } = renderWithProviders(<FolioTimeline events={three()} collapsible />)
    expect(screen.getByText('Boletos enviados')).toBeInTheDocument()
    expect(container.textContent).not.toContain('Creado')
    const toggle = screen.getByRole('button', { name: 'Ver todo (3)' })
    toggle.click()
    expect(await screen.findByText('Creado')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Ver menos' })).toBeInTheDocument()
  })

  it('without the flag the full list renders, as the tests above assume', () => {
    const { container } = renderWithProviders(<FolioTimeline events={three()} />)
    expect(container.textContent).toContain('Creado')
    expect(screen.queryByRole('button', { name: /Ver todo/ })).toBeNull()
  })
})

describe('the absorbed outcome banners — history carries its own facts', () => {
  it('a cancelled row states the commission outcome from its payload', () => {
    renderWithProviders(
      <FolioTimeline
        events={[
          anEvent({
            type: 'cancelled',
            payload: { source: 'admin', reason: 'Cliente no viaja', clawback: true },
          }),
        ]}
      />,
    )
    expect(screen.getByText('Cliente no viaja')).toBeInTheDocument()
    expect(screen.getByText('Comisión del agente recuperada')).toBeInTheDocument()
  })

  it('an absorbed cancellation reads so, when nothing was clawed back', () => {
    renderWithProviders(
      <FolioTimeline
        events={[anEvent({ type: 'cancelled', payload: { source: 'agent', clawback: false } })]}
      />,
    )
    expect(screen.getByText('Comisión absorbida por la empresa')).toBeInTheDocument()
  })

  it('a no-PIN refund shows the override note the retired banner used to carry', () => {
    renderWithProviders(
      <FolioTimeline
        events={[
          anEvent({ type: 'refund_confirmed', payload: { amount: 20000, via: 'override' } }),
        ]}
        refundNote="El cliente perdió su enlace"
      />,
    )
    expect(screen.getByText(/con nota de anulación/)).toBeInTheDocument()
    expect(screen.getByText('Nota: El cliente perdió su enlace')).toBeInTheDocument()
  })

  it('a PIN refund shows no note even when the folio carries one from elsewhere', () => {
    const { container } = renderWithProviders(
      <FolioTimeline
        events={[anEvent({ type: 'refund_confirmed', payload: { amount: 20000, via: 'pin' } })]}
        refundNote="irrelevante"
      />,
    )
    expect(container.textContent).not.toContain('Nota:')
  })
})

describe('the collapsed summary is the latest FACT', () => {
  const past = new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10)

  it('a cancelled-and-refunded folio summarizes as its last event, never as a phantom departure', () => {
    const future = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10)
    const { container } = renderWithProviders(
      <FolioTimeline
        events={[
          anEvent({ type: 'created', at: 1000 }),
          anEvent({ type: 'cancelled', at: 2000, payload: { source: 'admin', clawback: false } }),
        ]}
        lines={[{ slot_date: future, slot_start_time: '08:00' }]}
        collapsible
      />,
    )
    expect(screen.getByText('Cancelado por administración')).toBeInTheDocument()
    expect(container.textContent).not.toContain('Salida')
  })

  it('a departed Salida IS the latest fact and takes the summary', () => {
    const pastEpoch = Math.floor(Date.parse(`${past}T08:00:00Z`) / 1000)
    renderWithProviders(
      <FolioTimeline
        events={[anEvent({ type: 'created', at: pastEpoch - 86400 })]}
        lines={[{ slot_date: past, slot_start_time: '08:00' }]}
        fulfillment="no_show"
        collapsible
      />,
    )
    expect(screen.getByText('Salida — sin uso')).toBeInTheDocument()
  })
})

describe('the empty timeline', () => {
  it('an empty events array still renders the card with its empty line', () => {
    renderWithProviders(<FolioTimeline events={[]} />)
    expect(screen.getByText('Historial')).toBeInTheDocument()
    expect(screen.getByText('Sin historial')).toBeInTheDocument()
  })

  it('a stale cache without events renders the same empty state', () => {
    renderWithProviders(<FolioTimeline />)
    expect(screen.getByText('Historial')).toBeInTheDocument()
    expect(screen.getByText('Sin historial')).toBeInTheDocument()
  })
})
