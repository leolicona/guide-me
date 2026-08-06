import { describe, it, expect, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../../../test/server'
import { renderWithProviders, screen, userEvent } from '../../../test/renderWithProviders'
import { RescheduleSheet } from './RescheduleSheet'

// US-AG52 — the date-first picker. The counter conversation is "¿puedo el domingo?": a DAY,
// answered with the hours that day still has. The sheet must offer only what the server would
// accept — a slot without room for the whole party, or the line's own slot, is a promise the
// submit would break.

const lines = [
  {
    id: 'l1',
    service_id: 'svc-1',
    slot_id: 's-cur',
    service_name: 'Tour Isla',
    slot_date: '2026-08-10',
    slot_start_time: '09:00',
    quantity: 4,
  },
]

/** The selected line's calendar: its own slot, a full-enough sibling, and one too small. */
const serveSlots = () =>
  server.use(
    http.get('/api/pos/services/:id', () =>
      HttpResponse.json({
        service: {
          id: 'svc-1',
          is_flexible: false,
          flex_capacity_pct: 0,
          slots: [
            // The line's CURRENT slot — moving onto itself is not a move.
            { id: 's-cur', date: '2026-08-10', start_time: '09:00', capacity: 20, booked: 4, remaining: 16 },
            // Same day, later — viable.
            { id: 's-late', date: '2026-08-10', start_time: '14:00', capacity: 20, booked: 0, remaining: 20 },
            // Another day — viable.
            { id: 's-sun', date: '2026-08-16', start_time: '09:00', capacity: 20, booked: 2, remaining: 18 },
            // Only 2 seats left for a party of 4 — its whole day must not be offered.
            { id: 's-small', date: '2026-08-20', start_time: '09:00', capacity: 20, booked: 18, remaining: 2 },
          ],
        },
      }),
    ),
  )

const props = { open: true, onClose: vi.fn(), folioId: 'folio-1', lines, isPaid: false }

describe('RescheduleSheet — date first, then that day’s times', () => {
  it('offers only dates where the whole party fits, and never the line’s own slot', async () => {
    serveSlots()
    renderWithProviders(<RescheduleSheet {...props} />)

    await userEvent.click(await screen.findByRole('combobox', { name: /Nueva fecha/ }))
    // Aug 10 appears (s-late fits even though s-cur is excluded); Aug 16 appears; Aug 20 does
    // NOT — its only slot seats 2 of a party of 4.
    expect(await screen.findByRole('option', { name: /10/ })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /16/ })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /20 ago/ })).toBeNull()

    // Picking the day reveals ITS times — without the line's own 09:00.
    await userEvent.click(screen.getByRole('option', { name: /10/ }))
    await userEvent.click(screen.getByRole('combobox', { name: /Horario/ }))
    expect(await screen.findByRole('option', { name: /14:00/ })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /09:00/ })).toBeNull()
  })

  it('submits the chosen slot as one move for the selected line', async () => {
    serveSlots()
    const bodies: Record<string, unknown>[] = []
    server.use(
      http.post('/api/pos/folios/:id/reschedule', async ({ request }) => {
        bodies.push((await request.json()) as Record<string, unknown>)
        return HttpResponse.json({ folio: { id: 'folio-1' } })
      }),
    )
    renderWithProviders(<RescheduleSheet {...props} />)

    await userEvent.click(await screen.findByRole('combobox', { name: /Nueva fecha/ }))
    await userEvent.click(await screen.findByRole('option', { name: /16/ }))
    await userEvent.click(screen.getByRole('combobox', { name: /Horario/ }))
    await userEvent.click(await screen.findByRole('option', { name: /09:00/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Confirmar cambio' }))

    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toEqual({
      moves: [{ folio_line_id: 'l1', to_slot_id: 's-sun' }],
    })
  })

  it('warns on a paid folio that the current ticket will stop working (D16)', async () => {
    serveSlots()
    renderWithProviders(<RescheduleSheet {...props} isPaid />)
    expect(
      await screen.findByText(/el boleto actual deja de funcionar/),
    ).toBeInTheDocument()
  })

  it('says plainly when no other date can seat the group', async () => {
    server.use(
      http.get('/api/pos/services/:id', () =>
        HttpResponse.json({
          service: { id: 'svc-1', is_flexible: false, flex_capacity_pct: 0, slots: [] },
        }),
      ),
    )
    renderWithProviders(<RescheduleSheet {...props} />)
    expect(
      await screen.findByText(/No hay otra fecha con lugar para el grupo/),
    ).toBeInTheDocument()
  })
})
