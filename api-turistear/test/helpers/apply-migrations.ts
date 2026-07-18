import { applyD1Migrations, env } from 'cloudflare:test'
import { vi, beforeAll, afterAll } from 'vitest'

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)

// Freeze the clock so date-relative fixtures don't rot as real time passes. US-A47 added a
// sales-time cutoff that makes any past-dated slot unsellable, which detonated the suite's
// long-standing latent date-bomb (fixtures hardcode 2026-06-15). Fake ONLY Date so the worker's
// async (waitUntil/fetch/timers) is untouched; "today" in tests is a fixed, sellable past anchor.
beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-06-14T12:00:00Z'))
})
afterAll(() => {
  vi.useRealTimers()
})
