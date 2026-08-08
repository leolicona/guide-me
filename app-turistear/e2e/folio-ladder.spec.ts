import { test, expect, request as pwRequest, type APIRequestContext } from '@playwright/test'
import { ADMIN_STATE, AGENT_STATE, API_BASE } from './paths'

// The folio detail's blocking-first ladder (US-A82 D12, one layer down) against a DEPLOYED
// environment — the journey the Vitest tiers structurally cannot run: a REAL tourist petition
// through the portal endpoint, the admin resolving it in the browser, and the BUG-030 guard
// answering over the wire.
//
// Two folios, seeded by this spec through the API (not the shared fixture — the ladder needs
// states the seeded apartado does not have) and both CLOSED by the journey itself:
//   A — paid by TRANSFER, unverified  → the verification rung parks the cancel (BUG-030)
//   B — paid cash, tickets unsent, then a portal cancellation petition → the petition rung parks
//       everything; rejecting it becomes a derived Historial row and unblocks delivery
//
// This spec runs as the ADMIN: the ladder is the admin detail's anatomy.

test.use({ storageState: ADMIN_STATE })

// The seed project's slot rule, repeated here on purpose (see e2e/setup/seed.setup.ts for the
// born-expired story): a departure at least 2 days out, so the pre-departure buffer plus the
// org's zone cannot produce a folio whose actions all answer 409.
async function pickFutureSlot(ctx: APIRequestContext) {
  const services: { id: string; item_type?: string; has_availability?: boolean; base_price: number }[] =
    (await (await ctx.get('/api/pos/services')).json()).services ?? []
  const tour = services
    .filter((s) => s.has_availability && s.item_type === 'tour')
    .sort((a, b) => a.base_price - b.base_price)[0]
  expect(tour, 'no bookable tour with availability in this environment').toBeTruthy()
  const detail = (await (await ctx.get(`/api/pos/services/${tour.id}`)).json()).service
  const earliest = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10)
  const slot = (detail.slots ?? []).find(
    (s: { remaining: number; date: string }) => s.remaining >= 4 && s.date >= earliest,
  )
  expect(slot, `no future slot with seats on ${detail.name}`).toBeTruthy()
  return { slot, total: detail.base_price as number }
}

async function confirmSale(
  ctx: APIRequestContext,
  name: string,
  body: Record<string, unknown>,
): Promise<string> {
  const res = await ctx.post('/api/pos/folios', {
    data: { customer_name: name, customer_phone: '5512340000', ...body },
  })
  const json = await res.json()
  expect(res.ok(), `${name}: ${res.status()} ${JSON.stringify(json)}`).toBeTruthy()
  return json.folio.id as string
}

