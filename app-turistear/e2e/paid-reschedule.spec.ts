import { test, expect, request as pwRequest, type APIRequestContext } from '@playwright/test'
import { AGENT_STATE, API_BASE } from './paths'

// Paid reschedule journey (US-AG52 / D16) against a DEPLOYED environment.
//
// An agent moves a PAID sale to another departure of the same service, and the ticket moves with
// it: the old QR stops admitting, a new one is minted, and the send that puts it in the customer's
// hands is one tap from the confirm.
//
// WHY THIS IS A PLAYWRIGHT TEST AND NOT A VITEST ONE (docs/TESTING.md — the routing rule):
// the API suite proves the seats and the re-signing, and RescheduleSheet.test.tsx proves the sheet
// renders against MSW. Neither can see what this journey exists for — the picker fed by the REAL
// catalog (a mocked slot list cannot prove the sheet finds a movable day in a real org's
// calendar), and the WhatsApp handoff's button being ENABLED, which depends on `portal_link`
// surviving a real re-read through a real reschedule response. That exact gap shipped once: the
// send rendered disabled, and every layer below was green.
//
// It seeds its OWN paid sale rather than using the shared apartado fixture, which
// settle-breakdown.spec.ts owns and mutates. Cleanup is inline and never fails the run — a stale
// folio in dev is untidy, not a regression.

interface Seeded {
  folioId: string
  lineId: string
  oldToken: string
  fromDate: string
  serviceName: string
}

/** A cleared cash sale: paid outright, so the QR and the portal link exist immediately. */
async function seedPaidSale(ctx: APIRequestContext): Promise<Seeded> {
  const catalog = await ctx.get('/api/pos/services')
  expect(catalog.ok(), `catalog fetch failed: ${catalog.status()}`).toBeTruthy()
  const services: { id: string; item_type?: string; base_price: number }[] =
    (await catalog.json()).services ?? []

  // Two days of margin for the same reason seed.setup.ts takes it: the slot list is naive in the
  // org's zone, which this process does not know.
  const dateIn = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)
  const from = dateIn(2)
  const to = dateIn(30)

  // The journey needs a service with at least TWO bookable departures — one to sell, one to move
  // to. A service with a single date can be sold and never rescheduled, which is why this picks on
  // the pair rather than on availability alone.
  // Deliberately NOT filtered by `has_availability`: that flag describes a rolling 3-day window
  // (US-AG30), so a service whose next departure is three weeks out reads unavailable while being
  // perfectly bookable. The window this journey asks for below is the only thing that decides.
  for (const svc of services.filter((s) => s.item_type === 'tour')) {
    const res = await ctx.get(`/api/pos/services/${svc.id}?from=${from}&to=${to}`)
    if (!res.ok()) continue
    const detail = (await res.json()).service
    const bookable = (detail.slots ?? []).filter(
      (s: { remaining: number; date: string }) => s.remaining > 0 && s.date >= from,
    )
    // Distinct DAYS, because the sheet's pager steps by day.
    const days = [...new Set(bookable.map((s: { date: string }) => s.date))]
    if (days.length < 2) continue

    const slot = bookable[0]
    const sale = await ctx.post('/api/pos/folios', {
      data: {
        customer_name: 'E2E Reagenda Cliente',
        customer_phone: '5512349999',
        payment_method: 'cash',
        lines: [{ slot_id: slot.id, quantity: 1, unit_price: detail.base_price }],
      },
    })
    expect(sale.ok(), `could not seed a paid sale: ${sale.status()} ${await sale.text()}`).toBeTruthy()
    const folio = (await sale.json()).folio

    // The three preconditions the journey depends on, asserted HERE so a bad fixture names itself
    // instead of surfacing later as a button that will not appear.
    expect(folio.status, 'the seeded sale is not paid').toBe('paid')
    expect(folio.portal_link, 'the seeded sale has no portal link — the handoff would be disabled').toBeTruthy()
    const line = folio.lines[0]
    expect(line.qr_token, 'the seeded sale has no QR to supersede').toBeTruthy()

    return {
      folioId: folio.id,
      lineId: line.id,
      oldToken: line.qr_token,
      fromDate: slot.date,
      serviceName: detail.name,
    }
  }

  throw new Error(
    `No tour in this environment has two bookable days between ${from} and ${to}. ` +
      `The reschedule journey needs one departure to sell and another to move to — ` +
      `dev needs more future availability seeded.`,
  )
}

