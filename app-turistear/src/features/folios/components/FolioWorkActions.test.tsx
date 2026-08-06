import { describe, it, expect } from 'vitest'
import { renderWithProviders, screen } from '../../../test/renderWithProviders'
import { FolioWorkActions } from './FolioWorkActions'
import type { FolioCancellationRequest, FolioDetail } from '../types'

// US-A84 (D14) — the work a folio needs, on the folio itself.
//
// The duplication case below was found by RENDERING, not by reasoning: the live request was shown
// once as work and again as the first row of the history, so one request appeared twice on one
// screen with the same reason under it. jsdom cannot see layout, but it can see that.

const req = (over: Partial<FolioCancellationRequest>): FolioCancellationRequest => ({
  id: 'r1',
  status: 'pending',
  reason: 'Nos cambió el vuelo',
  resolution_note: null,
  resolved_by: null,
  resolved_at: null,
  created_at: 1_700_000_000,
  ...over,
})

const folio = (over: Partial<FolioDetail> = {}): FolioDetail =>
  ({ id: 'f1', status: 'paid', payment_verification: 'not_required', ...over }) as FolioDetail

describe('US-A84 — the folio detail carries its own work', () => {
  it('shows a live request ONCE — as work, not also as history', () => {
    renderWithProviders(
      <FolioWorkActions folio={folio({ folio_requests: [req({})] })} />,
    )

    expect(screen.getByText('El cliente pidió cancelar')).toBeInTheDocument()
    // The history card must not repeat the request the card above is already asking about.
    expect(screen.queryByText('Historial de solicitudes')).toBeNull()
    expect(screen.getAllByText(/Nos cambió el vuelo/)).toHaveLength(1)
  })

  it('shows resolved requests as history — the only surface that can', () => {
    renderWithProviders(
      <FolioWorkActions
        folio={folio({
          folio_requests: [
            req({ id: 'r2', status: 'rejected', resolution_note: 'Fuera de ventana' }),
          ],
        })}
      />,
    )

    // A rejected request left the folio untouched, so nothing else on the record shows it happened.
    // Losing this is how the absorbed tab's history would silently disappear.
    expect(screen.getByText('Historial de solicitudes')).toBeInTheDocument()
    expect(screen.getByText(/Fuera de ventana/)).toBeInTheDocument()
    expect(screen.queryByText('El cliente pidió cancelar')).toBeNull()
  })

  it('offers verification only while the folio is alive', () => {
    const { unmount } = renderWithProviders(
      <FolioWorkActions folio={folio({ payment_verification: 'pending' })} />,
    )
    expect(screen.getByRole('button', { name: 'Verificar' })).toBeInTheDocument()
    // `Rechazar pago` cancels the sale and claws back commission, so it lives HERE and never on the
    // list card (D14).
    expect(screen.getByRole('button', { name: 'Rechazar pago' })).toBeInTheDocument()
    unmount()

    // A rejected payment cancels the folio and leaves its stale 'pending' flag behind (US-A67).
    renderWithProviders(
      <FolioWorkActions folio={folio({ status: 'cancelled', payment_verification: 'pending' })} />,
    )
    expect(screen.queryByRole('button', { name: 'Verificar' })).toBeNull()
  })

  it('renders nothing at all when the folio owes no work', () => {
    const { container } = renderWithProviders(<FolioWorkActions folio={folio()} />)
    expect(container).toBeEmptyDOMElement()
  })
})

// US-AG52 — the review surface must know WHAT it is approving. The backend branched on `kind`
// from the start; without this branch a reschedule petition rendered as "Aprobar cancelación" —
// a button that executes a reschedule while telling the seller it cancels the folio.
describe('US-AG52 — a reschedule petition is reviewed as a reschedule', () => {
  const rescheduleReq = req({
    kind: 'reschedule',
    reason: null,
    folio_line_id: 'l1',
    to_slot_id: 's9',
    to_slot_date: '2026-06-21',
    to_slot_start_time: '09:00',
  })
  const lines = [
    {
      id: 'l1', service_id: 'svc-1', slot_id: 's1', service_name: 'Tour Isla',
      slot_date: '2026-06-14', slot_start_time: '09:00', quantity: 2,
      base_price: 150000, minimum_price: 100000, unit_price: 150000, line_total: 300000,
      extras: [],
    },
  ]

  it('says reagendar, shows from → to, and never offers to cancel', () => {
    renderWithProviders(
      <FolioWorkActions
        folio={folio({ folio_requests: [rescheduleReq], lines } as Partial<FolioDetail>)}
      />,
    )

    expect(screen.getByText('El cliente pidió reagendar')).toBeInTheDocument()
    // The seller decides on "from → to", not on a slot UUID.
    expect(screen.getByText(/Tour Isla · 2026-06-14 09:00/)).toBeInTheDocument()
    expect(screen.getByText(/2026-06-21 09:00/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Aprobar reagenda' })).toBeInTheDocument()
    // The button that lied: approving a reschedule must never read as a cancellation.
    expect(screen.queryByText('Aprobar cancelación')).toBeNull()
    expect(screen.queryByText('El cliente pidió cancelar')).toBeNull()
  })

  it('a resolved reschedule reads as one in the history, with the destination', () => {
    renderWithProviders(
      <FolioWorkActions
        folio={folio({
          folio_requests: [
            req({
              id: 'r3', kind: 'reschedule', status: 'approved', reason: null,
              to_slot_date: '2026-06-21', to_slot_start_time: '09:00',
            }),
          ],
        })}
      />,
    )

    expect(screen.getByText(/Reagenda · Aprobada/)).toBeInTheDocument()
    expect(screen.getByText(/Nuevo horario: 2026-06-21 09:00/)).toBeInTheDocument()
  })

  it('a request without kind is a cancellation — the pre-rename rows keep their meaning', () => {
    renderWithProviders(<FolioWorkActions folio={folio({ folio_requests: [req({})] })} />)
    expect(screen.getByText('El cliente pidió cancelar')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Aprobar cancelación' })).toBeInTheDocument()
  })
})
