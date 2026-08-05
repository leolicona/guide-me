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
