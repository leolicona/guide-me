// passkey-auth US4 — an invited agent joins without a password: their name, then the code the API
// mailed to the invited address (FR-031), then signed in as an agent and offered a llave de acceso.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Route, Routes } from 'react-router-dom'
import { http, HttpResponse } from 'msw'
import { server } from '../../../test/server'
import { renderWithProviders, screen, userEvent } from '../../../test/renderWithProviders'
import { expectNoA11yViolations } from '../../../test/axe'
import { aUser, onboardingError, signedInAs } from '../../../test/handlers/auth'
import { installWebAuthn, uninstallWebAuthn } from '../../../test/webauthn'
import { usePasskeyOffer } from '../../../store/passkeyOffer'
import { InviteCompleteForm } from './InviteCompleteForm'

const TOKEN = 'inv-tok-123'

function renderForm() {
  return renderWithProviders(
    <Routes>
      <Route path="/invite/accept" element={<InviteCompleteForm token={TOKEN} />} />
      <Route path="/pos" element={<p>Vender</p>} />
    </Routes>,
    { initialEntries: [`/invite/accept?token=${TOKEN}`] },
  )
}

async function accept(name = 'Luis Pérez') {
  await userEvent.type(screen.getByLabelText('Nombre'), name)
  await userEvent.click(screen.getByRole('button', { name: 'Aceptar invitación' }))
}

beforeEach(() => usePasskeyOffer.setState({ pending: false }))
afterEach(() => uninstallWebAuthn())

describe('InviteCompleteForm', () => {
  it('asks only for a name — no password (FR-060)', () => {
    renderForm()
    expect(screen.getByLabelText('Nombre')).toBeInTheDocument()
    expect(screen.queryByLabelText(/contraseña/i)).not.toBeInTheDocument()
  })

  it('accepts with the name, then asks for the code sent to the invited address (scenario 1)', async () => {
    let body: unknown
    let token: unknown
    server.use(
      http.post('/api/onboarding/invitations/:token/accept', async ({ request, params }) => {
        body = await request.json()
        token = params.token
        return HttpResponse.json({ email: 'luis@ejemplo.mx' })
      }),
    )
    renderForm()

    await accept()

    expect(await screen.findByLabelText('Código')).toBeInTheDocument()
    expect(token).toBe(TOKEN)
    expect(body).toEqual({ name: 'Luis Pérez' })
    expect(screen.getByText(/Te enviamos un código/)).toHaveTextContent('luis@ejemplo.mx')
    // The address is the invitation's: there is no other to pick.
    expect(screen.queryByRole('button', { name: 'Usar otro correo' })).not.toBeInTheDocument()
  })

  it('signs the agent in with the code, onto Vender, offering a llave de acceso (scenario 2)', async () => {
    installWebAuthn()
    let signIn: unknown
    server.use(
      signedInAs('agent'),
      http.post('/api/auth/sign-in/email-otp', async ({ request }) => {
        signIn = await request.json()
        return HttpResponse.json({ user: aUser() })
      }),
    )
    renderForm()
    await accept()

    await userEvent.type(await screen.findByLabelText('Código'), '246810')
    await userEvent.click(screen.getByRole('button', { name: 'Entrar' }))

    expect(await screen.findByText('Vender')).toBeInTheDocument()
    expect(signIn).toEqual({ email: 'luis@ejemplo.mx', otp: '246810' })
    expect(usePasskeyOffer.getState().pending).toBe(true)
  })

  it('refuses an expired, used or unknown invitation (scenario 4)', async () => {
    server.use(
      http.post('/api/onboarding/invitations/:token/accept', () =>
        onboardingError(400, 'INVALID_TOKEN', 'Invitación inválida'),
      ),
    )
    renderForm()

    await accept()

    expect(
      await screen.findByText('La invitación es inválida o ha expirado. Contacta a tu administrador.'),
    ).toBeInTheDocument()
    expect(screen.queryByLabelText('Código')).not.toBeInTheDocument()
  })

  it('points to sign-in when the address already has an account', async () => {
    server.use(
      http.post('/api/onboarding/invitations/:token/accept', () =>
        onboardingError(409, 'EMAIL_ALREADY_EXISTS', 'El email ya está registrado'),
      ),
    )
    renderForm()

    await accept()

    expect(
      await screen.findByText(
        'Ya existe una cuenta con este correo. Entra con tu llave de acceso o con un código por correo.',
      ),
    ).toBeInTheDocument()
  })

  it('has no accessibility violations', async () => {
    const { container } = renderForm()
    await expectNoA11yViolations(container)
  })
})
