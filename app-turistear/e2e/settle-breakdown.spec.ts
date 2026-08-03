import { test, expect, request as pwRequest } from '@playwright/test'
import { seededFixture } from './fixture'
import { ADMIN_STATE, API_BASE } from './paths'

// Paid-ledger journey (US-LG03 / US-LG08) against a DEPLOYED environment.
//
// An agent settles a booking's remaining balance BY TRANSFER — a different method than the cash
// deposit — an admin verifies the electronic payment, and the folio then reads as a MIXED
// collection whose per-payment breakdown shows the deposit and the balance separately.
//
// The apartado is created by the `seed` project (e2e/setup/seed.setup.ts) and cancelled by
// `cleanup`; the browser is already signed in as the agent via the `auth` project's storageState.
// There is nothing to skip on and nothing for a human to supply beyond credentials.

test.describe('Settle balance by transfer → Mixto → per-payment breakdown', () => {
  test('agent settles by transfer, admin verifies, folio shows the split', async ({ page }) => {
    const { folioId } = seededFixture()

    // ---- 1. The agent settles the balance by TRANSFER -------------------------------------------
    await page.goto(`/pos/folio/${folioId}`)
    await page.getByRole('button', { name: 'Liquidar saldo' }).click()

    // The SettleSheet: pick Transferencia, enter its reference, submit. These labels are covered by
    // SettleSheet.test.tsx too, so a rename fails there first — in milliseconds, not minutes.
    await expect(page.getByText('Saldo por cobrar')).toBeVisible()
    await page.getByRole('button', { name: 'Transferencia' }).click()
    await page
      .getByLabel('Referencia de la transferencia')
      .fill(`E2E-${folioId.slice(0, 8).toUpperCase()}`)
    await page.getByRole('button', { name: 'Cobrar y liquidar' }).click()

    // A transfer balance defers the QR to admin verification — the folio says it awaits an admin.
    await expect(page.getByText(/Por verificar/i)).toBeVisible()

    // ---- 2. The admin verifies the electronic payment -------------------------------------------
    // Done through the API on purpose: this is pre-existing US-A67 machinery, not the flow under
    // test, and driving it through the UI would couple this journey to the admin folio screen.
    const api = await pwRequest.newContext({ baseURL: API_BASE, storageState: ADMIN_STATE })
    const verify = await api.post(`/api/pos/folios/${folioId}/verify`)
    expect(verify.ok(), `verify failed: ${verify.status()} ${await verify.text()}`).toBeTruthy()
    await api.dispose()

    // ---- 3. The folio now reads as a MIXED collection with a per-payment breakdown ---------------
    await page.reload()
    await expect(page.getByText('Mixto')).toBeVisible()
    await expect(page.getByText('Desglose de pagos')).toBeVisible()
    await expect(page.getByText('Efectivo')).toBeVisible()
    await expect(page.getByText('Transferencia')).toBeVisible()
  })
})
