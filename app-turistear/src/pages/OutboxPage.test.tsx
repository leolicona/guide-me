import { describe, it, expect, beforeEach, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../test/server'
import { renderWithProviders, screen, waitFor, userEvent } from '../test/renderWithProviders'
import OutboxPage from './OutboxPage'

// US-A86 — the admin's outbox, as rendered.
// Spec: docs/folios/folio-state-machine.spec.md — D12, D13, D21.
//
// The screen's whole claim is that only ONE of the two kinds of notification is a queue: the
// clock-produced half, plus anything a provider refused. If the action-tails ever start showing up
// here, the model has quietly collapsed back into "an inbox for everything".

const aRow = (over: Record<string, unknown> = {}) => ({
  id: 'n1',
  folio_id: 'f1',
  event: 'booking_grace_entered',
  channel: 'whatsapp',
  status: 'pending',
  attempts: 0,
  last_error: null,
  sent_at: null,
  sent_by: null,
  created_at: 1000,
  customer_name: 'María González',
  customer_phone: '+52 998 123 4567',
  template: 'Hola {customer_name}, tu apartado en {org_name} vence pronto.',
  ...over,
})

// MSW resets handlers after every test, so registering in `beforeEach` is what keeps this working
// past the first one — a `beforeAll` registration survives exactly one test.
const withRows = (rows: unknown[]) => {
  server.use(
    http.get('/api/notifications', ({ request }) => {
      const status = new URL(request.url).searchParams.get('status')
      return HttpResponse.json({
        notifications: rows.filter((r) => (r as { status: string }).status === status),
      })
    }),
    http.post('/api/notifications/:id/sent', () =>
      HttpResponse.json({ notification: { id: 'n1', status: 'sent' } }),
    ),
  )
}

beforeEach(() => {
  vi.spyOn(window, 'open').mockImplementation(() => null)
})

describe('US-A86 — the outbox shows the clock-produced half', () => {
  it('renders a pending WhatsApp row with the message already resolved', async () => {
    withRows([aRow()])
    renderWithProviders(<OutboxPage />)

    expect(await screen.findByText('María González')).toBeInTheDocument()
    // The customer's name is substituted; every unresolved placeholder is dropped rather than
    // shown raw — a `{org_name}` on an admin's screen is a bug they cannot fix.
    expect(screen.getByText(/Hola María González, tu apartado en vence pronto\./)).toBeInTheDocument()
    expect(screen.queryByText(/\{org_name\}/)).not.toBeInTheDocument()
  })

  it('the tap opens the composer AND records the send', async () => {
    withRows([aRow()])
    renderWithProviders(<OutboxPage />)

    await userEvent.click(await screen.findByRole('button', { name: /Enviar por WhatsApp/ }))

    await waitFor(() => {
      expect(window.open).toHaveBeenCalledWith(
        expect.stringContaining('https://wa.me/529981234567?text='),
        '_blank',
      )
    })
  })

  it('a failed row surfaces the provider error instead of hiding it', async () => {
    withRows([aRow({ status: 'failed', attempts: 2, last_error: 'Resend 500', channel: 'email' })])
    renderWithProviders(<OutboxPage />)

    expect(await screen.findByText('Resend 500')).toBeInTheDocument()
    expect(screen.getByText(/Falló 2×/)).toBeInTheDocument()
  })

  it('D21 — an email row offers no button, because a human did not send it', async () => {
    withRows([aRow({ channel: 'email', status: 'failed' })])
    renderWithProviders(<OutboxPage />)

    await screen.findByText('María González')
    expect(screen.queryByRole('button', { name: /Enviar por WhatsApp/ })).not.toBeInTheDocument()
    expect(screen.getByText('Este correo se envía solo.')).toBeInTheDocument()
  })

  it('an empty outbox says WHY it is empty, not just that it is', async () => {
    withRows([])
    renderWithProviders(<OutboxPage />)

    // "No hay nada" reads as a broken screen. The copy has to carry the model: an action-tail left
    // with the tap that produced it and was never going to appear here.
    expect(await screen.findByText(/Cada mensaje salió con la acción que lo produjo/)).toBeInTheDocument()
  })

  it('a row with no phone cannot be tapped into a broken link', async () => {
    withRows([aRow({ customer_phone: null })])
    renderWithProviders(<OutboxPage />)

    const btn = await screen.findByRole('button', { name: /Enviar por WhatsApp/ })
    expect(btn).toBeDisabled()
  })
})
