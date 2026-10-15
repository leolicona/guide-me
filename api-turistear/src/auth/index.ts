// passkey-auth — the whole Better Auth configuration (specs/004-passkey-auth/plan.md D2–D9, D12).
//
// Better Auth is CONFIGURED here, never wrapped (D2): its handler owns /api/auth/*, mounted in
// src/index.tsx, and the business middleware reads sessions through `auth.api.getSession`. What it
// cannot know (organizations, invitations) lives in routes/onboarding/.
import { betterAuth } from 'better-auth/minimal'
import { APIError, createAuthMiddleware } from 'better-auth/api'
import { emailOTP } from 'better-auth/plugins/email-otp'
import { drizzleAdapter } from '@better-auth/drizzle-adapter'
import { passkey } from '@better-auth/passkey'
import { waitUntil } from 'cloudflare:workers'
import { eq } from 'drizzle-orm'
import { getDb } from '../db/client'
import * as schema from '../db/schema'
import { sendPasskeyNoticeEmail, sendSignInCodeEmail } from '../services/resend'

const createAuth = (env: CloudflareBindings) => {
  const db = getDb(env)

  return betterAuth({
    appName: 'Turistear Ya!',
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.API_BASE_URL,
    basePath: '/api/auth',
    trustedOrigins: [env.APP_BASE_URL],
    // D1 — already off by default in 1.7.7; stated so a future default cannot turn it on.
    telemetry: { enabled: false },

    // D3, D4 — Better Auth's standard schema on D1. The Drizzle adapter addresses each model by its
    // export name in db/schema.ts and each field by its property name; Drizzle maps those to the
    // snake_case columns of migration 0071. D1 has no interactive transactions (constitution V).
    database: drizzleAdapter(db, { provider: 'sqlite', schema, transaction: false }),
    user: {
      modelName: 'users',
      // D2, constitution III — the tenant fields are ours. `input: false` keeps every Better Auth
      // route (/update-user above all) from writing them: `organization_id` never comes from a body.
      additionalFields: {
        organizationId: { type: 'string', required: true, input: false },
        role: { type: 'string', required: true, input: false },
        status: { type: 'string', required: true, defaultValue: 'unverified', input: false },
        phone: { type: 'string', required: false, input: false },
        plan: { type: 'string', required: true, defaultValue: 'free', input: false },
      },
      // Off by default; stated because an email change or a self-deletion would bypass the admin.
      changeEmail: { enabled: false },
      deleteUser: { enabled: false },
    },
    // D5 — Better Auth's session defaults: 7 days, renewed after a day of use, fresh for a day, and
    // no cookie cache, so a revocation takes effect at the next request (FR-022–FR-025).
    session: { modelName: 'sessions' },
    account: { modelName: 'accounts' },
    verification: { modelName: 'verifications' },

    // D9 — the built-in rules (`/sign-in*` 3 per 10 s, code sends 3 per 60 s, the rest 100 per
    // 60 s) per client IP, counted in D1: in memory each isolate would count on its own. Enabled
    // explicitly instead of trusting how Better Auth detects production inside a Worker.
    rateLimit: { enabled: true, storage: 'database', modelName: 'rateLimits' },

    // D2 — only the routes the app uses stay reachable over HTTP; the rest answer Better Auth's
    // 404. Server-side `auth.api.*` keeps working: only the HTTP router checks this list.
    disabledPaths: [
      // BFF (constitution IV v1.2.1): the session is never readable over HTTP.
      '/get-session',
      '/list-sessions',
      // FR-060: no password, anywhere. Core registers these even with email-and-password off,
      // and the emailOTP plugin brings a code-based reset that would write a `credential` account.
      '/sign-in/email',
      '/sign-up/email',
      '/change-password',
      '/verify-password',
      '/request-password-reset',
      '/reset-password',
      '/email-otp/request-password-reset',
      '/forget-password/email-otp',
      '/email-otp/reset-password',
      '/email-otp/check-verification-otp',
      // Out of scope (spec): changing an email; verifying one outside the sign-in code.
      '/change-email',
      '/email-otp/request-email-change',
      '/email-otp/change-email',
      '/email-otp/verify-email',
      '/send-verification-email',
      '/verify-email',
      // No social sign-in or linked accounts; no self-deletion (an admin deactivates agents).
      '/sign-in/social',
      '/link-social',
      '/unlink-account',
      '/list-accounts',
      '/account-info',
      '/refresh-token',
      '/get-access-token',
      '/delete-user',
      '/delete-user/callback',
      '/update-session',
    ],

    advanced: {
      database: { generateId: 'uuid' },
      // D5 — `__Secure-<prefix>.session_token`, one prefix per environment: dev and prod both set
      // cookies on `.turistearya.com`, so a shared name would let one overwrite the other.
      useSecureCookies: true,
      cookiePrefix: env.AUTH_COOKIE_PREFIX,
      crossSubDomainCookies: {
        enabled: !!env.COOKIE_DOMAIN,
        domain: env.COOKIE_DOMAIN || undefined,
      },
      ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] },
      // D7 — code sends and passkey notices run after the response; the Worker keeps them alive.
      backgroundTasks: { handler: waitUntil },
    },

    databaseHooks: {
      session: {
        create: {
          // D6, R5 — both sign-in paths create their session here, so one check covers both. It
          // THROWS: on `false` the email-code route would set a cookie for a null session.
          before: async (session) => {
            const [user] = await db
              .select({ status: schema.users.status })
              .from(schema.users)
              .where(eq(schema.users.id, session.userId))
              .limit(1)
            if (!user || user.status === 'suspended') {
              throw APIError.from('FORBIDDEN', {
                code: 'ACCOUNT_SUSPENDED',
                message: 'Account suspended',
              })
            }
            // FR-015 — a registered admin is `unverified` until the email code proves the address
            // (Better Auth sets `emailVerified` itself as it redeems the code). Passkeys need a
            // session first, so only an email-code sign-in can get here with one.
            if (user.status === 'unverified') {
              await db
                .update(schema.users)
                .set({ status: 'active', updatedAt: new Date() })
                .where(eq(schema.users.id, session.userId))
            }
          },
        },
      },
    },

    // D12, FR-041 — a notice for every llave de acceso added or removed, after the change
    // succeeded and in the background: a Resend failure never undoes it (constitution VIII).
    hooks: {
      after: createAuthMiddleware(async (ctx) => {
        const action =
          ctx.path === '/passkey/verify-registration'
            ? 'added'
            : ctx.path === '/passkey/delete-passkey'
              ? 'removed'
              : null
        if (!action || ctx.context.returned instanceof Error) return
        const to = ctx.context.session?.user.email
        if (!to) return
        ctx.context.runInBackground(
          sendPasskeyNoticeEmail(env, { to, action }).catch((err) =>
            console.error(`[auth] passkey ${action} notice failed`, err),
          ),
        )
      }),
    },

    plugins: [
      // D7 — the plugin's defaults: 6 digits, 5 minutes, 3 attempts, newest code wins.
      emailOTP({
        // FR-013 — an unknown email gets the same `{ success: true }` and nothing is sent.
        disableSignUp: true,
        // FR-016 — encrypted with the environment secret; 'hashed' is an unsalted SHA-256 that
        // reverses over 10⁶ codes.
        storeOTP: 'encrypted',
        // Runs in the background (advanced.backgroundTasks), so a known and an unknown email answer
        // in the same time. Only sign-in codes are sent: the routes that would redeem any other
        // type are disabled above, so such a code is never mailed.
        sendVerificationOTP: async ({ email, otp, type }) => {
          if (type !== 'sign-in') return
          await sendSignInCodeEmail(env, { to: email, code: otp })
        },
      }),
      // D8 — a per-environment relying party: a phone never offers a dev llave de acceso on prod
      // (FR-003). `origin` is explicit because, unset, the plugin trusts the request's Origin.
      passkey({
        rpID: new URL(env.APP_BASE_URL).hostname,
        rpName: 'Turistear Ya!',
        origin: env.APP_BASE_URL,
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        schema: { passkey: { modelName: 'passkeys' } },
      }),
    ],
  })
}

export type Auth = ReturnType<typeof createAuth>

// D3 — one instance per `env` object: a warm isolate rebuilds nothing, and each test's `env`
// still gets its own.
const instances = new WeakMap<CloudflareBindings, Auth>()

export const getAuth = (env: CloudflareBindings): Auth => {
  let auth = instances.get(env)
  if (!auth) {
    auth = createAuth(env)
    instances.set(env, auth)
  }
  return auth
}
