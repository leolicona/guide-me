import { describe, it, expect, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../../../test/server'
import { renderWithProviders, screen, userEvent, waitFor } from '../../../test/renderWithProviders'
import { RescheduleSheet } from './RescheduleSheet'

// US-AG52 — the day pager. It opens on the FIRST day with room for the group, shows that day's
// remaining times as chips, and ◀ ▶ step ONLY between days that can seat everyone — a day whose
// only slot is too small simply does not exist on the axis (US-AG33's rule: never present a day
// the group cannot take). The sheet must never offer what the server would refuse.

const iso = (offsetDays: number) =>
  new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10)

const lines = [
  {
    id: 'l1',
    service_id: 'svc-1',
    slot_id: 's-cur',
    service_name: 'Tour Isla',
    slot_date: iso(1),
    slot_start_time: '09:00',
    quantity: 4,
  },
]

/** The selected line's calendar: its own slot, siblings with room, and one day too small. */
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
            { id: 's-cur', date: iso(1), start_time: '09:00', capacity: 20, booked: 4, remaining: 16 },
            // Same day, later — viable: tomorrow is the first day the pager shows.
            { id: 's-late', date: iso(1), start_time: '14:00', capacity: 20, booked: 0, remaining: 20 },
            // Two days out: only 2 seats for a party of 4 — this day must NOT be on the axis.
            { id: 's-small', date: iso(2), start_time: '09:00', capacity: 20, booked: 18, remaining: 2 },
            // Five days out — viable: the ▶ arrow lands HERE, skipping the too-small day.
            { id: 's-far', date: iso(5), start_time: '07:30', capacity: 20, booked: 2, remaining: 18 },
          ],
        },
      }),
    ),
  )

const props = { open: true, onClose: vi.fn(), folioId: 'folio-1', lines, isPaid: false }

