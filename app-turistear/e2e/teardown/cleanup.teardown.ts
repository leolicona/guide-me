import { test as teardown, request as pwRequest } from '@playwright/test'
import { existsSync, rmSync } from 'node:fs'
import { ADMIN_STATE, FIXTURE_FILE, API_BASE } from '../paths'
import { seededFixture } from '../fixture'

// Cancel what this run created. Nightly runs otherwise pile up live apartados in dev, each one
// holding a seat that the next run's availability check has to work around.
//
// Deliberately never fails the suite: a stale folio in dev is untidy, not a regression, and a
// teardown that goes red would hide the result of the tests it follows.

teardown('release the seeded apartado', async () => {
  if (!existsSync(FIXTURE_FILE)) return

  const fixture = seededFixture()
  if (!fixture.seeded) {
    teardown.info().annotations.push({
      type: 'teardown',
      description: 'folio was supplied by the caller, not seeded — leaving it alone',
    })
    return
  }

  try {
    const ctx = await pwRequest.newContext({ baseURL: API_BASE, storageState: ADMIN_STATE })
    const res = await ctx.post(`/api/folios/${fixture.folioId}/cancel`, {
      data: { reason: 'E2E teardown' },
    })
    teardown.info().annotations.push({
      type: 'teardown',
      description: `cancel ${fixture.folioId} → ${res.status()}`,
    })
    await ctx.dispose()
  } catch (error) {
    teardown.info().annotations.push({
      type: 'teardown',
      description: `could not cancel ${fixture.folioId}: ${String(error)}`,
    })
  } finally {
    rmSync(FIXTURE_FILE, { force: true })
  }
})
