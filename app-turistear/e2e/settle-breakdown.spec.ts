import { test, expect } from '@playwright/test'
import { login, env } from './helpers'

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

test.describe('Settle balance by transfer → Mixto → per-payment breakdown', () => {
  test.skip(
    !FOLIO_ID,
    'Set E2E_FOLIO_ID to a LIVE booking (apartado) folio with a cash deposit to run this walkthrough.',
  )

  test('agent settles by transfer, admin verifies, folio shows the split', async ({ browser }) => {
    // ---- 1. Agent settles the balance by TRANSFER ------------------------------------------------
    const agentCtx = await browser.newContext()
    const page = await agentCtx.newPage()
    await login(page, env('E2E_AGENT_EMAIL'), env('E2E_AGENT_PASSWORD'))

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

    // ---- 2. Admin verifies the electronic payment ------------------------------------------------
    // NOTE: adjust the verify control to your admin UI if the label/flow differs. Verify releases the
    // tickets and marks the transfer payment confirmed.
    const adminCtx = await browser.newContext()
    const adminPage = await adminCtx.newPage()
    await login(adminPage, env('E2E_ADMIN_EMAIL'), env('E2E_ADMIN_PASSWORD'))
    await adminPage.goto(`/folios/${FOLIO_ID}`)
    await adminPage.getByRole('button', { name: /Verificar/i }).click()
    // If a confirm sheet appears, accept it (best-effort; harmless when absent).
    const confirm = adminPage.getByRole('button', { name: /^(Verificar|Confirmar)/i }).last()
    if (await confirm.isVisible().catch(() => false)) await confirm.click()
    await expect(adminPage.getByText(/Verificado|Pagado/i).first()).toBeVisible()

    // ---- 3. The folio now reads as a MIXED collection with a per-payment breakdown ---------------
    await page.reload()
    await expect(page.getByText('Desglose de pagos')).toBeVisible()
    // Both movements appear, each with its own method.
    await expect(page.getByText('Efectivo')).toBeVisible()
    await expect(page.getByText('Transferencia')).toBeVisible()
  })
})
