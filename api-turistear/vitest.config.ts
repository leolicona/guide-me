import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import {
  cloudflareTest,
  readD1Migrations,
} from '@cloudflare/vitest-pool-workers'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const migrationsPath = path.join(__dirname, 'migrations')
const migrations = await readD1Migrations(migrationsPath)

export default defineConfig({
  plugins: [
    cloudflareTest({
      singleWorker: true,
      isolatedStorage: true,
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: migrations,
          RESEND_API_KEY: 'test_resend_key',
          QR_SECRET: 'test_qr_secret',
          // Force tests to use the (mocked) AGNOSTIC_AUTH_API service binding,
          // overriding any DEV_AUTH_SERVICE_URL inherited from .dev.vars.
          DEV_AUTH_SERVICE_URL: '',
        },
        serviceBindings: {
          AGNOSTIC_AUTH_API: () =>
            new Response('{"success":false}', { status: 500 }),
        },
      },
    }),
  ],
  test: {
    setupFiles: ['./test/helpers/apply-migrations.ts'],
  },
})
