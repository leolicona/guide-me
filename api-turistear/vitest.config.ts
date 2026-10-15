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
          // passkey-auth D17, constitution VI — pinned, so a local .dev.vars never leaks into a
          // suite. test/helpers/session.ts signs fixture cookies with this exact secret and prefix.
          BETTER_AUTH_SECRET: 'test_better_auth_secret_0123456789abcdef',
          AUTH_COOKIE_PREFIX: 'gm-test',
          COOKIE_DOMAIN: '',
          OTP_LOG_TO_CONSOLE: '',
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
    // passkey-auth — inside workerd, a refusal Better Auth throws from an endpoint handler (a wrong
    // code, an expired challenge) is answered correctly AND reported once more as an unhandled
    // rejection by its dispatch pipeline. Reproduced with a minimal Better Auth config; the HTTP
    // answer is always right, and test/auth/* asserts each one. Only Better Auth's 4xx APIError is
    // ignored: any other unhandled error still fails the run.
    onUnhandledError(error) {
      const status = (error as { statusCode?: unknown }).statusCode
      if (error.name === 'APIError' && typeof status === 'number' && status >= 400 && status < 500) {
        return false
      }
    },
  },
})
