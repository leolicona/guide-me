import { test, expect, request as pwRequest, type APIRequestContext } from '@playwright/test'
import { ADMIN_STATE, AGENT_STATE, API_BASE } from './paths'

// The refund-PIN cycle (US-T04 → US-A21 → US-A23/US-T05) against a DEPLOYED environment — the
// journey that crosses THREE surfaces no Vitest tier can hold at once: the tourist's portal
// (petition in, PIN out), the admin detail (approve, confirm), and the money invariants between
// them. The PIN asserted here is the REAL one the portal minted, scraped from the same
// server-rendered page the customer reads.
//
// One folio, seeded by this spec and left CLOSED (cancelled + refunded): dev stays tidy.

test.use({ storageState: ADMIN_STATE })

// The seed project's slot rule (see e2e/setup/seed.setup.ts for the born-expired story).
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

test.describe('The refund-PIN cycle: portal petition → approve → the portal mints the proof → cash confirmed', () => {
  test('the PIN the customer reads is the one that closes the refund — and a wrong one is refused', async ({
    page,
  }) => {
    test.setTimeout(180_000)

    // ---- 0. Seed: the agent sells for cash; the tourist petitions through their portal ---------
    const agentApi = await pwRequest.newContext({ baseURL: API_BASE, storageState: AGENT_STATE })
    const { slot, total } = await pickFutureSlot(agentApi)
    const res = await agentApi.post('/api/pos/folios', {
      data: {
        customer_name: 'E2E Reembolso PIN',
        customer_phone: '5512340001',
        payment_method: 'cash',
        lines: [{ slot_id: slot.id, quantity: 1, unit_price: total }],
      },
    })
    expect(res.ok(), `confirm failed: ${res.status()}`).toBeTruthy()
    const folioId: string = (await res.json()).folio.id
    const read = (await (await agentApi.get(`/api/pos/folios/${folioId}`)).json()).folio
    const portalToken: string = read.portal_link.split('/portal/')[1]
    const petition = await agentApi.post(`/portal/${portalToken}/cancellation-request`, {
      form: { reason: 'E2E — ya no podremos asistir' },
    })
    expect(petition.status(), 'portal petition').toBeLessThan(400)
    await agentApi.dispose()

    // ---- 1. The admin approves in the browser — the decision, and everything it promises -------
    await page.goto(`/folios/${folioId}`)
    await page.getByRole('button', { name: 'Aprobar cancelación' }).click()
    await expect(page.getByText('¿Aprobar la cancelación?')).toBeVisible()
    await page.getByRole('button', { name: 'Aprobar y cancelar folio' }).click()

    // The folio flips and the refund obligation opens, stated in chips AND in the alert.
    await expect(page.getByText('Cancelado', { exact: true })).toBeVisible({ timeout: 20_000 })
    await expect(page.getByText('Reembolso pendiente', { exact: true })).toBeVisible()
    await expect(page.getByText(/Reembolso pendiente de \$/)).toBeVisible()

    // D12's other half: an APPROVED petition gets no derived row — its `cancelled` event tells it.
    await page.getByRole('button', { name: /Ver todo/ }).click()
    await expect(page.getByText('Cancelado a solicitud del cliente')).toBeVisible()
    await expect(page.getByText('Solicitud de cancelación rechazada')).not.toBeVisible()

    // ---- 2. The portal now shows the customer their PIN — scrape the REAL one ------------------
    // Same server-rendered page the tourist reads; the token is the auth. This is the only place
    // the PIN exists outside the database (it is never emailed).
    const portalApi = await pwRequest.newContext({ baseURL: API_BASE })
    const portalHtml = await (await portalApi.get(`/portal/${portalToken}`)).text()
    await portalApi.dispose()
    const pin = portalHtml.match(/portal-pin-code[^>]*>(\d{6})</)?.[1]
    expect(pin, 'the portal page shows no 6-digit refund PIN').toBeTruthy()

    // ---- 3. A wrong PIN is refused with the exact message — the proof is not decorative --------
    const wrongPin = pin!.slice(0, 5) + String((Number(pin![5]) + 1) % 10)
    await page.getByRole('button', { name: 'Confirmar reembolso' }).first().click()
    await page.getByLabel('PIN del cliente').fill(wrongPin)
    await page.getByRole('button', { name: 'Confirmar reembolso' }).last().click()
    await expect(page.getByText('PIN incorrecto. Verifica el código que te dio el cliente.')).toBeVisible()

    // ---- 4. The real PIN closes the loop -------------------------------------------------------
    await page.getByLabel('PIN del cliente').fill(pin!)
    await page.getByRole('button', { name: 'Confirmar reembolso' }).last().click()

    await expect(page.getByText('Reembolsado', { exact: true })).toBeVisible({ timeout: 20_000 })
    await expect(page.getByText(/Reembolso confirmado/)).toBeVisible()
    // The narrative agrees with the columns: the hand-back is on the record, PIN-proofed. The
    // timeline kept the expansion from step 1 (component state survives the mutations), so only
    // expand if it collapsed — e.g. after an unexpected remount.
    const verTodo = page.getByRole('button', { name: /Ver todo/ })
    if (await verTodo.isVisible()) await verTodo.click()
    await expect(page.getByText('Reembolso entregado')).toBeVisible()
    await expect(page.getByText(/· con PIN/)).toBeVisible()
  })
})
