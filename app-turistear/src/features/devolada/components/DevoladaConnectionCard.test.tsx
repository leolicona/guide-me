// devolada-transfer-verification US1 — the Ajustes card «Cobro con Devolada»: an admin connects the
// organization's own key, takes over Devolada's notification address only once they confirm it,
// disconnects, reads every refusal in words, and sees each previous key still in use
// (FR-001–FR-006; contracts/turistear-api.md § Action copy; research D2, D3, D16, D21).
import { beforeEach, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../../../test/server'
import { renderWithProviders, screen, userEvent, waitFor, within } from '../../../test/renderWithProviders'
import { expectNoA11yViolations } from '../../../test/axe'
import { aConnection } from '../../../test/handlers/devolada'
import {
  CONNECTION_HEALTH_COPY,
  CONNECTION_MODE_COPY,
  CONNECTION_STATUS_COPY,
  DEVOLADA_ERROR_COPY,
  keyHintCopy,
  lastVerdictCopy,
  previousKeyCopy,
  REFERENCE_SWITCH_CONNECTED_COPY,
} from '../copy'
import { DevoladaConnectionCard } from './DevoladaConnectionCard'

const ME = '/api/organizations/me/devolada'
const KEY = 'dk_0123456789abcdef0123456789abcdef'
const OTHER_ADDRESS = 'https://otro.example/hooks/devolada'
const CONFLICT = { error: { code: 'DEVOLADA_WEBHOOK_CONFLICT', message: OTHER_ADDRESS } }

// «Último veredicto» reads through useOrgDateFormatter, which fetches the organization.
beforeEach(() => {
  server.use(
    http.get('/api/organizations/me', () =>
      HttpResponse.json({
        organization: { id: 'org-1', name: 'Tours del Caribe', timezone: 'America/Mexico_City' },
      }),
    ),
  )
})

const serve = (connection: unknown) =>
  server.use(http.get(ME, () => HttpResponse.json({ connection })))

const webhook = (over: Record<string, unknown>) => ({ ...aConnection().webhook, ...over })

const openConnectSheet = async (action = 'Conectar') => {
  await userEvent.click(await screen.findByRole('button', { name: action }))
  return screen.findByRole('dialog', { name: 'Conectar Devolada' })
}

const submitKey = async (sheet: HTMLElement, key = KEY) => {
  await userEvent.type(within(sheet).getByLabelText('Clave de API de Devolada'), key)
  await userEvent.click(within(sheet).getByRole('button', { name: 'Conectar' }))
}

const noSheetOpen = () => waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

describe('connecting (FR-001, FR-002)', () => {
  it('never connected reads «Sin conectar»; the key connects it, and the card reads «Conectada»', async () => {
    let connection: unknown = null
    const bodies: unknown[] = []
    server.use(
      http.get(ME, () => HttpResponse.json({ connection })),
      http.put(ME, async ({ request }) => {
        bodies.push(await request.json())
        connection = aConnection()
        return HttpResponse.json({ connection })
      }),
    )
    const { container } = renderWithProviders(<DevoladaConnectionCard />)

    expect(await screen.findByText('Sin conectar')).toBeInTheDocument()
    await expectNoA11yViolations(container)

    const sheet = await openConnectSheet()
    await expectNoA11yViolations(sheet)
    // Pasted with the spaces a copy picks up: the key travels trimmed.
    await submitKey(sheet, `  ${KEY} `)

    expect(await screen.findByText('Conectada')).toBeInTheDocument()
    expect(bodies).toEqual([{ api_key: KEY }])
    expect(screen.getByText('Prueba · Clave …a1b2')).toBeInTheDocument()
    expect(screen.getByText('Avisos funcionando')).toBeInTheDocument()
    // No verdict has arrived yet.
    expect(screen.queryByText(/^Último veredicto/)).not.toBeInTheDocument()
    await noSheetOpen()
    await expectNoA11yViolations(container)
  })

  it('a key that is not dk_ and 32 hex characters is refused here, before the server is asked', async () => {
    let puts = 0
    server.use(
      http.put(ME, () => {
        puts += 1
        return HttpResponse.json({ connection: aConnection() })
      }),
    )
    renderWithProviders(<DevoladaConnectionCard />)

    const sheet = await openConnectSheet()
    await submitKey(sheet, 'dk_short')

    const field = within(sheet).getByLabelText('Clave de API de Devolada')
    expect(field).toHaveAttribute('aria-invalid', 'true')
    expect(within(sheet).getByText('Revisa la clave: empieza con dk_')).toBeInTheDocument()
    expect(puts).toBe(0)
    await expectNoA11yViolations(sheet)
  })

  it('closing the sheet forgets the key (FR-003)', async () => {
    renderWithProviders(<DevoladaConnectionCard />)

    const sheet = await openConnectSheet()
    await userEvent.type(within(sheet).getByLabelText('Clave de API de Devolada'), KEY)
    await userEvent.click(within(sheet).getByRole('button', { name: 'Cerrar' }))
    await noSheetOpen()

    const again = await openConnectSheet()
    expect(within(again).getByLabelText('Clave de API de Devolada')).toHaveValue('')
    await expectNoA11yViolations(again)
  })
})

describe('every refusal reads as its copy (contracts § Action copy)', () => {
  it.each([
    { code: 'DEVOLADA_CREDENTIAL_REJECTED', status: 422, reads: 'Devolada rechazó la clave' },
    {
      code: 'DEVOLADA_MODE_NOT_ALLOWED',
      status: 422,
      reads: 'Esta clave no corresponde a este ambiente (real o de prueba)',
    },
    { code: 'DEVOLADA_BUSINESS_SUSPENDED', status: 409, reads: 'Devolada suspendió tu negocio' },
    {
      code: 'DEVOLADA_CHANNEL_UNAVAILABLE',
      status: 409,
      reads: 'Completa en Devolada la configuración de cobro de tu negocio',
    },
    { code: 'DEVOLADA_UNAVAILABLE', status: 502, reads: 'No pudimos contactar a Devolada; intenta de nuevo' },
    { code: 'VALIDATION_ERROR', status: 400, reads: 'Revisa la clave: empieza con dk_' },
    { code: 'INTERNAL_ERROR', status: 500, reads: 'Devolada no está disponible en este ambiente' },
    // A code the sheet does not map reads as Devolada out of reach.
    { code: 'FORBIDDEN', status: 403, reads: 'No pudimos contactar a Devolada; intenta de nuevo' },
  ])('$code → $reads', async ({ code, status, reads }) => {
    server.use(http.put(ME, () => HttpResponse.json({ error: { code, message: 'refused' } }, { status })))
    renderWithProviders(<DevoladaConnectionCard />)

    const sheet = await openConnectSheet()
    await submitKey(sheet)

    expect(await within(sheet).findByRole('alert')).toHaveTextContent(reads)
    // Nothing connected: the key waits in its sheet for another try.
    expect(within(sheet).getByLabelText('Clave de API de Devolada')).toHaveValue(KEY)
    await expectNoA11yViolations(sheet)
  })
})

describe('the notification address (FR-006, D3)', () => {
  it('another address asks first; «Reemplazar» sends the same key again with replace_webhook', async () => {
    let connection: unknown = null
    const bodies: Record<string, unknown>[] = []
    server.use(
      http.get(ME, () => HttpResponse.json({ connection })),
      http.put(ME, async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>
        bodies.push(body)
        if (body.replace_webhook !== true) return HttpResponse.json(CONFLICT, { status: 409 })
        connection = aConnection()
        return HttpResponse.json({ connection })
      }),
    )
    const { container } = renderWithProviders(<DevoladaConnectionCard />)

    await submitKey(await openConnectSheet())

    const confirm = await screen.findByRole('dialog', { name: '¿Reemplazar la dirección de avisos?' })
    expect(confirm).toHaveTextContent(OTHER_ADDRESS)
    expect(within(confirm).queryByRole('alert')).not.toBeInTheDocument()
    await expectNoA11yViolations(confirm)
    await userEvent.click(within(confirm).getByRole('button', { name: 'Reemplazar' }))

    expect(await screen.findByText('Conectada')).toBeInTheDocument()
    expect(bodies).toEqual([{ api_key: KEY }, { api_key: KEY, replace_webhook: true }])
    await noSheetOpen()
    await expectNoA11yViolations(container)
  })

  it('cancelling closes only the question: nothing is replaced, and the key waits in its sheet', async () => {
    const bodies: unknown[] = []
    server.use(
      http.put(ME, async ({ request }) => {
        bodies.push(await request.json())
        return HttpResponse.json(CONFLICT, { status: 409 })
      }),
    )
    renderWithProviders(<DevoladaConnectionCard />)

    await submitKey(await openConnectSheet())
    const confirm = await screen.findByRole('dialog', { name: '¿Reemplazar la dirección de avisos?' })
    await userEvent.click(within(confirm).getByRole('button', { name: 'Cancelar' }))

    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: '¿Reemplazar la dirección de avisos?' }),
      ).not.toBeInTheDocument(),
    )
    const sheet = await screen.findByRole('dialog', { name: 'Conectar Devolada' })
    expect(within(sheet).getByLabelText('Clave de API de Devolada')).toHaveValue(KEY)
    expect(within(sheet).queryByRole('alert')).not.toBeInTheDocument()
    expect(bodies).toHaveLength(1)
    await expectNoA11yViolations(sheet)
  })
})

