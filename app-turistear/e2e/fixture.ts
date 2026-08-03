import { readFileSync } from 'node:fs'
import { FIXTURE_FILE } from './paths'

export interface SeededFixture {
  folioId: string
  /** False when the caller supplied E2E_FOLIO_ID — teardown then leaves it alone. */
  seeded: boolean
  serviceName?: string
  /** The departure this apartado holds, `YYYY-MM-DD HH:MM` — what the settle deadline derives from. */
  departsAt?: string
  total?: number
  amountPaid?: number
  balance?: number
}

/**
 * The apartado this run owns. Throws rather than skipping: a suite that quietly skips reports
 * green while testing nothing, which is exactly how the old spec managed to never gate anything.
 */
export function seededFixture(): SeededFixture {
  try {
    return JSON.parse(readFileSync(FIXTURE_FILE, 'utf8')) as SeededFixture
  } catch {
    throw new Error(
      `No seeded fixture at ${FIXTURE_FILE}. The 'seed' project must run first — ` +
        `run \`pnpm test:e2e\` rather than a single spec in isolation.`,
    )
  }
}
