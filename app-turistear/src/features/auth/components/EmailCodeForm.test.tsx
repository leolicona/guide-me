// passkey-auth US1 — sign in with a código por correo: the request, the sign-in, every refusal
// Better Auth answers (FR-070), and the wait its limiter sends in X-Retry-After (FR-012).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Route, Routes } from 'react-router-dom'
import { http, HttpResponse } from 'msw'
import { server } from '../../../test/server'
import { renderWithProviders, screen, userEvent, waitFor } from '../../../test/renderWithProviders'
import { expectNoA11yViolations } from '../../../test/axe'
import { aUser, betterAuthError, rateLimited, signedInAs } from '../../../test/handlers/auth'
import { installWebAuthn, uninstallWebAuthn } from '../../../test/webauthn'
import { usePasskeyOffer } from '../../../store/passkeyOffer'
import { EmailCodeForm, type EmailCodeFormProps } from './EmailCodeForm'

function renderForm(props: EmailCodeFormProps = {}, path = '/login') {
  return renderWithProviders(
    <Routes>
      <Route path="/login" element={<EmailCodeForm {...props} />} />
      <Route path="/pos" element={<p>Vender</p>} />
      <Route path="/dashboard" element={<p>Hoy</p>} />
      <Route path="/pos/folio/:id" element={<p>Venta abierta</p>} />
    </Routes>,
    { initialEntries: [path] },
  )
}

async function requestCodeFor(email: string) {
  await userEvent.type(screen.getByLabelText('Correo electrónico'), email)
  await userEvent.click(screen.getByRole('button', { name: 'Recibir código' }))
  return screen.findByLabelText('Código')
}

async function enterCode(code: string) {
  await userEvent.type(screen.getByLabelText('Código'), code)
  await userEvent.click(screen.getByRole('button', { name: 'Entrar' }))
}

beforeEach(() => usePasskeyOffer.setState({ pending: false }))
afterEach(() => uninstallWebAuthn())

describe('EmailCodeForm — requesting a code', () => {
  it('asks Better Auth for a sign-in code for the trimmed, lowercased address', async () => {
    let body: unknown
    server.use(
      http.post('/api/auth/email-otp/send-verification-otp', async ({ request }) => {
        body = await request.json()
        return HttpResponse.json({ success: true })
      }),
    )
    renderForm()

    await requestCodeFor('Luis@Ejemplo.MX')

    expect(body).toEqual({ email: 'luis@ejemplo.mx', type: 'sign-in' })
    // FR-013 — one confirmation for every address; the screen cannot tell an account exists.
    expect(screen.getByText(/Te enviamos un código de 6 dígitos a/)).toHaveTextContent(
      'luis@ejemplo.mx',
    )
  })

  it('refuses a malformed address before sending anything', async () => {
    renderForm()
    await userEvent.type(screen.getByLabelText('Correo electrónico'), 'luis@')
    await userEvent.click(screen.getByRole('button', { name: 'Recibir código' }))

    expect(await screen.findByText('Correo electrónico inválido')).toBeInTheDocument()
    expect(screen.queryByLabelText('Código')).not.toBeInTheDocument()
  })

  it('asks the phone for its numeric keyboard and to offer the code it received', async () => {
    renderForm()
    const code = await requestCodeFor('luis@ejemplo.mx')

    expect(code).toHaveAttribute('inputmode', 'numeric')
    expect(code).toHaveAttribute('autocomplete', 'one-time-code')
    expect(code).toHaveFocus()
  })

  it('offers the device’s llaves de acceso from the email field when conditional UI is on', () => {
    renderForm({ webauthnAutofill: true })
    expect(screen.getByLabelText('Correo electrónico')).toHaveAttribute(
      'autocomplete',
      'username webauthn',
    )
  })

  it('goes back to the email step with «Usar otro correo»', async () => {
    renderForm()
    await requestCodeFor('luis@ejemplo.mx')

    await userEvent.click(screen.getByRole('button', { name: 'Usar otro correo' }))

    expect(screen.getByLabelText('Correo electrónico')).toBeInTheDocument()
    expect(screen.queryByLabelText('Código')).not.toBeInTheDocument()
  })

  it('opens at the code step when the code already went out, with no other address to pick', () => {
    renderForm({ codeSentTo: 'ana@ejemplo.mx' })

    expect(screen.getByLabelText('Código')).toBeInTheDocument()
    expect(screen.getByText(/Te enviamos un código/)).toHaveTextContent('ana@ejemplo.mx')
    expect(screen.queryByRole('button', { name: 'Usar otro correo' })).not.toBeInTheDocument()
  })

  it('says a new code went out on «Reenviar código» — only the newest one works (scenario 4)', async () => {
    renderForm()
    await requestCodeFor('luis@ejemplo.mx')
    await userEvent.type(screen.getByLabelText('Código'), '111')

    await userEvent.click(screen.getByRole('button', { name: 'Reenviar código' }))

    expect(await screen.findByText('Te enviamos un código nuevo.')).toBeInTheDocument()
    expect(screen.getByLabelText('Código')).toHaveValue('')
  })
})

