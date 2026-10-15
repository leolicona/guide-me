// passkey-auth US5 — the account's llaves de acceso: each one's name and creation date (scenario 1),
// how it lives told by icon and text, renamed one at a time (scenario 2), and "Agregar llave de
// acceso" only where the browser can hold one.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../../../test/server'
import { renderWithProviders, screen, userEvent, waitFor, within } from '../../../test/renderWithProviders'
import { expectNoA11yViolations } from '../../../test/axe'
import { aPasskey } from '../../../test/handlers/auth'
import { installWebAuthn, uninstallWebAuthn } from '../../../test/webauthn'
import { PasskeyList } from './PasskeyList'

const phone = aPasskey({
  id: 'passkey-1',
  name: 'iPhone de Luis',
  deviceType: 'multiDevice',
  backedUp: true,
  // 21:30 on Oct 3 in Mexico City — already Oct 4 in UTC.
  createdAt: '2026-10-04T03:30:00.000Z',
})
const securityKey = aPasskey({
  id: 'passkey-2',
  name: 'YubiKey',
  deviceType: 'singleDevice',
  backedUp: false,
  createdAt: '2026-10-05T18:00:00.000Z',
})

const serveList = (passkeys: unknown[]) =>
  server.use(http.get('/api/auth/passkey/list-user-passkeys', () => HttpResponse.json(passkeys)))

beforeEach(() => {
  server.use(
    http.get('/api/organizations/me', () =>
      HttpResponse.json({
        organization: { id: 'org-1', name: 'Tours del Caribe', timezone: 'America/Mexico_City' },
      }),
    ),
  )
})
afterEach(() => uninstallWebAuthn())

describe('PasskeyList', () => {
  it('lists each llave with its name and the day it was created, in the organization’s zone', async () => {
    serveList([phone, securityKey])
    renderWithProviders(<PasskeyList />)

    const list = await screen.findByRole('list', { name: 'Tus llaves de acceso' })
    const [first, second] = within(list).getAllByRole('listitem')

    expect(first).toHaveTextContent('iPhone de Luis')
    await waitFor(() => expect(first).toHaveTextContent('Creada 3 oct 2026'))
    expect(second).toHaveTextContent('YubiKey')
    expect(second).toHaveTextContent('Creada 5 oct 2026')
  })

  it('tells a synced llave from a security key in words, not by icon alone', async () => {
    serveList([phone, securityKey])
    renderWithProviders(<PasskeyList />)

    const [first, second] = within(
      await screen.findByRole('list', { name: 'Tus llaves de acceso' }),
    ).getAllByRole('listitem')
    expect(first).toHaveTextContent('Sincronizada')
    expect(second).toHaveTextContent('Llave de seguridad')
  })

  it('renames one llave, and only that one (scenario 2)', async () => {
    let names = { 'passkey-1': 'iPhone de Luis', 'passkey-2': 'YubiKey' } as Record<string, string>
    let body: unknown
    server.use(
      http.get('/api/auth/passkey/list-user-passkeys', () =>
        HttpResponse.json([
          { ...phone, name: names['passkey-1'] },
          { ...securityKey, name: names['passkey-2'] },
        ]),
      ),
      http.post('/api/auth/passkey/update-passkey', async ({ request }) => {
        body = await request.json()
        const { id, name } = body as { id: string; name: string }
        names = { ...names, [id]: name }
        return HttpResponse.json({ passkey: aPasskey({ id, name }) })
      }),
    )
    renderWithProviders(<PasskeyList />)

    await userEvent.click(await screen.findByRole('button', { name: 'Cambiar nombre de YubiKey' }))
    const field = await screen.findByLabelText('Nombre de la llave de acceso')
    expect(field).toHaveValue('YubiKey')
    await userEvent.clear(field)
    await userEvent.type(field, 'Llave del mostrador')
    await userEvent.click(screen.getByRole('button', { name: 'Guardar' }))

    expect(body).toEqual({ id: 'passkey-2', name: 'Llave del mostrador' })
    expect(await screen.findByText('Llave del mostrador')).toBeInTheDocument()
    expect(screen.getByText('iPhone de Luis')).toBeInTheDocument()
  })

  it('wants a name before saving', async () => {
    serveList([phone])
    renderWithProviders(<PasskeyList />)

    await userEvent.click(
      await screen.findByRole('button', { name: 'Cambiar nombre de iPhone de Luis' }),
    )
    await userEvent.clear(await screen.findByLabelText('Nombre de la llave de acceso'))
    await userEvent.click(screen.getByRole('button', { name: 'Guardar' }))

    expect(await screen.findByText('Escribe un nombre')).toBeInTheDocument()
  })

  it('opens the confirmation before removing one', async () => {
    serveList([phone])
    renderWithProviders(<PasskeyList />)

    await userEvent.click(await screen.findByRole('button', { name: 'Eliminar iPhone de Luis' }))

    expect(
      await screen.findByRole('dialog', { name: '¿Eliminar esta llave de acceso?' }),
    ).toBeInTheDocument()
  })

  it('says there are none yet, and that the email code still signs in', async () => {
    serveList([])
    renderWithProviders(<PasskeyList />)

    expect(
      await screen.findByText(
        'Aún no tienes llaves de acceso. Mientras tanto, entra con un código por correo.',
      ),
    ).toBeInTheDocument()
  })

  it('offers «Agregar llave de acceso» where the browser can hold one', async () => {
    installWebAuthn()
    serveList([phone])
    renderWithProviders(<PasskeyList />)

    await userEvent.click(await screen.findByRole('button', { name: 'Agregar llave de acceso' }))

    expect(await screen.findByRole('dialog', { name: 'Agregar llave de acceso' })).toBeInTheDocument()
  })

  it('explains instead of offering where it cannot (spec § Edge Cases)', async () => {
    serveList([phone])
    renderWithProviders(<PasskeyList />)

    expect(
      await screen.findByText(/Este navegador no puede guardar llaves de acceso/),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Agregar llave de acceso' })).not.toBeInTheDocument()
  })

  it('has no accessibility violations', async () => {
    installWebAuthn()
    serveList([phone, securityKey])
    const { container } = renderWithProviders(<PasskeyList />)
    await screen.findByRole('list', { name: 'Tus llaves de acceso' })

    await expectNoA11yViolations(container)
  })
})
