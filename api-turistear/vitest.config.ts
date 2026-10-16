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
          // devolada-transfer-verification D17, D18 — pinned. The host cannot resolve, so a call the
          // fake Devolada (test/helpers/devolada.ts) does not answer fails instead of reaching
          // Devolada. The key is a fixed 32 bytes, base64, so stored credentials stay readable
          // across one suite's requests.
          DEVOLADA_API_BASE_URL: 'https://devolada.test',
          DEVOLADA_KEY_MODE: 'test',
          DEVOLADA_WEBHOOK_URL: 'https://api.test/api/webhooks/devolada',
          DEVOLADA_CREDENTIAL_KEY: 'dGVzdF9kZXZvbGFkYV9jcmVkZW50aWFsX2tleV8zMmI=',
        },
      },
    }),
  ],
  test: {
    setupFiles: ['./test/helpers/apply-migrations.ts'],
    // passkey-auth — inside workerd, a refusal Better Auth throws from an endpoint handler (a wrong
    // code, an expired challenge, a registration that does not verify) is answered correctly AND
    // reported once more as an unhandled rejection by its dispatch pipeline. Reproduced with a
    // minimal Better Auth config; the HTTP answer is always right, and test/auth/* asserts each one.
    // Only Better Auth's own refusals — an APIError carrying its `{ code, message }` body — are
    // ignored: any other unhandled error still fails the run.
    onUnhandledError(error) {
      const body = (error as { body?: { code?: unknown } }).body
      if (error.name === 'APIError' && typeof body?.code === 'string') return false
    },
  },
})
