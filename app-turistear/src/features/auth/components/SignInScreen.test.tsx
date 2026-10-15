// passkey-auth US1, US2 — the sign-in screen: the llave de acceso first (with conditional UI on the
// email field), the código por correo always there, and the suspended-account notice kept.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { renderWithProviders, screen, userEvent, waitFor } from '../../../test/renderWithProviders'
import { expectNoA11yViolations } from '../../../test/axe'
import { installWebAuthn, uninstallWebAuthn } from '../../../test/webauthn'
import { usePasskeyOffer } from '../../../store/passkeyOffer'
import { SignInScreen } from './SignInScreen'

beforeEach(() => usePasskeyOffer.setState({ pending: false }))
afterEach(() => uninstallWebAuthn())

describe('SignInScreen', () => {
  it('puts «Entrar con llave de acceso» before the code request', () => {
    installWebAuthn()
    renderWithProviders(<SignInScreen />, { initialEntries: ['/login'] })

    const passkey = screen.getByRole('button', { name: 'Entrar con llave de acceso' })
    const code = screen.getByRole('button', { name: 'Recibir código' })
    expect(passkey.compareDocumentPosition(code) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('leaves «Entrar» as the one action once the code is on its way, until «Usar otro correo»', async () => {
    installWebAuthn()
    renderWithProviders(<SignInScreen />, { initialEntries: ['/login'] })

    await userEvent.type(screen.getByLabelText('Correo electrónico'), 'luis@ejemplo.mx')
    await userEvent.click(screen.getByRole('button', { name: 'Recibir código' }))

    expect(await screen.findByRole('button', { name: 'Entrar' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Entrar con llave de acceso' })).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Usar otro correo' }))
    expect(screen.getByRole('button', { name: 'Entrar con llave de acceso' })).toBeInTheDocument()
  })

  it('leaves only the email code where the browser has no WebAuthn (spec § Edge Cases)', () => {
    renderWithProviders(<SignInScreen />, { initialEntries: ['/login'] })

    expect(screen.queryByRole('button', { name: 'Entrar con llave de acceso' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Recibir código' })).toBeInTheDocument()
    expect(screen.getByLabelText('Correo electrónico')).toHaveAttribute('autocomplete', 'email')
  })

  it('listens for the device’s llaves from the email field when conditional UI is available', async () => {
    const webauthn = installWebAuthn({ conditional: true })
    // Conditional UI waits until the person picks one from the autofill.
    webauthn.get.mockReturnValue(new Promise(() => {}))
    renderWithProviders(<SignInScreen />, { initialEntries: ['/login'] })

    await waitFor(() =>
      expect(screen.getByLabelText('Correo electrónico')).toHaveAttribute(
        'autocomplete',
        'username webauthn',
      ),
    )
    await waitFor(() => expect(webauthn.get).toHaveBeenCalledTimes(1))
    expect(webauthn.get.mock.calls[0][0]).toMatchObject({ mediation: 'conditional' })
  })

  it('starts no ceremony on its own when conditional UI is not available', async () => {
    const webauthn = installWebAuthn({ conditional: false })
    renderWithProviders(<SignInScreen />, { initialEntries: ['/login'] })

    await screen.findByRole('button', { name: 'Entrar con llave de acceso' })
    expect(screen.getByLabelText('Correo electrónico')).toHaveAttribute('autocomplete', 'email')
    expect(webauthn.get).not.toHaveBeenCalled()
  })

  it('explains a suspended account bounced here by the interceptor (US-A08)', () => {
    renderWithProviders(<SignInScreen />, { initialEntries: ['/login?reason=suspended'] })
    expect(
      screen.getByText('Tu cuenta ha sido suspendida. Contacta a tu administrador.'),
    ).toBeInTheDocument()
  })

  it('has no accessibility violations', async () => {
    installWebAuthn()
    const { container } = renderWithProviders(<SignInScreen />, { initialEntries: ['/login'] })
    await expectNoA11yViolations(container)
  })
})
