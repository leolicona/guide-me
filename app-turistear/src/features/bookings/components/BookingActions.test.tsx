import { describe, it, expect, beforeEach, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../../../test/server'
import {
  createTestQueryClient,
  renderWithProviders,
  screen,
  userEvent,
  waitFor,
  within,
} from '../../../test/renderWithProviders'
import { expectNoA11yViolations } from '../../../test/axe'
import { aLinkPayment, aPaymentLink } from '../../../test/handlers/devolada'
import type { OrganizationDevoladaSummary, PaymentLinkView } from '../../devolada'
import { MY_ORG_QUERY_KEY } from '../../organization'
import { BookingActions, type BookingFolio } from './BookingActions'

const anOrganization = (devolada?: OrganizationDevoladaSummary) => ({
  id: 'o1',
  name: 'Descubre Huasca',
  timezone: 'America/Cancun',
  payment_reference_required: true,
  ...(devolada ? { devolada } : {}),
})

// Every apartado mounts its settle sheets, which read the organization (US-A88, devolada D16).
const orgWith = (devolada?: OrganizationDevoladaSummary) =>
  http.get('/api/organizations/me', () =>
    HttpResponse.json({ organization: anOrganization(devolada) }),
  )

beforeEach(() => {
  server.use(orgWith())
})

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

// --- devolada-transfer-verification US3, US4 (research D8, D13, D16; contracts/turistear-api.md
// § Action copy) ---------------------------------------------------------------------------------
//
// While a settlement enlace is open, it is on the screen to send. A settle that would close it waits
// only while its payment is in flight: «Liquidación en verificación» stands in its place. A line
// cancellation the server refuses meanwhile (SETTLEMENT_IN_PROGRESS) says why, and one that replaced
// the enlace says the customer's enlace changed. The copy is the contract's.

const VERIFYING = 'Liquidación en verificación'
const IN_PROGRESS = 'La venta ya tiene un enlace de pago para liquidar; espera su resultado'

const IN_A_DAY = Math.floor(Date.now() / 1000) + 86_400

const settlementLink = (over: Partial<PaymentLinkView> = {}) =>
  aPaymentLink({
    id: 'link-settle-1',
    kind: 'settlement',
    amount: 90_000,
    expires_at: Math.floor(Date.now() / 1000) + 3_600,
    ...over,
  }) as PaymentLinkView

/** A two-line apartado, both lines still owing, as the sale detail reads it. */
const twoLineApartado = (over: Partial<BookingFolio> = {}): BookingFolio =>
  folio({
    status: 'booking',
    total: 150_000,
    amount_paid: 60_000,
    payment_method: 'transfer',
    customer_name: 'María Fernández',
    customer_phone: '9981234567',
    agent: { name: 'Ana' },
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
        booking_expires_at: IN_A_DAY,
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
        booking_expires_at: IN_A_DAY,
      },
    ],
    ...over,
  })

/** A one-line apartado: its settle is the main button. */
const oneLineApartado = (over: Partial<BookingFolio> = {}): BookingFolio =>
  folio({
    status: 'booking',
    total: 300_000,
    amount_paid: 90_000,
    pending_balance: 210_000,
    payment_method: 'transfer',
    customer_name: 'María Fernández',
    customer_phone: '9981234567',
    agent: { name: 'Ana' },
    ...over,
  })

/** The row of one owing line, named by its service. */
const lineRow = (name: string) => screen.getByRole('group', { name })

/** The settlement enlace's payment, as Devolada is still verifying it: in flight. */
const inFlight = (over: Partial<PaymentLinkView> = {}) =>
  settlementLink({ label: 'validating', payment: aLinkPayment() as PaymentLinkView['payment'], ...over })

const REPLACED = 'El enlace de pago cambió — vuelve a enviarlo'
const NOT_REPLACED = 'El enlace de pago cambió y no se pudo crear el nuevo — vuelve a liquidar el saldo'

