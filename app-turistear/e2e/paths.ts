import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Resolved relative to THIS file, so nothing depends on the cwd Playwright was launched from.
const here = dirname(fileURLToPath(import.meta.url))

export const AUTH_DIR = resolve(here, '.auth')
export const AGENT_STATE = resolve(AUTH_DIR, 'agent.json')
export const ADMIN_STATE = resolve(AUTH_DIR, 'admin.json')
/** What the seed project hands to the specs (folio id and what was seeded into it). */
export const FIXTURE_FILE = resolve(AUTH_DIR, 'fixture.json')

/** The app origin under test. */
export const BASE_URL = process.env.E2E_BASE_URL ?? 'https://app-dev.turistearya.com'
/** The API origin — a different host, but cookies are scoped to `.turistearya.com` for both. */
export const API_BASE = process.env.E2E_API_BASE ?? 'https://api-dev.turistearya.com'
