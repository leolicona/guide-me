import { useState } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../../../test/server'
import { renderWithProviders, screen, userEvent, waitFor } from '../../../test/renderWithProviders'
import { expectNoA11yViolations } from '../../../test/axe'
import { aPaymentLink } from '../../../test/handlers/devolada'
import type { OrganizationDevoladaSummary } from '../../devolada'
import { SettleSheet, type SettleSheetProps } from './SettleSheet'

// US-LG03. The labels asserted here are the SAME strings e2e/settle-breakdown.spec.ts queries, on
// purpose: a rename should break this 30 ms test rather than a 90 s Playwright run against a
// deployed environment.

const props = {
  open: true,
  folioId: 'folio-1',
  balance: 120_000,
  defaultMethod: 'cash' as const,
}

// US-A88 — the sheet reads the org to learn whether a transfer demands its reference. Registered in
// `beforeEach` (MSW resets handlers per test); individual tests override to flip the requirement.
// devolada-transfer-verification — and whether an enlace collects the transfer instead.
const orgWith = (
  payment_reference_required: boolean,
  devolada?: OrganizationDevoladaSummary,
) =>
  http.get('/api/organizations/me', () =>
    HttpResponse.json({
      organization: {
        id: 'o1',
        name: 'Descubre Huasca',
        timezone: 'America/Cancun',
        payment_reference_required,
        ...(devolada ? { devolada } : {}),
      },
    }),
  )

beforeEach(() => {
  server.use(orgWith(true))
})

/** Capture the settle request body so the payload contract can be asserted, not assumed. */
function captureSettle() {
  const bodies: Record<string, unknown>[] = []
  server.use(
    http.post('/api/pos/folios/:id/settle', async ({ request }) => {
      bodies.push((await request.json()) as Record<string, unknown>)
      return HttpResponse.json({ folio: { id: 'folio-1', status: 'paid' } })
    }),
  )
  return bodies
}