test.describe('Paid reschedule → the ticket moves with the date', () => {
  let seeded: Seeded
  let api: APIRequestContext

  test.beforeAll(async () => {
    api = await pwRequest.newContext({ baseURL: API_BASE, storageState: AGENT_STATE })
    seeded = await seedPaidSale(api)
  })

  test.afterAll(async () => {
    // Never throws: cleanup that goes red would hide the result of the test it follows.
    try {
      await api.post(`/api/pos/folios/${seeded.folioId}/cancel`, {
        data: { reason: 'E2E teardown — paid reschedule journey' },
      })
    } catch {
      /* a stale folio in dev is untidy, not a regression */
    }
    await api.dispose()
  })

  test('agent moves a paid sale, and the new ticket is one tap away', async ({ page }) => {
    // ---- 1. The agent opens the sale and reaches Reagendar --------------------------------------
    await page.goto(`/pos/folio/${seeded.folioId}`)
    await page.getByRole('button', { name: 'Reagendar' }).click()

    // The sheet, scoped by its accessible name so the trigger button of the same name behind it
    // can never be the thing this test drives.
    const sheet = page.getByRole('dialog', { name: 'Reagendar' })
    await expect(sheet).toBeVisible()

    // ---- 2. The picker, fed by the REAL catalog --------------------------------------------------
    // The pager opens on the first day with room, so a time chip must already be on screen — no
    // tap needed to see the soonest real options. This is the assertion MSW cannot make: these
    // chips come from the org's actual calendar.
    const timeChip = sheet.getByRole('button', { name: /^\d{2}:\d{2}/ }).first()
    await expect(timeChip).toBeVisible()
    const chosenTime = ((await timeChip.textContent()) ?? '').slice(0, 5)

    // The warning the customer's ticket depends on, before anything moves (D16).
    await expect(sheet.getByText(/el boleto actual deja de funcionar/i)).toBeVisible()

    await timeChip.click()
    await sheet.getByRole('button', { name: 'Reagendar', exact: true }).click()

    // ---- 3. The handoff, with the send ENABLED ---------------------------------------------------
    await expect(sheet.getByText('Fecha movida')).toBeVisible()
    const send = sheet.getByRole('button', { name: /Enviar boletos por WhatsApp/i })
    // ENABLED, not merely present. A disabled send is what shipped once — the flow "worked" and
    // the customer's replacement never left the counter.
    await expect(send).toBeEnabled()

    // ---- 4. What the server actually did ---------------------------------------------------------
    const after = await api.get(`/api/pos/folios/${seeded.folioId}`)
    expect(after.ok(), `folio re-read failed: ${after.status()}`).toBeTruthy()
    const folio = (await after.json()).folio
    const line = folio.lines.find((l: { id: string }) => l.id === seeded.lineId)

    // The date moved — and the money did not (the scope boundary, end to end).
    expect(line.slot_start_time).toBe(chosenTime)
    expect(folio.status).toBe('paid')
    expect(folio.amount_paid).toBe(folio.total)

    // ---- 5. The ticket moved with it -------------------------------------------------------------
    // The customer-visible half of D16, across two more origins: the QR was re-minted, and the one
    // they may have screenshotted is refused by the REAL scanner instead of quietly admitting them
    // to a departure whose seat went back to the pool.
    expect(line.qr_token, 'the QR was not re-signed').not.toBe(seeded.oldToken)

    const oldScan = await api.post('/api/tickets/scan', { data: { token: seeded.oldToken } })
    expect(oldScan.ok()).toBeTruthy()
    const oldResult = await oldScan.json()
    expect(oldResult.result).toBe('invalid')
    expect(oldResult.reason).toBe('SUPERSEDED')
  })
})
