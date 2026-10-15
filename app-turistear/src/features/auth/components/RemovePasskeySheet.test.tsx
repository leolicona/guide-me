// passkey-auth US5 — removing a llave de acceso (scenarios 2–3): how a lost phone is cut off. The
// last one may go too; the email code still signs in.
import { describe, it, expect, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../../../test/server'
import { renderWithProviders, screen, userEvent, waitFor } from '../../../test/renderWithProviders'
import { expectNoA11yViolations } from '../../../test/axe'
import { aPasskey } from '../../../test/handlers/auth'
import type { PasskeyRecord } from '../types'
import { RemovePasskeySheet } from './RemovePasskeySheet'

const lostPhone = aPasskey({ id: 'passkey-1', name: 'Teléfono perdido' }) as PasskeyRecord

describe('RemovePasskeySheet', () => {
  it('names the llave it removes and says the email code still works', () => {
    renderWithProviders(<RemovePasskeySheet passkey={lostPhone} open onClose={vi.fn()} />)

    expect(screen.getByRole('dialog', { name: '¿Eliminar esta llave de acceso?' })).toHaveTextContent(
      '«Teléfono perdido» ya no podrá entrar a tu cuenta. Siempre puedes entrar con un código por correo.',
    )
  })

  it('removes that one llave and closes', async () => {
    let body: unknown
    server.use(
      http.post('/api/auth/passkey/delete-passkey', async ({ request }) => {
        body = await request.json()
        return HttpResponse.json({ status: true })
      }),
    )
    const onClose = vi.fn()
    renderWithProviders(<RemovePasskeySheet passkey={lostPhone} open onClose={onClose} />)

    await userEvent.click(screen.getByRole('button', { name: 'Eliminar llave de acceso' }))

    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(body).toEqual({ id: 'passkey-1' })
  })

  it('keeps the sheet open with an explanation when the removal fails', async () => {
    server.use(http.post('/api/auth/passkey/delete-passkey', () => HttpResponse.error()))
    const onClose = vi.fn()
    renderWithProviders(<RemovePasskeySheet passkey={lostPhone} open onClose={onClose} />)

    await userEvent.click(screen.getByRole('button', { name: 'Eliminar llave de acceso' }))

    expect(
      await screen.findByText('No se pudo eliminar la llave de acceso. Inténtalo de nuevo.'),
    ).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('cancels without removing anything', async () => {
    let removed = false
    server.use(
      http.post('/api/auth/passkey/delete-passkey', () => {
        removed = true
        return HttpResponse.json({ status: true })
      }),
    )
    const onClose = vi.fn()
    renderWithProviders(<RemovePasskeySheet passkey={lostPhone} open onClose={onClose} />)

    await userEvent.click(screen.getByRole('button', { name: 'Cancelar' }))

    expect(onClose).toHaveBeenCalled()
    expect(removed).toBe(false)
  })

  it('has no accessibility violations', async () => {
    renderWithProviders(<RemovePasskeySheet passkey={lostPhone} open onClose={vi.fn()} />)
    await expectNoA11yViolations(document.body)
  })
})
