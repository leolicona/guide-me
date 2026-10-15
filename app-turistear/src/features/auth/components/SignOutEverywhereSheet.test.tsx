// passkey-auth US5 — "Cerrar sesión en todos los dispositivos" (scenario 4, FR-024): every session
// ends, this one included, so this device goes back to sign-in.
import { describe, it, expect, vi } from 'vitest'
import { Route, Routes } from 'react-router-dom'
import { http, HttpResponse } from 'msw'
import { server } from '../../../test/server'
import { renderWithProviders, screen, userEvent } from '../../../test/renderWithProviders'
import { expectNoA11yViolations } from '../../../test/axe'
import { SignOutEverywhereSheet } from './SignOutEverywhereSheet'

function renderSheet(onClose = vi.fn()) {
  return renderWithProviders(
    <Routes>
      <Route path="/seguridad" element={<SignOutEverywhereSheet open onClose={onClose} />} />
      <Route path="/login" element={<p>Pantalla de inicio de sesión</p>} />
    </Routes>,
    { initialEntries: ['/seguridad'] },
  )
}

describe('SignOutEverywhereSheet', () => {
  it('revokes every session and sends this device to sign-in', async () => {
    let revoked = false
    server.use(
      http.post('/api/auth/revoke-sessions', () => {
        revoked = true
        return HttpResponse.json({ status: true })
      }),
    )
    renderSheet()

    await userEvent.click(
      screen.getByRole('button', { name: 'Cerrar sesión en todos los dispositivos' }),
    )

    expect(await screen.findByText('Pantalla de inicio de sesión')).toBeInTheDocument()
    expect(revoked).toBe(true)
  })

  it('stays put and says so when the request fails — the sessions are still alive', async () => {
    server.use(http.post('/api/auth/revoke-sessions', () => HttpResponse.error()))
    renderSheet()

    await userEvent.click(
      screen.getByRole('button', { name: 'Cerrar sesión en todos los dispositivos' }),
    )

    expect(
      await screen.findByText(
        'No se pudo cerrar la sesión en tus dispositivos. Revisa tu conexión e inténtalo de nuevo.',
      ),
    ).toBeInTheDocument()
    expect(screen.queryByText('Pantalla de inicio de sesión')).not.toBeInTheDocument()
  })

  it('cancels without ending anything', async () => {
    let revoked = false
    server.use(
      http.post('/api/auth/revoke-sessions', () => {
        revoked = true
        return HttpResponse.json({ status: true })
      }),
    )
    const onClose = vi.fn()
    renderSheet(onClose)

    await userEvent.click(screen.getByRole('button', { name: 'Cancelar' }))

    expect(onClose).toHaveBeenCalled()
    expect(revoked).toBe(false)
  })

  it('has no accessibility violations', async () => {
    renderSheet()
    await expectNoA11yViolations(document.body)
  })
})
