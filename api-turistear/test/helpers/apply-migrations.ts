import { applyD1Migrations, env } from 'cloudflare:test'
import { vi, beforeAll, afterAll } from 'vitest'

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)

// TECH_DEBT #25 — TEST-ONLY fixture shim. Migration 0065 dropped the folio roll-up columns from
// the PRODUCT (status, booking_expires_at, refund_status, refund_amount): no src code reads or
// writes them any more — every fact derives from the lines. But ~27 test files still hand-seed
// `INSERT INTO folios (…, status, …)`, including the line-autonomy spec's scope-boundary file
// that must pass UNEDITED. These test-only columns are DEAD STORAGE that lets those fixtures
// keep running (and lets the ?raw backfill-replay tests exercise 0062–0064's historical SQL,
// which read the columns exactly as production's one-time run did). Nothing in src can see them;
// an assertion that reads them gets whatever the fixture wrote, never the product's answer.
// Sweep fixtures off the shim opportunistically, then delete this block.
for (const ddl of [
  `ALTER TABLE folios ADD COLUMN status TEXT`,
  `ALTER TABLE folios ADD COLUMN booking_expires_at INTEGER`,
  `ALTER TABLE folios ADD COLUMN refund_status TEXT`,
  `ALTER TABLE folios ADD COLUMN refund_amount INTEGER`,
]) {
  await env.DB.exec(ddl)
}

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