test.describe('The blocking-first ladder on the folio detail', () => {
  test('petition parks everything; rejection narrates and unblocks; unverified money parks the cancel', async ({
    page,
  }) => {
    test.setTimeout(180_000)

    // ---- 0. Seed through the API: the agent sells, the tourist petitions -----------------------
    const agentApi = await pwRequest.newContext({ baseURL: API_BASE, storageState: AGENT_STATE })
    const { slot, total } = await pickFutureSlot(agentApi)

    const folioA = await confirmSale(agentApi, 'E2E Escalera Transferencia', {
      payment_method: 'transfer',
      payment_reference: 'E2E-LADDER-A',
      lines: [{ slot_id: slot.id, quantity: 1, unit_price: total }],
    })
    const folioB = await confirmSale(agentApi, 'E2E Escalera Solicitud', {
      payment_method: 'cash',
      lines: [{ slot_id: slot.id, quantity: 1, unit_price: total }],
    })

    // The REAL portal petition — the token a genuine sale minted, the endpoint the tourist posts.
    const bRead = (await (await agentApi.get(`/api/pos/folios/${folioB}`)).json()).folio
    const portalToken: string = bRead.portal_link.split('/portal/')[1]
    const petition = await agentApi.post(`/portal/${portalToken}/cancellation-request`, {
      form: { reason: 'E2E — el cliente pide cancelar' },
    })
    expect(petition.status(), 'portal petition').toBeLessThan(400)
    await agentApi.dispose()

    // ---- 1. Folio B: the petition is the ONLY visible action -----------------------------------
    await page.goto(`/folios/${folioB}`)
    await expect(page.getByText('El cliente pidió cancelar')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Aprobar cancelación' })).toBeVisible()
    // Parked: delivery, reschedule, cancel. Their absence IS the ladder.
    await expect(page.getByText('Entregar boletos')).not.toBeVisible()
    await expect(page.getByRole('button', { name: 'Reagendar' })).not.toBeVisible()
    await expect(page.getByRole('button', { name: 'Cancelar folio' })).not.toBeVisible()
    // The live petition is WORK, not history: creado + pago, nothing more — the Salida marker
    // waits for the departure (timeline D7 as amended by #83), so a future slot adds no row.
    await expect(page.getByRole('button', { name: 'Ver todo (2)' })).toBeVisible()

    // ---- 2. Rejecting the petition narrates it and unblocks the next rung ----------------------
    await page.getByRole('button', { name: 'Rechazar solicitud' }).click()
    // The FormSheet: a REQUIRED note — the customer reads it in their portal.
    await page.getByLabel('Motivo del rechazo').fill('E2E — fuera de ventana')
    await page.getByRole('button', { name: 'Rechazar solicitud' }).last().click()

    await expect(page.getByText('El cliente pidió cancelar')).not.toBeVisible()
    await expect(page.getByText('Entregar boletos')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Cancelar folio' })).toBeVisible()
    // The rejection's ONLY surface is its derived Historial row (timeline D12).
    await page.getByRole('button', { name: 'Ver todo (3)' }).click()
    await expect(page.getByText('Solicitud de cancelación rechazada')).toBeVisible()
    await expect(page.getByText('Motivo del cliente: E2E — el cliente pide cancelar')).toBeVisible()
    await expect(page.getByText('Resolución: E2E — fuera de ventana')).toBeVisible()

    // ---- 3. Folio A: unverified money parks the cancel — in the UI and over the wire -----------
    await page.goto(`/folios/${folioA}`)
    await expect(page.getByText('Por verificar', { exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Pago por verificar' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Cancelar folio' })).not.toBeVisible()
    await expect(page.getByText('Entregar boletos')).not.toBeVisible()

    // BUG-030 — the assertion the UI cannot give (it hides the button): the API refuses too.
    const adminApi = await pwRequest.newContext({ baseURL: API_BASE, storageState: ADMIN_STATE })
    const blocked = await adminApi.post(`/api/folios/${folioA}/cancel`, {
      data: { reason: 'E2E — must be refused' },
    })
    expect(blocked.status()).toBe(409)
    expect(await blocked.text()).toContain('PAYMENT_UNVERIFIED')

    // ---- 4. Verifying unlocks the folio (US-A67 machinery, driven via API like settle-breakdown)
    const verify = await adminApi.post(`/api/pos/folios/${folioA}/verify`)
    expect(verify.ok(), `verify failed: ${verify.status()}`).toBeTruthy()
    await adminApi.dispose()

    await page.reload()
    await expect(page.getByRole('heading', { name: 'Pago por verificar' })).not.toBeVisible()
    await expect(page.getByRole('button', { name: 'Cancelar folio' })).toBeVisible()
    await page.getByRole('button', { name: /Ver todo/ }).click()
    await expect(page.getByText('Transferencia verificada')).toBeVisible()

    // ---- 5. Cancel A through the UI — the journey leaves dev tidy ------------------------------
    await page.getByRole('button', { name: 'Cancelar folio' }).click()
    await page.getByRole('button', { name: 'Cancelar folio' }).last().click()
    await expect(page.getByText('Cancelado por administración')).toBeVisible({ timeout: 20_000 })
  })
})