describe('disconnecting (FR-004)', () => {
  it('asks first, says the enlaces already sent are still followed, then disconnects', async () => {
    let connection: unknown = aConnection()
    let deletes = 0
    server.use(
      http.get(ME, () => HttpResponse.json({ connection })),
      http.delete(ME, () => {
        deletes += 1
        connection = aConnection({ status: 'disconnected', mode: null, key_hint: null, webhook: null })
        return HttpResponse.json({ connection })
      }),
    )
    const { container } = renderWithProviders(<DevoladaConnectionCard />)

    await userEvent.click(await screen.findByRole('button', { name: 'Desconectar' }))
    const confirm = await screen.findByRole('dialog', { name: '¿Desconectar Devolada?' })
    expect(confirm).toHaveTextContent(
      'Los enlaces de pago que ya se enviaron se seguirán verificando hasta que terminen.',
    )
    await expectNoA11yViolations(confirm)
    expect(deletes).toBe(0)
    await userEvent.click(within(confirm).getByRole('button', { name: 'Desconectar' }))

    expect(await screen.findByText('Sin conectar')).toBeInTheDocument()
    expect(deletes).toBe(1)
    expect(screen.queryByText(/Clave …a1b2/)).not.toBeInTheDocument()
    await noSheetOpen()
    expect(screen.getByRole('button', { name: 'Conectar' })).toBeInTheDocument()
    await expectNoA11yViolations(container)
  })
})