describe('SettleSheet', () => {
  it('leads with the balance being collected, announced for screen readers', () => {
    renderWithProviders(<SettleSheet {...props} onClose={vi.fn()} />)
    expect(screen.getByText('Saldo por cobrar')).toBeInTheDocument()
    expect(screen.getByLabelText(/Saldo por cobrar: \$1,200\.00/)).toBeInTheDocument()
  })

  it('pre-selects the deposit method, so the common case is one tap', () => {
    renderWithProviders(<SettleSheet {...props} defaultMethod="transfer" onClose={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Transferencia' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })

  // D1 — checkout offers only cash + transfer; card/link survive in the type union for historical
  // folios and must NOT appear as choices.
  it('offers exactly Efectivo and Transferencia', () => {
    renderWithProviders(<SettleSheet {...props} onClose={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Efectivo' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Transferencia' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Tarjeta|Link/i })).not.toBeInTheDocument()
  })

  it('asks for no reference on a cash settle, and sends none', async () => {
    const bodies = captureSettle()
    renderWithProviders(<SettleSheet {...props} onClose={vi.fn()} />)

    expect(screen.queryByLabelText(/Referencia/)).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Cobrar y liquidar' }))

    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]).toEqual({ method: 'cash' })
    expect(bodies[0]).not.toHaveProperty('payment_reference')
  })

  describe('a transfer requires its bank reference (US-AG41)', () => {
    it('reveals the reference field only after Transferencia is picked', async () => {
      renderWithProviders(<SettleSheet {...props} onClose={vi.fn()} />)
      expect(screen.queryByLabelText(/Referencia de la transferencia/)).not.toBeInTheDocument()

      await userEvent.click(screen.getByRole('button', { name: 'Transferencia' }))
      expect(screen.getByLabelText(/Referencia de la transferencia/)).toBeInTheDocument()
    })

    it('blocks submit until the reference is long enough', async () => {
      renderWithProviders(<SettleSheet {...props} onClose={vi.fn()} />)
      await userEvent.click(screen.getByRole('button', { name: 'Transferencia' }))

      const submit = screen.getByRole('button', { name: 'Cobrar y liquidar' })
      expect(submit).toBeDisabled()

      await userEvent.type(screen.getByLabelText(/Referencia de la transferencia/), 'ABC')
      expect(submit).toBeDisabled()
      expect(screen.getByText('Captura al menos 4 caracteres.')).toBeInTheDocument()

      await userEvent.type(screen.getByLabelText(/Referencia de la transferencia/), 'D')
      expect(submit).toBeEnabled()
    })

    it('treats a whitespace-only reference as empty', async () => {
      renderWithProviders(<SettleSheet {...props} onClose={vi.fn()} />)
      await userEvent.click(screen.getByRole('button', { name: 'Transferencia' }))
      await userEvent.type(screen.getByLabelText(/Referencia de la transferencia/), '      ')
      expect(screen.getByRole('button', { name: 'Cobrar y liquidar' })).toBeDisabled()
    })

    it('sends the trimmed reference with the method', async () => {
      const bodies = captureSettle()
      renderWithProviders(<SettleSheet {...props} onClose={vi.fn()} />)

      await userEvent.click(screen.getByRole('button', { name: 'Transferencia' }))
      await userEvent.type(
        screen.getByLabelText(/Referencia de la transferencia/),
        '  BBVA 0099887766  ',
      )
      await userEvent.click(screen.getByRole('button', { name: 'Cobrar y liquidar' }))

      await waitFor(() => expect(bodies).toHaveLength(1))
      expect(bodies[0]).toEqual({ method: 'transfer', payment_reference: 'BBVA 0099887766' })
    })
  })

  // US-A88 — the org turned the requirement off: an EMPTY reference settles, a partial one still
  // doesn't (4–64 if present), and nothing about verification changes client-side.
  describe('an org with the reference optional (US-A88)', () => {
    beforeEach(() => {
      server.use(orgWith(false))
    })

    it('labels the field optional and settles without a reference, sending none', async () => {
      const bodies = captureSettle()
      renderWithProviders(<SettleSheet {...props} onClose={vi.fn()} />)
      await userEvent.click(screen.getByRole('button', { name: 'Transferencia' }))

      expect(
        await screen.findByLabelText(/Referencia de la transferencia \(opcional\)/),
      ).toBeInTheDocument()
      const submit = screen.getByRole('button', { name: 'Cobrar y liquidar' })
      await waitFor(() => expect(submit).toBeEnabled())
      await userEvent.click(submit)

      await waitFor(() => expect(bodies).toHaveLength(1))
      expect(bodies[0]).toEqual({ method: 'transfer' })
      expect(bodies[0]).not.toHaveProperty('payment_reference')
    })

    it('still rejects a too-short reference once typing starts', async () => {
      renderWithProviders(<SettleSheet {...props} onClose={vi.fn()} />)
      await userEvent.click(screen.getByRole('button', { name: 'Transferencia' }))

      await userEvent.type(
        await screen.findByLabelText(/Referencia de la transferencia \(opcional\)/),
        'ABC',
      )
      expect(screen.getByRole('button', { name: 'Cobrar y liquidar' })).toBeDisabled()
      expect(screen.getByText('Captura al menos 4 caracteres.')).toBeInTheDocument()
    })

    it('sends the reference when the agent does capture one', async () => {
      const bodies = captureSettle()
      renderWithProviders(<SettleSheet {...props} onClose={vi.fn()} />)
      await userEvent.click(screen.getByRole('button', { name: 'Transferencia' }))

      await userEvent.type(
        await screen.findByLabelText(/Referencia de la transferencia \(opcional\)/),
        'BBVA 0099887766',
      )
      await userEvent.click(screen.getByRole('button', { name: 'Cobrar y liquidar' }))

      await waitFor(() => expect(bodies).toHaveLength(1))
      expect(bodies[0]).toEqual({ method: 'transfer', payment_reference: 'BBVA 0099887766' })
    })
  })

  it('closes only after the settle succeeds', async () => {
    captureSettle()
    const onClose = vi.fn()
    renderWithProviders(<SettleSheet {...props} onClose={onClose} />)

    await userEvent.click(screen.getByRole('button', { name: 'Cobrar y liquidar' }))
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
  })

  it('stays open and explains itself when the settle fails', async () => {
    server.use(
      http.post('/api/pos/folios/:id/settle', () =>
        HttpResponse.json(
          { error: { code: 'BOOKING_EXPIRED', message: 'El apartado venció' } },
          { status: 409 },
        ),
      ),
    )
    const onClose = vi.fn()
    renderWithProviders(<SettleSheet {...props} onClose={onClose} />)

    await userEvent.click(screen.getByRole('button', { name: 'Cobrar y liquidar' }))

    await waitFor(() =>
      expect(screen.getByText(/No se pudo liquidar el saldo/)).toBeInTheDocument(),
    )
    // The agent keeps their input and can retry — a closed sheet would lose the reference.
    expect(onClose).not.toHaveBeenCalled()
  })

  it('has no accessibility violations', async () => {
    renderWithProviders(<SettleSheet {...props} onClose={vi.fn()} />)
    await expectNoA11yViolations(document.body)
  })
})

// --- devolada-transfer-verification US3 (research D8, D16, D19; contracts/turistear-api.md
// § Checkout and settlement, § Action copy) ------------------------------------------------------
//
// Connected to Devolada, a transfer settlement records nothing: the server answers the enlace that
// collects the balance, and the sheet shows it instead of closing as settled. When no enlace could
// be created, the settlement WAS recorded on today's manual path, so the sheet closes as settled and
// says why (FR-010). The copy is asserted verbatim: it is the contract's.

const BY_LINK = 'Se generará un enlace de pago para cobrar por WhatsApp'
const BROKEN = 'El cobro con Devolada tiene fallas; un administrador verificará la transferencia'
const IN_PROGRESS = 'La venta ya tiene un enlace de pago para liquidar; espera su resultado'

const connected: OrganizationDevoladaSummary = { status: 'connected', mode: 'test' }

/** The apartado as the settle answers it (`readFolioDetail`): still a booking, owing its balance. */
const anApartado = (over: Record<string, unknown> = {}) => ({
  id: 'folio-1',
  agent: { id: 'a1', name: 'Ana' },
  status: 'booking',
  customer_name: 'María Fernández',
  customer_phone: '9981234567',
  total: 150_000,
  amount_paid: 30_000,
  pending_balance: 120_000,
  payment_links: [],
  lines: [
    {
      id: 'line-1',
      service_name: 'Tour Isla Mujeres',
      line_type: 'slot',
      slot_date: '2030-06-15',
      slot_start_time: '09:00',
      quantity: 2,
    },
  ],
  ...over,
})

const aSettlementLink = (over: Record<string, unknown> = {}) =>
  aPaymentLink({
    id: 'link-settle-1',
    kind: 'settlement',
    amount: 120_000,
    expires_at: Math.floor(Date.now() / 1000) + 3_600,
    ...over,
  })

/** Answer every settle, whole sale or one line, with `body`, and record what was sent. */
function answerSettle(body: Record<string, unknown>, init?: ResponseInit) {
  const sent: { path: string; body: Record<string, unknown> }[] = []
  const handle = async ({ request }: { request: Request }) => {
    sent.push({
      path: new URL(request.url).pathname,
      body: (await request.json()) as Record<string, unknown>,
    })
    return HttpResponse.json(body, init)
  }
  server.use(
    http.post('/api/pos/folios/:id/settle', handle),
    http.post('/api/pos/folios/:id/lines/:lineId/settle', handle),
  )
  return sent
}

/** The host's side of the contract: `onClose` really closes, and the sheet can be opened again. */
function Host(over: Partial<SettleSheetProps>) {
  const [open, setOpen] = useState(true)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Liquidar saldo
      </button>
      <SettleSheet {...props} {...over} open={open} onClose={() => setOpen(false)} />
    </>
  )
}

