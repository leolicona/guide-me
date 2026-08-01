import { describe, it, expect, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../../../test/server'
import { renderWithProviders, screen, userEvent, waitFor } from '../../../test/renderWithProviders'
import { expectNoA11yViolations, SHEET_KNOWN_ISSUES } from '../../../test/axe'
import { SettleSheet } from './SettleSheet'

// US-LG03. The labels asserted here are the SAME strings e2e/settle-breakdown.spec.ts queries, on
// purpose: a rename should break this 30 ms test rather than a 90 s Playwright run against a
// deployed environment.

const props = {
  open: true,
  folioId: 'folio-1',
  balance: 120_000,
  defaultMethod: 'cash' as const,
}

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

  it('has no accessibility violations beyond the tracked sheet defect', async () => {
    renderWithProviders(<SettleSheet {...props} onClose={vi.fn()} />)
    await expectNoA11yViolations(document.body, SHEET_KNOWN_ISSUES)
  })
})