describe('previous keys still in use (FR-005, D21)', () => {
  it('one line per key with pending enlaces, «1 enlace pendiente» in the singular', async () => {
    serve(
      aConnection({
        key_hint: 'b2c3',
        previous_keys: [
          { key_hint: '9f3c', pending_links: 2 },
          { key_hint: '77aa', pending_links: 1 },
        ],
      }),
    )
    const { container } = renderWithProviders(<DevoladaConnectionCard />)

    expect(
      await screen.findByText(
        'La clave anterior …9f3c todavía tiene 2 enlaces pendientes. No la revoques en Devolada hasta que terminen.',
      ),
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        'La clave anterior …77aa todavía tiene 1 enlace pendiente. No la revoques en Devolada hasta que terminen.',
      ),
    ).toBeInTheDocument()
    expect(screen.getAllByText(/^La clave anterior/)).toHaveLength(2)
    expect(screen.getByText('Prueba · Clave …b2c3')).toBeInTheDocument()
    await expectNoA11yViolations(container)
  })

  it('no line when no previous key has pending enlaces', async () => {
    serve(aConnection({ previous_keys: [] }))
    const { container } = renderWithProviders(<DevoladaConnectionCard />)

    expect(await screen.findByText('Conectada')).toBeInTheDocument()
    expect(screen.queryByText(/La clave anterior/)).not.toBeInTheDocument()
    await expectNoA11yViolations(container)
  })

  it('a disconnected organization still sees them, with no current key and no health', async () => {
    serve(
      aConnection({
        status: 'disconnected',
        mode: null,
        key_hint: null,
        webhook: null,
        previous_keys: [{ key_hint: '9f3c', pending_links: 3 }],
      }),
    )
    const { container } = renderWithProviders(<DevoladaConnectionCard />)

    expect(await screen.findByText('Sin conectar')).toBeInTheDocument()
    expect(
      screen.getByText(
        'La clave anterior …9f3c todavía tiene 3 enlaces pendientes. No la revoques en Devolada hasta que terminen.',
      ),
    ).toBeInTheDocument()
    expect(screen.queryByText(/^(Real · |Prueba · )?Clave …/)).not.toBeInTheDocument()
    expect(screen.queryByText(/^Avisos/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Conectar' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Desconectar' })).not.toBeInTheDocument()
    await expectNoA11yViolations(container)
  })
})