describe('devolada-transfer-verification US3 — connected, the balance is collected by enlace', () => {
  beforeEach(() => {
    server.use(orgWith(true, connected))
  })

  it('a transfer asks for no reference: the enlace replaces it', async () => {
    const sent = answerSettle({ folio: anApartado(), payment_link: aSettlementLink() })
    renderWithProviders(<SettleSheet {...props} defaultMethod="transfer" onClose={vi.fn()} />)

    expect(await screen.findByText(BY_LINK)).toBeInTheDocument()
    expect(screen.queryByLabelText(/Referencia de la transferencia/)).not.toBeInTheDocument()

    // A required reference no longer blocks the submit, and none is sent (FR-009).
    const submit = screen.getByRole('button', { name: 'Cobrar y liquidar' })
    expect(submit).toBeEnabled()
    await userEvent.click(submit)
    await waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0].body).toEqual({ method: 'transfer' })
    await expectNoA11yViolations(document.body)
  })

  it('submitting shows the enlace instead of closing as settled, and «Cobrar por WhatsApp» sends it', async () => {
    const opened = vi.spyOn(window, 'open').mockReturnValue(null)
    answerSettle({ folio: anApartado(), payment_link: aSettlementLink() })
    const onClose = vi.fn()
    renderWithProviders(<SettleSheet {...props} defaultMethod="transfer" onClose={onClose} />)
    await screen.findByText(BY_LINK)

    await userEvent.click(screen.getByRole('button', { name: 'Cobrar y liquidar' }))

    // D8 — nothing was recorded: the sale is still an apartado, and collecting is now the enlace.
    expect(await screen.findByRole('heading', { name: 'Enlace de pago' })).toBeInTheDocument()
    expect(screen.getByText('Esperando pago')).toBeInTheDocument()
    expect(screen.getByLabelText(/Monto del enlace: \$1,200\.00/)).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
    // The enlace is the sheet's one action now: no second way to settle beside it.
    expect(screen.queryByRole('button', { name: 'Cobrar y liquidar' })).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Cobrar por WhatsApp' }))
    const url = decodeURIComponent(String(opened.mock.calls[0]![0]))
    expect(url).toContain('https://wa.me/52')
    expect(url).toContain('https://link.devoladapago.com/p/kq7m2x9d4tbn3wpa')
    // The settlement's own text, signed like every message the sale sends.
    expect(url).toContain('Hola María Fernández, te escribe Ana de Descubre Huasca. Para liquidar tu reserva')
    expect(url).toContain('$1,200.00')
    await expectNoA11yViolations(document.body)
  })

  it('one line’s settle posts to that line and shows the enlace it answered', async () => {
    const sent = answerSettle({
      folio: anApartado(),
      payment_link: aSettlementLink({ folio_line_id: 'line-1', amount: 55_000 }),
    })
    renderWithProviders(
      <SettleSheet
        {...props}
        balance={55_000}
        defaultMethod="transfer"
        lineId="line-1"
        lineName="Tour Isla Mujeres"
        onClose={vi.fn()}
      />,
    )
    await screen.findByText(BY_LINK)
    await userEvent.click(screen.getByRole('button', { name: 'Cobrar y liquidar' }))

    expect(await screen.findByLabelText(/Monto del enlace: \$550\.00/)).toBeInTheDocument()
    expect(sent[0].path).toBe('/api/pos/folios/folio-1/lines/line-1/settle')
  })

  it('closing the sheet on its enlace starts the next opening at the form', async () => {
    answerSettle({ folio: anApartado(), payment_link: aSettlementLink() })
    renderWithProviders(<Host defaultMethod="transfer" />)
    await screen.findByText(BY_LINK)
    await userEvent.click(screen.getByRole('button', { name: 'Cobrar y liquidar' }))
    await screen.findByRole('button', { name: 'Cobrar por WhatsApp' })

    await userEvent.click(screen.getByRole('button', { name: 'Cerrar' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    await userEvent.click(screen.getByRole('button', { name: 'Liquidar saldo' }))
    expect(await screen.findByRole('button', { name: 'Cobrar y liquidar' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Cobrar por WhatsApp' })).not.toBeInTheDocument()
  })

  // FR-010 — `payment_link_error` is a fallback signal, not a failure: the settlement was recorded.
  it.each([
    [
      'DEVOLADA_UNAVAILABLE',
      'No se pudo crear el enlace de pago; un administrador verificará la transferencia',
    ],
    [
      'PAYMENT_LINK_TOO_SHORT',
      'Ya no hay tiempo para cobrar con enlace; un administrador verificará la transferencia',
    ],
  ])('no enlace (%s): the sheet closes as settled and its alert says why', async (code, copy) => {
    answerSettle({
      folio: anApartado({ status: 'paid', pending_balance: 0, payment_verification: 'pending' }),
      payment_link: null,
      payment_link_error: code,
    })
    const { container } = renderWithProviders(<Host defaultMethod="transfer" />)
    await screen.findByText(BY_LINK)

    await userEvent.click(screen.getByRole('button', { name: 'Cobrar y liquidar' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(await screen.findByRole('alert')).toHaveTextContent(copy)
    // The card names the enlace it is about, and offers nothing to send.
    expect(screen.getByRole('heading', { name: 'Enlace de pago' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Cobrar por WhatsApp' })).not.toBeInTheDocument()
    // The sheet is gone; the alert lives where the host mounted it.
    await expectNoA11yViolations(container)
  })

  // D8, D19 — until PR 3, any settlement other than the open enlace's own is refused while it waits.
  it.each([
    ['in cash', 'cash' as const],
    ['by transfer', 'transfer' as const],
  ])('a settlement refused %s while an enlace collects the balance says so and stays open', async (_, method) => {
    answerSettle(
      { error: { code: 'SETTLEMENT_IN_PROGRESS', message: 'A settlement link is open' } },
      { status: 409 },
    )
    const onClose = vi.fn()
    renderWithProviders(<SettleSheet {...props} defaultMethod={method} onClose={onClose} />)
    if (method === 'transfer') await screen.findByText(BY_LINK)

    await userEvent.click(screen.getByRole('button', { name: 'Cobrar y liquidar' }))

    expect(await screen.findByText(IN_PROGRESS)).toBeInTheDocument()
    expect(screen.queryByText(/No se pudo liquidar el saldo/)).not.toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
    await expectNoA11yViolations(document.body)
  })

  it('a broken connection keeps the reference, sends it, and says why', async () => {
    server.use(orgWith(true, { status: 'broken', mode: 'test' }))
    // A broken connection records the attempt as a failed enlace and answers its reason (T026).
    const sent = answerSettle({
      folio: anApartado({ status: 'paid', pending_balance: 0, payment_verification: 'pending' }),
      payment_link: null,
      payment_link_error: 'DEVOLADA_CREDENTIAL_REJECTED',
    })
    renderWithProviders(<SettleSheet {...props} defaultMethod="transfer" onClose={vi.fn()} />)

    expect(await screen.findByText(BROKEN)).toBeInTheDocument()
    expect(screen.queryByText(BY_LINK)).not.toBeInTheDocument()
    const submit = screen.getByRole('button', { name: 'Cobrar y liquidar' })
    expect(submit).toBeDisabled()

    await userEvent.type(screen.getByLabelText(/Referencia de la transferencia/), 'BBVA 0099887766')
    await userEvent.click(submit)
    await waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0].body).toEqual({ method: 'transfer', payment_reference: 'BBVA 0099887766' })
  })
})
