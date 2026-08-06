import { describe, it, expect } from 'vitest'
import { renderWithProviders, screen } from '../../../test/renderWithProviders'
import { BookingActions, type BookingFolio } from './BookingActions'

// US-AG52 (D16) — Reagendar exists on BOTH kinds of live folio. The paid branch shipped first as
// API-only: the endpoint moved paid folios and re-signed their QR, S-8b proved it — and no seller
// could reach it, because this component returned null for anything but a live apartado. A
// capability with no button is not a capability.

const folio = (over: Partial<BookingFolio> = {}): BookingFolio => ({
  id: 'f1',
  status: 'paid',
  payment_verification: 'verified',
  lines: [
    {
      id: 'l1',
      service_id: 'svc-1',
      slot_id: 's1',
      service_name: 'Tour Isla',
      slot_date: '2026-08-10',
      slot_start_time: '09:00',
      quantity: 2,
      line_type: 'slot' as const,
    },
  ],
  ...over,
})

describe('US-AG52 — where Reagendar lives', () => {
  it('a live apartado offers Liquidar, Reagendar and Cancelar', () => {
    renderWithProviders(
      <BookingActions folio={folio({ status: 'booking', total: 300_000, amount_paid: 90_000 })} />,
    )
    expect(screen.getByRole('button', { name: 'Liquidar saldo' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reagendar' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancelar apartado' })).toBeInTheDocument()
  })

  it('a PAID folio offers Reagendar too (D16)', () => {
    renderWithProviders(<BookingActions folio={folio()} />)
    expect(screen.getByRole('button', { name: 'Reagendar' })).toBeInTheDocument()
    // And nothing apartado-shaped comes with it.
    expect(screen.queryByRole('button', { name: 'Liquidar saldo' })).toBeNull()
  })

  it('a paid folio with only stay lines has nothing to reschedule yet', () => {
    renderWithProviders(
      <BookingActions
        folio={folio({
          lines: [
            {
              id: 'l1', service_id: 'svc-1', service_name: 'Hotel Azul',
              slot_date: null, slot_start_time: null, line_type: 'stay' as const,
            },
          ],
        })}
      />,
    )
    expect(screen.queryByRole('button', { name: 'Reagendar' })).toBeNull()
  })

  it('a cancelled folio offers nothing — its seats are the pool’s', () => {
    const { container } = renderWithProviders(
      <BookingActions folio={folio({ status: 'cancelled' })} />,
    )
    expect(container).toBeEmptyDOMElement()
  })
})
