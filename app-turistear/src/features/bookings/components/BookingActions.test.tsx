import { describe, it, expect } from 'vitest'
import { renderWithProviders, screen } from '../../../test/renderWithProviders'
import { BookingActions, type BookingFolio } from './BookingActions'

// US-AG52 (D16) — Reagendar exists on BOTH kinds of live folio. The paid branch shipped first as
// API-only: the endpoint moved paid folios and re-signed their QR, S-8b proved it — and no seller
// could reach it, because this component returned null for anything but a live apartado. A
// capability with no button is not a capability.

// The component gates Reagendar on `slot_date >= today` against the REAL clock (UTC), so a
// hardcoded date is a time bomb — it silently expired and the paid branch rendered null.
const FUTURE_DATE = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10)

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
      slot_date: FUTURE_DATE,
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

  // US-AG54 (line-autonomy F3) — with more than one line still owing, each gets its own row
  // (balance + deadline + verbs) and the main button becomes "Liquidar todo". A single-line
  // apartado keeps the quiet single button — no rows, no noise.
  it('a multi-line apartado offers per-line Liquidar/Cancelar and relabels the main button', () => {
    renderWithProviders(
      <BookingActions
        folio={folio({
          status: 'booking',
          total: 150_000,
          amount_paid: 60_000,
          lines: [
            {
              id: 'l1',
              service_id: 'svc-1',
              slot_id: 's1',
              service_name: 'Isla Mujeres',
              slot_date: FUTURE_DATE,
              slot_start_time: '09:00',
              quantity: 1,
              line_type: 'slot' as const,
              money_state: 'booking',
              pending_balance: 55_000,
              booking_expires_at: Math.floor(Date.now() / 1000) + 86_400,
            },
            {
              id: 'l2',
              service_id: 'svc-1',
              slot_id: 's2',
              service_name: 'Chichén Itzá',
              slot_date: FUTURE_DATE,
              slot_start_time: '07:30',
              quantity: 1,
              line_type: 'slot' as const,
              money_state: 'booking',
              pending_balance: 35_000,
              booking_expires_at: Math.floor(Date.now() / 1000) + 5 * 86_400,
            },
          ],
        })}
      />,
    )
    expect(screen.getByRole('button', { name: 'Liquidar todo' })).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Liquidar' })).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: 'Cancelar' })).toHaveLength(2)
    expect(screen.getByText('Isla Mujeres')).toBeInTheDocument()
    expect(screen.getAllByText(/vence en/)).toHaveLength(2) // each line runs its OWN clock (D5)
  })

  it('a mixed apartado (one line already paid) rows only the one still owing', () => {
    renderWithProviders(
      <BookingActions
        folio={folio({
          status: 'booking',
          total: 150_000,
          amount_paid: 115_000,
          lines: [
            {
              id: 'l1',
              service_id: 'svc-1',
              slot_id: 's1',
              service_name: 'Isla Mujeres',
              slot_date: FUTURE_DATE,
              slot_start_time: '09:00',
              quantity: 1,
              line_type: 'slot' as const,
              money_state: 'paid',
              pending_balance: 0,
            },
            {
              id: 'l2',
              service_id: 'svc-1',
              slot_id: 's2',
              service_name: 'Chichén Itzá',
              slot_date: FUTURE_DATE,
              slot_start_time: '07:30',
              quantity: 1,
              line_type: 'slot' as const,
              money_state: 'booking',
              pending_balance: 35_000,
            },
          ],
        })}
      />,
    )
    // One line owing → the single quiet button, scoped by the server to the live remainder.
    expect(screen.getByRole('button', { name: 'Liquidar saldo' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Liquidar todo' })).toBeNull()
    expect(screen.queryAllByRole('button', { name: 'Liquidar' })).toHaveLength(0)
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

  // D19 — a departed line reads no-show and does not move; the courtesy is a discount on a NEW
  // sale. A button whose sheet only offers what the server will refuse is worse than no button.
  it('a paid folio whose only line departed offers no Reagendar', () => {
    const { container } = renderWithProviders(
      <BookingActions
        folio={folio({
          lines: [
            {
              id: 'l1', service_id: 'svc-1', slot_id: 's1', service_name: 'Tour Isla',
              slot_date: '2020-01-01', slot_start_time: '09:00', quantity: 2,
              line_type: 'slot' as const,
            },
          ],
        })}
      />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('a paid line with redeemed passes was consumed — no Reagendar', () => {
    const { container } = renderWithProviders(
      <BookingActions
        folio={folio({
          lines: [
            {
              id: 'l1', service_id: 'svc-1', slot_id: 's1', service_name: 'Tour Isla',
              slot_date: '2099-01-01', slot_start_time: '09:00', quantity: 2,
              line_type: 'slot' as const, redeemed_count: 2,
            },
          ],
        })}
      />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('a cancelled folio offers nothing — its seats are the pool’s', () => {
    const { container } = renderWithProviders(
      <BookingActions folio={folio({ status: 'cancelled' })} />,
    )
    expect(container).toBeEmptyDOMElement()
  })
})
