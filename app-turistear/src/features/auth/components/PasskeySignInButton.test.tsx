// passkey-auth US2 — sign in with a llave de acceso: no email, no code. WebAuthn is mocked at the
// platform boundary (navigator.credentials); Better Auth's passkey client and SimpleWebAuthn run for
// real against MSW.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Route, Routes } from 'react-router-dom'
import { http, HttpResponse } from 'msw'
import { server } from '../../../test/server'
import { renderWithProviders, screen, userEvent, waitFor } from '../../../test/renderWithProviders'
import { expectNoA11yViolations } from '../../../test/axe'
import { aSession, aUser, betterAuthError, signedInAs } from '../../../test/handlers/auth'
import {
  anAssertion,
  installWebAuthn,
  promptClosed,
  uninstallWebAuthn,
  type WebAuthnStub,
} from '../../../test/webauthn'
import { usePasskeyOffer } from '../../../store/passkeyOffer'
import { PasskeySignInButton } from './PasskeySignInButton'

const BUTTON = { name: 'Entrar con llave de acceso' }

function renderButton() {
  return renderWithProviders(
    <Routes>
      <Route path="/login" element={<PasskeySignInButton />} />
      <Route path="/pos" element={<p>Vender</p>} />
      <Route path="/dashboard" element={<p>Hoy</p>} />
    </Routes>,
    { initialEntries: ['/login'] },
  )
}

let webauthn: WebAuthnStub

beforeEach(() => {
  usePasskeyOffer.setState({ pending: false })
  webauthn = installWebAuthn()
})
afterEach(() => uninstallWebAuthn())

describe('PasskeySignInButton', () => {
  it('signs in with the llave the device picks and lands on the role’s home (scenario 3)', async () => {
    webauthn.get.mockResolvedValue(anAssertion())
    let body: { response?: { id?: string; type?: string } } = {}
    server.use(
      signedInAs('admin'),
      http.post('/api/auth/passkey/verify-authentication', async ({ request }) => {
        body = (await request.json()) as typeof body
        return HttpResponse.json({ session: aSession(), user: aUser({ role: 'admin' }) })
      }),
    )
    renderButton()

    await userEvent.click(screen.getByRole('button', BUTTON))

    expect(await screen.findByText('Hoy')).toBeInTheDocument()
    // A discoverable ceremony: the server's challenge, no account named, a modal prompt.
    const [options] = webauthn.get.mock.calls[0] as [CredentialRequestOptions & { mediation?: string }]
    expect(options.mediation).toBeUndefined()
    expect(options.publicKey?.rpId).toBe('app.turistearya.com')
    expect(body.response).toMatchObject({ id: 'Y3JlZGVudGlhbC0x', type: 'public-key' })
    // Whoever signs in with a llave de acceso already has one: no offer.
    expect(usePasskeyOffer.getState().pending).toBe(false)
  })

  it('returns silently when the person closes the device’s prompt (scenario 6)', async () => {
    webauthn.get.mockRejectedValue(promptClosed())
    let verified = false
    server.use(
      http.post('/api/auth/passkey/verify-authentication', () => {
        verified = true
        return HttpResponse.json({ session: aSession(), user: aUser() })
      }),
    )
    renderButton()

    await userEvent.click(screen.getByRole('button', BUTTON))

    await waitFor(() => expect(screen.getByRole('button', BUTTON)).toBeEnabled())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(verified).toBe(false)
    expect(screen.queryByText('Vender')).not.toBeInTheDocument()
  })

  it.each([
    // Scenario 5 — a removed llave: refused, and the email code is offered.
    [401, 'PASSKEY_NOT_FOUND', 'Passkey not found', 'No reconocemos esa llave de acceso. Entra con un código por correo.'],
    // FR-006 — a use count behind the server's (a clone) fails verification.
    [400, 'AUTHENTICATION_FAILED', 'Authentication failed', 'No pudimos verificar tu llave de acceso. Entra con un código por correo.'],
    [400, 'CHALLENGE_NOT_FOUND', 'Challenge not found', 'La solicitud venció. Inténtalo de nuevo.'],
    [403, 'ACCOUNT_SUSPENDED', 'Account suspended', 'Tu cuenta ha sido suspendida. Contacta a tu administrador.'],
  ])('%s %s — says so and stays put', async (status, code, message, shown) => {
    webauthn.get.mockResolvedValue(anAssertion())
    server.use(
      http.post('/api/auth/passkey/verify-authentication', () =>
        betterAuthError(status, code, message),
      ),
    )
    renderButton()

    await userEvent.click(screen.getByRole('button', BUTTON))

    expect(await screen.findByRole('alert')).toHaveTextContent(shown)
    expect(screen.getByRole('button', BUTTON)).toBeEnabled()
    expect(screen.queryByText('Vender')).not.toBeInTheDocument()
  })

  it('is not there at all where the browser has no WebAuthn', () => {
    uninstallWebAuthn()
    renderButton()
    expect(screen.queryByRole('button', BUTTON)).not.toBeInTheDocument()
  })

  it('has no accessibility violations, with a refusal showing', async () => {
    webauthn.get.mockResolvedValue(anAssertion())
    server.use(
      http.post('/api/auth/passkey/verify-authentication', () =>
        betterAuthError(401, 'PASSKEY_NOT_FOUND', 'Passkey not found'),
      ),
    )
    const { container } = renderButton()
    await userEvent.click(screen.getByRole('button', BUTTON))
    await screen.findByRole('alert')

    await expectNoA11yViolations(container)
  })
})
