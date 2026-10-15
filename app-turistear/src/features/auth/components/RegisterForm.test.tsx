// passkey-auth US3 — a new admin registers an organization without a password: name, email,
// company and phone, then the code the API mailed (FR-030), then signed in and offered a llave de
// acceso.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Route, Routes } from 'react-router-dom'
import { http, HttpResponse } from 'msw'
import { server } from '../../../test/server'
import { renderWithProviders, screen, userEvent } from '../../../test/renderWithProviders'
import { expectNoA11yViolations } from '../../../test/axe'
import { aUser, onboardingError, signedInAs } from '../../../test/handlers/auth'
import { installWebAuthn, uninstallWebAuthn } from '../../../test/webauthn'
import { usePasskeyOffer } from '../../../store/passkeyOffer'
import { RegisterForm } from './RegisterForm'

function renderForm() {
  return renderWithProviders(
    <Routes>
      <Route path="/register" element={<RegisterForm />} />
      <Route path="/dashboard" element={<p>Hoy</p>} />
    </Routes>,
    { initialEntries: ['/register'] },
  )
}

async function fillAndSubmit() {
  await userEvent.type(screen.getByLabelText('Nombre'), 'Ana López')
  await userEvent.type(screen.getByLabelText('Correo electrónico'), 'Ana@Ejemplo.MX')
  await userEvent.type(screen.getByLabelText('Nombre de la empresa'), 'Tours Ana')
  await userEvent.type(screen.getByLabelText('Teléfono'), '+52 998 765 4321')
  await userEvent.click(screen.getByRole('button', { name: 'Registrarse' }))
}

beforeEach(() => usePasskeyOffer.setState({ pending: false }))
afterEach(() => uninstallWebAuthn())

describe('RegisterForm', () => {
  it('asks for no password (FR-060)', () => {
    renderForm()
    expect(screen.queryByLabelText(/contraseña/i)).not.toBeInTheDocument()
  })

  it('registers, then asks for the code the API mailed to that address (scenario 1)', async () => {
    let body: unknown
    server.use(
      http.post('/api/onboarding/register', async ({ request }) => {
        body = await request.json()
        return HttpResponse.json({ message: 'Te enviamos un código a tu correo.' }, { status: 201 })
      }),
    )
    renderForm()

    await fillAndSubmit()

    expect(await screen.findByLabelText('Código')).toBeInTheDocument()
    expect(body).toEqual({
      name: 'Ana López',
      email: 'ana@ejemplo.mx',
      company_name: 'Tours Ana',
      phone: '+52 998 765 4321',
    })
    expect(screen.getByText(/Te enviamos un código/)).toHaveTextContent('ana@ejemplo.mx')
  })

  it('signs the new admin in with the code, onto Hoy, offering a llave de acceso (scenario 2)', async () => {
    installWebAuthn()
    let signIn: unknown
    server.use(
      signedInAs('admin'),
      http.post('/api/auth/sign-in/email-otp', async ({ request }) => {
        signIn = await request.json()
        return HttpResponse.json({
          user: aUser({ id: 'user-2', name: 'Ana López', email: 'ana@ejemplo.mx', role: 'admin' }),
        })
      }),
    )
    renderForm()
    await fillAndSubmit()

    await userEvent.type(await screen.findByLabelText('Código'), '654321')
    await userEvent.click(screen.getByRole('button', { name: 'Entrar' }))

    expect(await screen.findByText('Hoy')).toBeInTheDocument()
    expect(signIn).toEqual({ email: 'ana@ejemplo.mx', otp: '654321' })
    expect(usePasskeyOffer.getState().pending).toBe(true)
  })

  it('refuses an address that already has an account (scenario 3)', async () => {
    server.use(
      http.post('/api/onboarding/register', () =>
        onboardingError(409, 'EMAIL_ALREADY_EXISTS', 'El email ya está registrado'),
      ),
    )
    renderForm()

    await fillAndSubmit()

    expect(await screen.findByText('Este correo ya está registrado')).toBeInTheDocument()
    expect(screen.queryByLabelText('Código')).not.toBeInTheDocument()
  })

  it('says so when the API rejects the data', async () => {
    server.use(
      http.post('/api/onboarding/register', () =>
        onboardingError(400, 'VALIDATION_ERROR', 'Datos inválidos'),
      ),
    )
    renderForm()

    await fillAndSubmit()

    expect(await screen.findByText('Los datos proporcionados son inválidos')).toBeInTheDocument()
  })

  it('has no accessibility violations', async () => {
    const { container } = renderForm()
    await expectNoA11yViolations(container)
  })
})