describe('RescheduleSheet — the day pager', () => {
  it('opens on the first day with room, without the line’s own slot', async () => {
    serveSlots()
    renderWithProviders(<RescheduleSheet {...props} />)

    // Tomorrow's only offer is 14:00 — the line's own 09:00 is not a move.
    expect(await screen.findByRole('button', { name: /14:00/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /09:00/ })).toBeNull()
    // The nearest day is already on screen: no tap needed to see the soonest real options.
    expect(screen.getByRole('button', { name: 'Día anterior' })).toBeDisabled()
  })

  it('▶ steps to the NEXT day with room, skipping a day the group does not fit', async () => {
    serveSlots()
    renderWithProviders(<RescheduleSheet {...props} />)
    await screen.findByRole('button', { name: /14:00/ })

    await userEvent.click(screen.getByRole('button', { name: 'Día siguiente' }))
    // Landed on day +5 (07:30), never on day +2 whose only slot seats 2 of 4.
    expect(await screen.findByRole('button', { name: /07:30/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /14:00/ })).toBeNull()
    // The axis ends here, and the way back works.
    expect(screen.getByRole('button', { name: 'Día siguiente' })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: 'Día anterior' }))
    expect(await screen.findByRole('button', { name: /14:00/ })).toBeInTheDocument()
  })

  it('the calendar is on screen from the start, and a tap jumps the pager', async () => {
    serveSlots()
    renderWithProviders(<RescheduleSheet {...props} />)
    await screen.findByRole('button', { name: /14:00/ })

    // No toggle to find: the month grid IS the first thing after the current departure.
    await userEvent.click(await screen.findByRole('button', { name: iso(5) }))
    // The pager now shows the tapped day's times.
    expect(await screen.findByRole('button', { name: /07:30/ })).toBeInTheDocument()
  })

  it('the calendar disables a day without room for the group', async () => {
    serveSlots()
    renderWithProviders(<RescheduleSheet {...props} />)
    await screen.findByRole('button', { name: /14:00/ })

    // Day +2's only slot seats 2 of a party of 4 — the calendar must not let the tap happen.
    expect(await screen.findByRole('button', { name: iso(2) })).toBeDisabled()
  })

  it('the calendar dots the days that fit the group, and only those', async () => {
    serveSlots()
    renderWithProviders(<RescheduleSheet {...props} />)
    await screen.findByRole('button', { name: /14:00/ })
    await screen.findByRole('button', { name: iso(5) })
    // The dot is the same promise the POS calendar makes: "this day fits the group." Day +5
    // earns one; the too-small day +2 must not — a dot on it would promise what the tap refuses.
    // (Day +1 is the pager's current day = the calendar's endpoint, where the fill says it.)
    const dotted = screen.getAllByTestId('availability-dot')
    const dottedDays = dotted.map((d) => d.closest('button')?.getAttribute('aria-label'))
    expect(dottedDays).toContain(iso(5))
    expect(dottedDays).not.toContain(iso(2))
  })

  it('submits the chosen slot as one move, behind the Reagendar button', async () => {
    serveSlots()
    const bodies: Record<string, unknown>[] = []
    server.use(
      http.post('/api/pos/folios/:id/reschedule', async ({ request }) => {
        bodies.push((await request.json()) as Record<string, unknown>)
        return HttpResponse.json({ folio: { id: 'folio-1' } })
      }),
    )
    renderWithProviders(<RescheduleSheet {...props} />)

    await userEvent.click(await screen.findByRole('button', { name: /14:00/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Reagendar' }))

    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toEqual({
      moves: [{ folio_line_id: 'l1', to_slot_id: 's-late' }],
    })
  })

  // The pre-move warning was REMOVED (user decision): the ticket's death is stated on the handoff
  // screen, at the moment it becomes true, and BUG-030 makes the replaced QR actually stop
  // admitting. The picker carries no copy the seller has to read past.
  it('the picker says nothing about tickets before the move', async () => {
    serveSlots()
    renderWithProviders(<RescheduleSheet {...props} isPaid />)
    await screen.findByRole('button', { name: /14:00/ })
    expect(screen.queryByText(/el boleto actual deja de funcionar/)).toBeNull()
    expect(screen.queryByText(/queda registrada a tu nombre/)).toBeNull()
    expect(screen.queryByText(/^Ahora:/)).toBeNull()
  })

  // D16, second half — the sheet does not end at the confirm on a paid folio. The move just
  // killed a ticket the customer may have saved, so the replacement's send must be ONE tap away
  // from the person who promised it — the same WhatsApp send the receipt uses.
  const servePaidMove = () =>
    server.use(
      http.post('/api/pos/folios/:id/reschedule', () =>
        HttpResponse.json({
          folio: {
            id: 'folio-1',
            customer_name: 'Ana',
            customer_phone: '+529981234567',
            total: 240_000,
            amount_paid: 240_000,
            lines: [],
            portal_link: 'https://api.local/portal/tok-new',
          },
        }),
      ),
    )

  it('a paid move chains straight into sending the new ticket', async () => {
    serveSlots()
    servePaidMove()
    const onClose = vi.fn()
    renderWithProviders(<RescheduleSheet {...props} isPaid onClose={onClose} />)

    await userEvent.click(await screen.findByRole('button', { name: /14:00/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Reagendar' }))

    // The sheet became the handoff instead of closing.
    expect(await screen.findByText('Fecha movida')).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /Enviar boletos por WhatsApp/ })).toBeEnabled()
  })

  // ONE tap does all three things. A second footer button ("Listo") beside the send was a tap
  // that bought nothing and competed with the only action worth taking there.
  it('the send opens WhatsApp, RECORDS the delivery and closes — in a single tap', async () => {
    serveSlots()
    servePaidMove()
    const onClose = vi.fn()
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    const marked: string[] = []
    server.use(
      http.post('/api/pos/folios/:id/ticket-delivery', ({ params }) => {
        marked.push(String(params.id))
        return HttpResponse.json({ folio: { id: 'folio-1', tickets_sent_at: 1_800_000_000 } })
      }),
    )
    renderWithProviders(<RescheduleSheet {...props} isPaid onClose={onClose} />)

    await userEvent.click(await screen.findByRole('button', { name: /14:00/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Reagendar' }))
    await screen.findByText('Fecha movida')

    // The handoff carries NO footer button — the send is the whole footer.
    expect(screen.queryByRole('button', { name: 'Listo' })).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: /Enviar boletos por WhatsApp/ }))

    // 1. WhatsApp opened with the customer's message…
    expect(open).toHaveBeenCalledWith(expect.stringContaining('wa.me'), '_blank')
    // 2. …the delivery was RECORDED (the folio stops reading "pendiente de enviar")…
    await waitFor(() => expect(marked).toEqual(['folio-1']))
    // 3. …and the sheet closed itself. No second tap.
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    open.mockRestore()
  })

  it('a live apartado’s move just closes — no ticket existed to replace', async () => {
    serveSlots()
    const onClose = vi.fn()
    server.use(
      http.post('/api/pos/folios/:id/reschedule', () =>
        HttpResponse.json({ folio: { id: 'folio-1' } }),
      ),
    )
    renderWithProviders(<RescheduleSheet {...props} onClose={onClose} />)

    await userEvent.click(await screen.findByRole('button', { name: /14:00/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Reagendar' }))
    expect(onClose).toHaveBeenCalled()
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