describe('devolada-transfer-verification US3, US4 — while a settlement enlace is open', () => {
  it('waiting for its first payment, the whole-sale enlace leads and «Liquidar saldo» stays: settling another way closes it', async () => {
    const { container } = renderWithProviders(
      <BookingActions folio={oneLineApartado({ payment_links: [settlementLink({ amount: 210_000 })] })} />,
    )

    expect(screen.getByRole('heading', { name: 'Enlace de pago' })).toBeInTheDocument()
    expect(screen.getByLabelText(/Monto del enlace: \$2,100\.00/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cobrar por WhatsApp' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Liquidar saldo' })).toBeInTheDocument()
    expect(screen.queryByText(VERIFYING)).not.toBeInTheDocument()
    await expectNoA11yViolations(container)
  })

  it('with its payment in flight, «Liquidación en verificación» replaces «Liquidar saldo»', async () => {
    const { container } = renderWithProviders(
      <BookingActions folio={oneLineApartado({ payment_links: [inFlight({ amount: 210_000 })] })} />,
    )

    expect(screen.getByRole('heading', { name: 'Enlace de pago' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Liquidar saldo' })).not.toBeInTheDocument()
    // A state, never colour alone: the chip carries its icon and its words.
    const chip = screen.getByText(VERIFYING).closest('.MuiChip-root')!
    expect(chip.querySelector('svg')).toBeInTheDocument()
    // The rest of the apartado's verbs are not the enlace's business.
    expect(screen.getByRole('button', { name: 'Reagendar' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancelar apartado' })).toBeInTheDocument()
    await expectNoA11yViolations(container)
  })

  it('a whole-sale enlace in flight on a multi-line apartado holds every settle, and leaves each line its Cancelar', () => {
    renderWithProviders(<BookingActions folio={twoLineApartado({ payment_links: [inFlight()] })} />)

    expect(screen.queryByRole('button', { name: 'Liquidar todo' })).not.toBeInTheDocument()
    expect(screen.queryAllByRole('button', { name: 'Liquidar' })).toHaveLength(0)
    // Said once, where «Liquidar todo» was — not once per line.
    expect(screen.getAllByText(VERIFYING)).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: 'Cancelar' })).toHaveLength(2)
  })

  it('one line’s enlace in flight: the chip on its line and in the main button’s place; the other line settles on', () => {
    renderWithProviders(
      <BookingActions
        folio={twoLineApartado({ payment_links: [inFlight({ folio_line_id: 'l1', amount: 55_000 })] })}
      />,
    )

    const held = lineRow('Isla Mujeres')
    expect(within(held).getByText(VERIFYING)).toBeInTheDocument()
    expect(within(held).queryByRole('button', { name: 'Liquidar' })).not.toBeInTheDocument()
    // Settling the other line leaves this enlace open, so the server takes it.
    expect(within(lineRow('Chichén Itzá')).getByRole('button', { name: 'Liquidar' })).toBeInTheDocument()
    // Settling the whole sale would close it: held.
    expect(screen.queryByRole('button', { name: 'Liquidar todo' })).not.toBeInTheDocument()
    expect(screen.getAllByText(VERIFYING)).toHaveLength(2)
    expect(screen.getByLabelText(/Monto del enlace: \$550\.00/)).toBeInTheDocument()
  })

  it('one line’s enlace waiting for its first payment holds nothing', () => {
    renderWithProviders(
      <BookingActions folio={twoLineApartado({ payment_links: [settlementLink({ folio_line_id: 'l1' })] })} />,
    )

    expect(screen.getAllByRole('button', { name: 'Liquidar' })).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Liquidar todo' })).toBeInTheDocument()
    expect(screen.queryByText(VERIFYING)).not.toBeInTheDocument()
  })

  it.each([
    ['a settlement enlace that expired unpaid', settlementLink({ state: 'expired', label: 'not_received' })],
    ['an open enlace that collects the deposit', settlementLink({ kind: 'deposit' })],
  ])('%s leaves the settle buttons, and no card here', (_, link) => {
    renderWithProviders(<BookingActions folio={oneLineApartado({ payment_links: [link] })} />)

    expect(screen.getByRole('button', { name: 'Liquidar saldo' })).toBeInTheDocument()
    expect(screen.queryByText(VERIFYING)).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Enlace de pago' })).not.toBeInTheDocument()
  })

  it('«Cobrar por WhatsApp» sends the settlement’s enlace, signed by the sale’s seller and organization', async () => {
    const opened = vi.spyOn(window, 'open').mockReturnValue(null)
    // The organization already loaded, as it has by the time a seller opens a sale.
    const queryClient = createTestQueryClient()
    queryClient.setQueryData(MY_ORG_QUERY_KEY, anOrganization())
    renderWithProviders(
      <BookingActions folio={oneLineApartado({ payment_links: [settlementLink({ amount: 210_000 })] })} />,
      { queryClient },
    )

    await userEvent.click(screen.getByRole('button', { name: 'Cobrar por WhatsApp' }))
    const url = decodeURIComponent(String(opened.mock.calls[0]![0]))
    expect(url).toContain('https://wa.me/52')
    expect(url).toContain('Hola María Fernández, te escribe Ana de Descubre Huasca.')
    expect(url).toContain('Para liquidar tu reserva, transfiere $2,100.00')
    expect(url).toContain('https://link.devoladapago.com/p/kq7m2x9d4tbn3wpa')
  })

  it('a line cancellation that replaced the whole-sale enlace says so, with the new enlace to send (US4)', async () => {
    const replacement = settlementLink({ id: 'link-settle-2', amount: 35_000, url: 'https://link.devoladapago.com/p/nuevo' })
    server.use(
      http.post('/api/pos/folios/:id/lines/:lineId/cancel', () =>
        HttpResponse.json({
          folio: twoLineApartado(),
          cancellation: { refund: 0, retention: 0, kept_commission: 0, reversed_commission: 0 },
          payment_link: replacement,
        }),
      ),
    )
    const { container, rerender } = renderWithProviders(
      <BookingActions folio={twoLineApartado({ payment_links: [settlementLink()] })} />,
    )

    await userEvent.click(within(lineRow('Isla Mujeres')).getByRole('button', { name: 'Cancelar' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Cancelar actividad' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    // Until the sale is read again, the answer's enlace stands in for the one it replaced.
    expect(await screen.findByText(REPLACED)).toBeInTheDocument()
    expect(screen.getAllByRole('heading', { name: 'Enlace de pago' })).toHaveLength(1)
    expect(screen.getByLabelText(/Monto del enlace: \$350\.00/)).toBeInTheDocument()
    await expectNoA11yViolations(container)

    // Once the replacement no longer collects, the notice goes with it, and the sale's own open
    // enlace shows.
    rerender(
      <BookingActions
        folio={twoLineApartado({
          payment_links: [
            settlementLink({ id: 'link-settle-3', folio_line_id: 'l2', amount: 20_000 }),
            { ...replacement, state: 'closed', label: 'closed' },
          ],
        })}
      />,
    )
    expect(screen.queryByText(REPLACED)).not.toBeInTheDocument()
    expect(screen.getByLabelText(/Monto del enlace: \$200\.00/)).toBeInTheDocument()
  })

  it('…and when no replacement could be created, says to settle the balance again (US4)', async () => {
    server.use(
      http.post('/api/pos/folios/:id/lines/:lineId/cancel', () =>
        HttpResponse.json({
          folio: twoLineApartado(),
          cancellation: { refund: 0, retention: 0, kept_commission: 0, reversed_commission: 0 },
          payment_link: null,
          payment_link_error: 'DEVOLADA_UNAVAILABLE',
        }),
      ),
    )
    renderWithProviders(<BookingActions folio={twoLineApartado({ payment_links: [settlementLink()] })} />)

    await userEvent.click(within(lineRow('Isla Mujeres')).getByRole('button', { name: 'Cancelar' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Cancelar actividad' }))
    expect(await screen.findByText(NOT_REPLACED)).toBeInTheDocument()
    expect(screen.queryByText(REPLACED)).not.toBeInTheDocument()
  })

  it('a line cancellation without an enlace to replace says nothing about enlaces', async () => {
    server.use(
      http.post('/api/pos/folios/:id/lines/:lineId/cancel', () =>
        HttpResponse.json({
          folio: twoLineApartado(),
          cancellation: { refund: 0, retention: 0, kept_commission: 0, reversed_commission: 0 },
        }),
      ),
    )
    renderWithProviders(<BookingActions folio={twoLineApartado()} />)

    await userEvent.click(within(lineRow('Isla Mujeres')).getByRole('button', { name: 'Cancelar' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Cancelar actividad' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.queryByText(REPLACED)).not.toBeInTheDocument()
    expect(screen.queryByText(NOT_REPLACED)).not.toBeInTheDocument()
  })

  it('a line cancellation refused while the enlace’s payment is in flight says why, and keeps only the way out', async () => {
    server.use(
      http.post('/api/pos/folios/:id/lines/:lineId/cancel', () =>
        HttpResponse.json(
          { error: { code: 'SETTLEMENT_IN_PROGRESS', message: 'A settlement link is open' } },
          { status: 409 },
        ),
      ),
    )
    renderWithProviders(<BookingActions folio={twoLineApartado({ payment_links: [inFlight()] })} />)

    await userEvent.click(within(lineRow('Chichén Itzá')).getByRole('button', { name: 'Cancelar' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Cancelar actividad' }))

    // Closed sheets stay mounted, hidden: what the seller reads is the open one.
    const sheet = screen.getByRole('dialog')
    expect(await within(sheet).findByText(IN_PROGRESS)).toBeInTheDocument()
    expect(within(sheet).queryByText(/No se pudo cancelar/)).not.toBeInTheDocument()
    // Retrying cannot succeed until the enlace resolves.
    expect(within(sheet).queryByRole('button', { name: 'Cancelar actividad' })).not.toBeInTheDocument()
    await expectNoA11yViolations(document.body)

    // The refusal belonged to that sheet: the next one opens clean.
    await userEvent.click(within(sheet).getByRole('button', { name: 'Conservar' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await userEvent.click(within(lineRow('Isla Mujeres')).getByRole('button', { name: 'Cancelar' }))
    const next = await screen.findByRole('dialog')
    expect(within(next).getByRole('button', { name: 'Cancelar actividad' })).toBeInTheDocument()
    expect(within(next).queryByText(IN_PROGRESS)).not.toBeInTheDocument()
  })

  // FR-010 — a transfer settled on the manual path closes its sheet as settled, the refetched sale
  // reads paid, and BookingActions switches to its paid branch: the alert must survive the switch.
  it('the alert of a settlement that got no enlace outlives the sale turning paid', async () => {
    server.use(
      orgWith({ status: 'connected', mode: 'test' }),
      http.post('/api/pos/folios/:id/settle', () =>
        HttpResponse.json({
          folio: { ...oneLineApartado(), status: 'paid', payment_verification: 'pending' },
          payment_link: null,
          payment_link_error: 'DEVOLADA_UNAVAILABLE',
        }),
      ),
    )
    const { rerender } = renderWithProviders(<BookingActions folio={oneLineApartado()} />)

    await userEvent.click(screen.getByRole('button', { name: 'Liquidar saldo' }))
    const sheet = await screen.findByRole('dialog')
    await within(sheet).findByText('Se generará un enlace de pago para cobrar por WhatsApp')
    await userEvent.click(within(sheet).getByRole('button', { name: 'Cobrar y liquidar' }))

    const copy = 'No se pudo crear el enlace de pago; un administrador verificará la transferencia'
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(await screen.findByRole('alert')).toHaveTextContent(copy)

    // The refetch: the same sale, now paid and awaiting an admin's verification.
    rerender(<BookingActions folio={folio({ payment_verification: 'pending' })} />)
    expect(screen.getByRole('button', { name: 'Reagendar' })).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent(copy)
  })
})