describe('a broken connection (FR-005, D2)', () => {
  it('reads «Con fallas» with its reason, and «Cambiar clave» opens the connect sheet', async () => {
    serve(
      aConnection({
        status: 'broken',
        broken_reason: 'DEVOLADA_BUSINESS_SUSPENDED',
        webhook: null,
        health_error: 'DEVOLADA_UNAVAILABLE',
      }),
    )
    const { container } = renderWithProviders(<DevoladaConnectionCard />)

    expect(await screen.findByText('Con fallas')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('Devolada suspendió tu negocio')
    expect(screen.getByText('Prueba · Clave …a1b2')).toBeInTheDocument()
    expect(screen.getByText('Avisos con fallas')).toBeInTheDocument()
    await expectNoA11yViolations(container)

    expect(await openConnectSheet('Cambiar clave')).toBeInTheDocument()
  })
})

describe('notification health (FR-005; first match wins)', () => {
  it.each([
    {
      when: 'this environment registers no address',
      over: { webhook: webhook({ is_ours: null }), credit_paused_since: 1_800_000_000 },
      reads: 'Avisos: solo revisión periódica',
    },
    {
      when: 'the validation credit is paused',
      over: { credit_paused_since: 1_800_000_000, webhook: webhook({ consecutive_failures: 2 }) },
      reads: 'Verificación en pausa',
    },
    { when: 'deliveries keep failing', over: { webhook: webhook({ consecutive_failures: 3 }) }, reads: 'Avisos con fallas' },
    { when: 'deliveries failed', over: { webhook: webhook({ failed_deliveries: 2 }) }, reads: 'Avisos con fallas' },
    { when: 'the address is another system’s', over: { webhook: webhook({ is_ours: false }) }, reads: 'Avisos con fallas' },
    {
      when: 'Devolada cannot be reached',
      over: { webhook: null, health_error: 'DEVOLADA_UNAVAILABLE' },
      reads: 'Avisos con fallas',
    },
    { when: 'all is well', over: {}, reads: 'Avisos funcionando' },
  ])('$when → $reads, icon and text', async ({ over, reads }) => {
    serve(aConnection(over))
    const { container } = renderWithProviders(<DevoladaConnectionCard />)

    const line = await screen.findByText(reads)
    expect(line.querySelector('svg')).toBeInTheDocument()
    await expectNoA11yViolations(container)
  })

  it('«Último veredicto» reads in the organization’s time zone', async () => {
    // 12:33 UTC is 06:33 in Mexico City.
    serve(aConnection({ last_verdict_at: Date.parse('2026-10-06T12:33:20Z') / 1000 }))
    const { container } = renderWithProviders(<DevoladaConnectionCard />)

    expect(await screen.findByText(/^Último veredicto: 6 oct 2026, 06:33/)).toBeInTheDocument()
    await expectNoA11yViolations(container)
  })
})

it('the Ajustes copy never says «llave», «liga», «link», «validar» or «folio» (constitution VII)', () => {
  const copy = [
    ...Object.values(CONNECTION_STATUS_COPY),
    ...Object.values(CONNECTION_MODE_COPY),
    ...Object.values(CONNECTION_HEALTH_COPY),
    ...Object.values(DEVOLADA_ERROR_COPY),
    keyHintCopy('a1b2'),
    lastVerdictCopy('hoy'),
    previousKeyCopy({ key_hint: 'a1b2', pending_links: 2 }),
    REFERENCE_SWITCH_CONNECTED_COPY,
  ]
  for (const text of copy) expect(text).not.toMatch(/llave|\bliga\b|\blink\b|validar|folio/i)
})
