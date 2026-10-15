// passkey-auth US2 — the offer to create a llave de acceso after an email-code sign-in (FR-007):
// created, cancelled at the device, declined with "Ahora no", and the fresh-session rule
// (scenario 9). WebAuthn is mocked at navigator.credentials.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Route, Routes, useLocation } from 'react-router-dom'
import { http, HttpResponse } from 'msw'
import { server } from '../../../test/server'
import { renderWithProviders, screen, userEvent, waitFor } from '../../../test/renderWithProviders'
import { expectNoA11yViolations } from '../../../test/axe'
import { aPasskey, betterAuthError } from '../../../test/handlers/auth'
import {
  anAttestation,
  installWebAuthn,
  promptClosed,
  uninstallWebAuthn,
  type WebAuthnStub,
} from '../../../test/webauthn'
import { PasskeyOffer, type PasskeyOfferProps } from './PasskeyOffer'

function SignInProbe() {
  const { pathname, search } = useLocation()
  return <p>{`En ${pathname}${search}`}</p>
}

function renderOffer(props: Partial<PasskeyOfferProps> = {}) {
  const onClose = vi.fn()
  const view = renderWithProviders(
    <Routes>
      <Route path="/pos" element={<PasskeyOffer open onClose={onClose} {...props} />} />
      <Route path="/login" element={<SignInProbe />} />
    </Routes>,
    { initialEntries: ['/pos'] },
  )
  return { ...view, onClose }
}

let webauthn: WebAuthnStub

beforeEach(() => {
  webauthn = installWebAuthn()
})
afterEach(() => uninstallWebAuthn())

describe('PasskeyOffer', () => {
  it('creates the llave de acceso, named after the device (scenario 2)', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15',
    )
    webauthn.create.mockResolvedValue(anAttestation())
    let body: { name?: string; response?: { id?: string } } = {}
    server.use(
      http.post('/api/auth/passkey/verify-registration', async ({ request }) => {
        body = (await request.json()) as typeof body
        return HttpResponse.json(aPasskey())
      }),
    )
    const { onClose } = renderOffer()

    await userEvent.click(screen.getByRole('button', { name: 'Crear llave de acceso' }))

    expect(await screen.findByRole('heading', { name: 'Llave de acceso creada' })).toBeInTheDocument()
    expect(body).toMatchObject({ name: 'iPhone', response: { id: 'Y3JlZGVudGlhbC0x' } })
    // The device was asked for a discoverable credential with user verification (FR-001, FR-002).
    const [options] = webauthn.create.mock.calls[0] as [CredentialCreationOptions]
    expect(options.publicKey?.authenticatorSelection).toMatchObject({
      residentKey: 'required',
      userVerification: 'required',
    })

    await userEvent.click(screen.getByRole('button', { name: 'Listo' }))
    expect(onClose).toHaveBeenCalled()
  })

  it('stays on the question when the person closes the device’s prompt (scenario 6)', async () => {
    webauthn.create.mockRejectedValue(promptClosed())
    renderOffer()

    await userEvent.click(screen.getByRole('button', { name: 'Crear llave de acceso' }))

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Crear llave de acceso' })).toBeEnabled(),
    )
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Llave de acceso creada' })).not.toBeInTheDocument()
  })

  it('closes on «Ahora no» without touching the device — it is never forced (scenario 1)', async () => {
    const { onClose } = renderOffer()

    await userEvent.click(screen.getByRole('button', { name: 'Ahora no' }))

    expect(onClose).toHaveBeenCalled()
    expect(webauthn.create).not.toHaveBeenCalled()
  })

  it('asks to sign in again when the session is older than a day (scenario 9, FR-005)', async () => {
    let signedOut = false
    server.use(
      http.get('/api/auth/passkey/generate-register-options', () =>
        betterAuthError(403, 'SESSION_NOT_FRESH', 'Session is not fresh'),
      ),
      http.post('/api/auth/sign-out', () => {
        signedOut = true
        return HttpResponse.json({ success: true })
      }),
    )
    renderOffer()

    await userEvent.click(screen.getByRole('button', { name: 'Crear llave de acceso' }))

    expect(
      await screen.findByText('Por seguridad, vuelve a entrar antes de crear una llave de acceso.'),
    ).toBeInTheDocument()
    expect(webauthn.create).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole('button', { name: 'Volver a entrar' }))

    // Back to sign-in, and from there back here.
    expect(await screen.findByText(`En /login?redirect=${encodeURIComponent('/pos')}`)).toBeInTheDocument()
    expect(signedOut).toBe(true)
  })

  it('says so when this llave is already on the account', async () => {
    webauthn.create.mockRejectedValue(new DOMException('Already registered', 'InvalidStateError'))
    renderOffer()

    await userEvent.click(screen.getByRole('button', { name: 'Crear llave de acceso' }))

    expect(await screen.findByText('Esta llave de acceso ya está guardada en tu cuenta.')).toBeInTheDocument()
  })

  it('reads as an «add» when Seguridad asks for it', () => {
    renderOffer({ mode: 'add' })

    expect(screen.getByRole('dialog', { name: 'Agregar llave de acceso' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancelar' })).toBeInTheDocument()
  })

  it('has no accessibility violations', async () => {
    renderOffer()
    await expectNoA11yViolations(document.body)
  })
})