describe('EmailCodeForm — signing in', () => {
  it('signs in with the code, lands on the agent’s home and raises the llave de acceso offer', async () => {
    installWebAuthn()
    let body: unknown
    server.use(
      signedInAs('agent'),
      http.post('/api/auth/sign-in/email-otp', async ({ request }) => {
        body = await request.json()
        return HttpResponse.json({ user: aUser() })
      }),
    )
    renderForm()
    await requestCodeFor('luis@ejemplo.mx')

    await enterCode('123456')

    expect(await screen.findByText('Vender')).toBeInTheDocument()
    expect(body).toEqual({ email: 'luis@ejemplo.mx', otp: '123456' })
    // US2 (scenario 1), SC-008 — AppLayout's PasskeyOffer opens on this flag.
    expect(usePasskeyOffer.getState().pending).toBe(true)
  })

  it('lands an admin on Hoy', async () => {
    server.use(signedInAs('admin'))
    renderForm()
    await requestCodeFor('ana@ejemplo.mx')

    await enterCode('123456')

    expect(await screen.findByText('Hoy')).toBeInTheDocument()
  })

  it('returns to the deep link that sent the person to sign in', async () => {
    server.use(signedInAs('agent'))
    renderForm({}, `/login?redirect=${encodeURIComponent('/pos/folio/f-1')}`)
    await requestCodeFor('luis@ejemplo.mx')

    await enterCode('123456')

    expect(await screen.findByText('Venta abierta')).toBeInTheDocument()
  })

  it('offers no llave de acceso where the browser cannot hold one', async () => {
    server.use(signedInAs('agent'))
    renderForm()
    await requestCodeFor('luis@ejemplo.mx')

    await enterCode('123456')

    expect(await screen.findByText('Vender')).toBeInTheDocument()
    expect(usePasskeyOffer.getState().pending).toBe(false)
  })

  it('wants 6 digits before asking Better Auth', async () => {
    renderForm()
    await requestCodeFor('luis@ejemplo.mx')

    await enterCode('12a')

    expect(await screen.findByText('El código tiene 6 dígitos')).toBeInTheDocument()
  })

  it.each([
    [400, 'INVALID_OTP', 'Invalid OTP', 'El código no es correcto. Revísalo e inténtalo de nuevo.'],
    // Scenario 5 — expired: refused, and a new code is offered.
    [400, 'OTP_EXPIRED', 'OTP expired', 'El código venció. Pide uno nuevo.'],
    // Scenario 3 — the 4th try: the code stops working, and a new one is asked for.
    [403, 'TOO_MANY_ATTEMPTS', 'Too many attempts', 'Demasiados intentos con este código. Pide uno nuevo.'],
  ])('%s %s — says so, clears the code and keeps «Reenviar código» at hand', async (status, code, message, shown) => {
    server.use(
      http.post('/api/auth/sign-in/email-otp', () => betterAuthError(status, code, message)),
    )
    renderForm()
    await requestCodeFor('luis@ejemplo.mx')

    await enterCode('123456')

    expect(await screen.findByText(shown)).toBeInTheDocument()
    expect(screen.getByLabelText('Código')).toHaveValue('')
    expect(screen.getByRole('button', { name: 'Reenviar código' })).toBeEnabled()
    expect(screen.queryByText('Vender')).not.toBeInTheDocument()
  })

  it('403 ACCOUNT_SUSPENDED — refuses with the suspended-account message (scenario 7)', async () => {
    server.use(
      http.post('/api/auth/sign-in/email-otp', () =>
        betterAuthError(403, 'ACCOUNT_SUSPENDED', 'Account suspended'),
      ),
    )
    renderForm()
    await requestCodeFor('luis@ejemplo.mx')

    await enterCode('123456')

    expect(
      await screen.findByText('Tu cuenta ha sido suspendida. Contacta a tu administrador.'),
    ).toBeInTheDocument()
    expect(screen.queryByText('Vender')).not.toBeInTheDocument()
  })
})

describe('EmailCodeForm — the limiter (FR-012)', () => {
  it('disables «Reenviar código» for the seconds X-Retry-After says, then gives it back', async () => {
    renderForm()
    await requestCodeFor('luis@ejemplo.mx')
    server.use(http.post('/api/auth/email-otp/send-verification-otp', () => rateLimited(2)))

    await userEvent.click(screen.getByRole('button', { name: 'Reenviar código' }))

    expect(
      await screen.findByText('Demasiados intentos. Espera 2 segundos e inténtalo de nuevo.'),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Reenviar código \(\d s\)$/ })).toBeDisabled()
    await waitFor(
      () => expect(screen.getByRole('button', { name: 'Reenviar código' })).toBeEnabled(),
      { timeout: 5000 },
    )
  })

  it('holds «Recibir código» too when the first request is the one refused', async () => {
    server.use(http.post('/api/auth/email-otp/send-verification-otp', () => rateLimited(30)))
    renderForm()
    await userEvent.type(screen.getByLabelText('Correo electrónico'), 'luis@ejemplo.mx')

    await userEvent.click(screen.getByRole('button', { name: 'Recibir código' }))

    expect(await screen.findByRole('button', { name: /^Recibir código \(\d+ s\)$/ })).toBeDisabled()
    expect(screen.queryByLabelText('Código')).not.toBeInTheDocument()
  })

  it('holds «Entrar» when the sign-in itself is rate limited', async () => {
    server.use(http.post('/api/auth/sign-in/email-otp', () => rateLimited(9)))
    renderForm()
    await requestCodeFor('luis@ejemplo.mx')

    await enterCode('123456')

    expect(
      await screen.findByText('Demasiados intentos. Espera 9 segundos e inténtalo de nuevo.'),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Entrar \(\d s\)$/ })).toBeDisabled()
  })
})

describe('EmailCodeForm — accessibility', () => {
  it('has no violations on the email step', async () => {
    const { container } = renderForm()
    await expectNoA11yViolations(container)
  })

  it('has no violations on the code step, with an error showing', async () => {
    server.use(
      http.post('/api/auth/sign-in/email-otp', () =>
        betterAuthError(400, 'INVALID_OTP', 'Invalid OTP'),
      ),
    )
    const { container } = renderForm()
    await requestCodeFor('luis@ejemplo.mx')
    await enterCode('123456')
    await screen.findByText('El código no es correcto. Revísalo e inténtalo de nuevo.')

    await expectNoA11yViolations(container)
  })
})
