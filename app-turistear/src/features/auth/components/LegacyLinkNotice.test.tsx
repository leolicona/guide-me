// passkey-auth US1 (scenario 9), FR-063 — a verification or password-reset link mailed before
// cutover explains that passwords are gone and leads to the sign-in.
import { describe, it, expect } from 'vitest'
import { Route, Routes } from 'react-router-dom'
import { renderWithProviders, screen, userEvent } from '../../../test/renderWithProviders'
import { expectNoA11yViolations } from '../../../test/axe'
import { LegacyLinkNotice } from './LegacyLinkNotice'

function renderAt(path: string) {
  return renderWithProviders(
    <Routes>
      <Route path="/verify" element={<LegacyLinkNotice />} />
      <Route path="/reset-password" element={<LegacyLinkNotice />} />
      <Route path="/login" element={<p>Pantalla de inicio de sesión</p>} />
    </Routes>,
    { initialEntries: [path] },
  )
}

describe('LegacyLinkNotice', () => {
  it.each(['/verify?token=abc', '/reset-password?token=abc'])(
    '%s explains that passwords are gone, and offers both ways in',
    (path) => {
      renderAt(path)
      expect(
        screen.getByText(
          'Ya no usamos contraseñas. Entra con tu llave de acceso o con un código por correo.',
        ),
      ).toBeInTheDocument()
    },
  )

  it('leads to the sign-in', async () => {
    renderAt('/verify?token=abc')

    await userEvent.click(screen.getByRole('button', { name: 'Ir a iniciar sesión' }))

    expect(await screen.findByText('Pantalla de inicio de sesión')).toBeInTheDocument()
  })

  it('has no accessibility violations', async () => {
    const { container } = renderAt('/verify?token=abc')
    await expectNoA11yViolations(container)
  })
})
