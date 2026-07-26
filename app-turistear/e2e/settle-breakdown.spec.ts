import { test, expect, request as pwRequest } from '@playwright/test'
import { login, env } from './helpers'

// The API origin (may differ from the app origin, e.g. api-dev vs app-dev).
const API_BASE = process.env.E2E_API_BASE ?? 'https://api-dev.turistearya.com'

// Paid-ledger walkthrough (US-LG03 / US-LG08) against a DEPLOYED environment (default app-dev).
//
// The reported fix, verified end-to-end through the UI: an agent settles a booking's remaining
// balance BY TRANSFER (a different method than the cash deposit); an admin verifies the electronic
// payment; the folio then reads as a MIXED collection and its per-payment breakdown shows the cash
// deposit and the transfer balance separately.
//
// PREREQUISITES (see e2e/README.md):
//   • The target env must have the paid-ledger stack DEPLOYED (as of writing it is NOT on `develop`
//     / app-dev yet — merge the stack first).
//   • Provide a LIVE booking (apartado) folio via E2E_FOLIO_ID, collected with a CASH deposit.
//   • Credentials via env: E2E_AGENT_EMAIL/PASSWORD (owns the booking) + E2E_ADMIN_EMAIL/PASSWORD.

const FOLIO_ID = process.env.E2E_FOLIO_ID
// When set (path to a Playwright storageState), reuse that saved session for BOTH the settle and the
// verify — an admin/owner account can do both. Otherwise fall back to the two-account env login.
const STORAGE = process.env.E2E_STORAGE

test.describe('Settle balance by transfer → Mixto → per-payment breakdown', () => {
  test.skip(
    !FOLIO_ID,
    'Set E2E_FOLIO_ID to a LIVE booking (apartado) folio with a cash deposit to run this walkthrough.',
  )

  test('agent settles by transfer, admin verifies, folio shows the split', async ({ browser }) => {
    // ---- 1. Agent settles the balance by TRANSFER ------------------------------------------------
    const agentCtx = await browser.newContext(STORAGE ? { storageState: STORAGE } : {})
    const page = await agentCtx.newPage()
    if (!STORAGE) await login(page, env('E2E_AGENT_EMAIL'), env('E2E_AGENT_PASSWORD'))

    await page.goto(`/pos/folio/${FOLIO_ID}`)
    await page.getByRole('button', { name: 'Liquidar saldo' }).click()

    // The SettleSheet: pick Transferencia, enter its reference, submit.
    await expect(page.getByText('Saldo por cobrar')).toBeVisible()
    await page.getByRole('button', { name: 'Transferencia' }).click()
    await page
      .getByLabel('Referencia de la transferencia')
      .fill(`E2E-${Date.now().toString().slice(-8)}`)
    await page.getByRole('button', { name: 'Cobrar y liquidar' }).click()

    // A transfer balance defers the QR to admin verification — the folio shows it awaits an admin.
    await expect(page.getByText(/Por verificar/i)).toBeVisible()

    // ---- 2. Admin verifies the electronic payment (via the API — pre-existing US-A67 machinery,
    //         not the flow under test; keeps the walkthrough focused on the settle + breakdown UI).
    const api = await pwRequest.newContext(
      STORAGE ? { baseURL: API_BASE, storageState: STORAGE } : { baseURL: API_BASE },
    )
    const verify = await api.post(`/api/pos/folios/${FOLIO_ID}/verify`)
    expect(verify.ok(), `verify failed: ${verify.status()}`).toBeTruthy()
    await api.dispose()

    // ---- 3. The folio now reads as a MIXED collection with a per-payment breakdown ---------------
    await page.reload()
    // The folio is now a MIXED collection…
    await expect(page.getByText('Mixto')).toBeVisible()
    // …and the per-payment breakdown lists both movements, each with its own method.
    await expect(page.getByText('Desglose de pagos')).toBeVisible()
    await expect(page.getByText('Efectivo')).toBeVisible()
    await expect(page.getByText('Transferencia')).toBeVisible()
  })
})
