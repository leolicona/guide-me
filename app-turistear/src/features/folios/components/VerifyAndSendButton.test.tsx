import { describe, it, expect, beforeEach, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../../../test/server'
import { renderWithProviders, screen, waitFor, userEvent } from '../../../test/renderWithProviders'
import { VerifyAndSendButton } from './VerifyAndSendButton'

// verify-send-empty-link — `Verificar y enviar` on the admin card.
// Bug: .specify/bugs/verify-send-empty-link/assessment.md
//
// An apartado paid by transfer reaches this button too. Its verify confirms the deposit and mints no
// portal link (the tickets wait for settle), so the ticket template went out with `{portal_link}`
// blank — "Ábrelos aquí:" followed by nothing — and the folio was stamped "Enviado".

const folio = {
  id: 'f1',
  customer_name: 'Maribel',
  customer_phone: '+52 771 175 5000',
  total: 250_000,
  lines: [],
}

const verified = (over: Record<string, unknown> = {}) => ({
  id: 'f1',
  status: 'paid',
  customer_name: 'Maribel',
  customer_phone: '+52 771 175 5000',
  total: 250_000,
  amount_paid: 250_000,
  pending_balance: 0,
  portal_link: 'https://api.local/portal/tok',
  lines: [],
  ...over,
})

const markSent = vi.fn()

const withVerify = (response: Record<string, unknown>) => {
  server.use(
    http.get('/api/me', () => HttpResponse.json({ user: { id: 'u1', name: 'Marcos' } })),
    http.get('/api/organizations/me', () =>
      HttpResponse.json({ organization: { name: 'Descubre Huasca', wa_ticket_template: null } }),
    ),
    http.post('/api/pos/folios/:id/verify', () => HttpResponse.json({ folio: response })),
    http.post('/api/folios/:id/ticket-delivery', () => {
      markSent()
      return HttpResponse.json({ tickets_sent_at: 1, tickets_viewed_at: null })
    }),
  )
}

const sentText = (): string => {
  const url = vi.mocked(window.open).mock.calls[0][0] as string
  return new URL(url).searchParams.get('text') ?? ''
}

beforeEach(() => {
  markSent.mockClear()
  vi.spyOn(window, 'open').mockImplementation(() => null)
})

describe('verify-send-empty-link — Verificar y enviar', () => {
  it('an apartado gets the deposit confirmation, never the ticket message, and is not marked sent', async () => {
    withVerify(
      verified({ status: 'booking', amount_paid: 80_000, pending_balance: 170_000, portal_link: null }),
    )
    renderWithProviders(<VerifyAndSendButton folio={folio} />)

    await userEvent.click(await screen.findByRole('button', { name: /Verificar y enviar/ }))

    await waitFor(() => expect(window.open).toHaveBeenCalledTimes(1))
    const text = sentText()
    expect(text).toContain('Confirmamos tu anticipo de $800.00')
    expect(text).toContain('Tu saldo pendiente es $1,700.00')
    expect(text).not.toMatch(/boletos:|Ábrelos/)
    expect(await screen.findByText('Anticipo verificado')).toBeInTheDocument()
    expect(markSent).not.toHaveBeenCalled()
  })

  it('a paid folio still gets the ticket message with its link, and is marked sent', async () => {
    withVerify(verified())
    renderWithProviders(<VerifyAndSendButton folio={folio} />)

    await userEvent.click(await screen.findByRole('button', { name: /Verificar y enviar/ }))

    await waitFor(() => expect(markSent).toHaveBeenCalledTimes(1))
    expect(sentText()).toContain('https://api.local/portal/tok')
    expect(await screen.findByText('Pago verificado')).toBeInTheDocument()
  })

  it('a paid folio whose link failed to mint sends nothing and marks nothing', async () => {
    withVerify(verified({ portal_link: null }))
    renderWithProviders(<VerifyAndSendButton folio={folio} />)

    await userEvent.click(await screen.findByRole('button', { name: /Verificar y enviar/ }))

    expect(await screen.findByText('Pago verificado')).toBeInTheDocument()
    expect(window.open).not.toHaveBeenCalled()
    expect(markSent).not.toHaveBeenCalled()
  })
})
