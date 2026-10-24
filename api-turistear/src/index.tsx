import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { renderer } from './renderer'
import { errorHandler } from './middleware/errorHandler'
import { authMiddleware } from './middleware/auth'
import { requireRole } from './middleware/role'
import { getAuth } from './auth'
import agentsRouter from './routes/agents'
import cashRouter from './routes/cash'
import dashboardRouter from './routes/dashboard'
import organizationsRouter from './routes/organizations'
import foliosRouter from './routes/folios'
import portalRouter from './routes/portal'
import posRouter from './routes/pos'
import { sweepExpiredBookings } from './routes/pos/sweep'
import { sweepDepartureReminders } from './routes/pos/reminders'
import { sweepDevoladaPayments } from './routes/devolada/sweep'
import reportsRouter from './routes/reports'
import notificationsRouter from './routes/notifications'
import onboardingRouter from './routes/onboarding'
import servicesRouter from './routes/services'
import ticketRouter from './routes/ticket'
import ticketsRouter from './routes/tickets'
import webhooksRouter from './routes/webhooks'
import devoladaRouter from './routes/devolada'
import type { AppVariables } from './types/context'

// passkey-auth D2, R14 — keep the BFF: the HttpOnly cookie alone authenticates, so no answer may
// carry the session token, which a script in the page could carry elsewhere. Better Auth echoes it
// in the sign-in answers (`{ token, user }` for an email code, `{ session: { token, … }, user }`
// for a llave de acceso). Every JSON object answer under /api/auth/* is rebuilt without `token` and
// `session.token`, keeping its status and every header — Set-Cookie included. Filtering them all,
// not just today's two routes, means an upgrade that adds an echo cannot re-expose it silently.
const withoutSessionToken = async (res: Response): Promise<Response> => {
  if (!res.headers.get('content-type')?.includes('application/json')) return res
  const body: unknown = await res.clone().json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) return res
  const record = body as Record<string, unknown>
  const session = record.session
  const echoesToken =
    'token' in record ||
    (!!session && typeof session === 'object' && 'token' in (session as object))
  if (!echoesToken) return res
  const { token: _token, ...rest } = record
  if (rest.session && typeof rest.session === 'object') {
    const { token: _sessionToken, ...safeSession } = rest.session as Record<string, unknown>
    rest.session = safeSession
  }
  const headers = new Headers(res.headers)
  headers.delete('content-length')
  return new Response(JSON.stringify(rest), {
    status: res.status,
    statusText: res.statusText,
    headers,
  })
}

const app = new Hono<{
  Bindings: CloudflareBindings
  Variables: AppVariables
}>()

app.onError(errorHandler)

app.use('/api/*', async (c, next) => {
  const allowedOrigins = c.env.CORS_ORIGIN.split(',').map((o) => o.trim())
  return cors({
    origin: (origin) => (allowedOrigins.includes(origin) ? origin : null),
    credentials: true,
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type'],
    // passkey-auth D9 — Better Auth's rate limiter answers 429 with the wait in this header; the
    // app reads it to count down "Reenviar código".
    exposeHeaders: ['X-Retry-After'],
  })(c, next)
})

// passkey-auth D2 — Better Auth's handler owns /api/auth/*, with its own validation, errors and
// codes (constitution IV, v1.2.1). Unknown paths under it, such as the retired /login, get its 404.
app.on(['GET', 'POST'], '/api/auth/*', async (c) =>
  withoutSessionToken(await getAuth(c.env).handler(c.req.raw)),
)
// passkey-auth D10, D11 — registering an organization and accepting an invitation.
app.route('/api/onboarding', onboardingRouter)
app.route('/api/agents', agentsRouter)
app.route('/api/organizations', organizationsRouter)
app.route('/api/services', servicesRouter)
app.route('/api/pos', posRouter)
app.route('/api/folios', foliosRouter)
app.route('/api/tickets', ticketsRouter)
app.route('/api/cash', cashRouter)
app.route('/api/reports', reportsRouter)
app.route('/api/dashboard', dashboardRouter)
app.route('/api/notifications', notificationsRouter)
// devolada-transfer-verification D15 — the admin resolves Devolada exceptions.
app.route('/api/devolada', devoladaRouter)
// devolada-transfer-verification D4 — public: Devolada proves itself with its signature.
app.route('/api/webhooks', webhooksRouter)

app.get('/api/me', authMiddleware, (c) => c.json({ user: c.get('user') }))

app.post('/api/admin-only', authMiddleware, requireRole('admin'), (c) =>
  c.json({ ok: true }),
)

app.use(renderer)

// Tourist self-service portal (US-T01–T05) — PUBLIC SSR pages. Registered after the
// renderer so c.render is available; outside /api/* so CORS/auth never apply (the
// folio-scoped token in the URL is the credential).
app.route('/portal', portalRouter)

// US-T07 — the line-scoped public ticket page a tourist's camera resolves to (the QR encodes
// `${API_BASE_URL}/t/<qr_token>`, express-sale D9). Same placement rules as the portal.
app.route('/t', ticketRouter)

app.get('/', (c) => {
  return c.render(<h1>Hello!</h1>)
})

// Worker handlers: the Hono app serves `fetch`; `scheduled` runs the bookings auto-expiry sweep
// (US-AG07 P3) on the cron trigger in wrangler.jsonc. waitUntil so the sweep finishes after return.
export default {
  fetch: app.fetch,
  scheduled: (
    controller: ScheduledController,
    env: CloudflareBindings,
    ctx: ExecutionContext,
  ) => {
    ctx.waitUntil(
      sweepExpiredBookings(env)
        .then((r) =>
          console.log(
            `[sweep] notified=${r.notified} cancelled=${r.cancelled} failed=${r.failed}`,
          ),
        )
        // The sweep is fail-soft per folio, so reaching here means the run itself broke (a bad
        // connection, a missing binding) rather than one bad apartado.
        .catch((err) => console.error('[sweep] expired-bookings sweep failed', err)),
    )
    // US-T08 — the departure reminder and the review request (Phase 4). A SEPARATE waitUntil, so
    // an apartado sweep that breaks does not take the reminders down with it, and vice versa: they
    // share a cron trigger but not a failure. Both emit into the outbox and send nothing
    // themselves, and emitting is idempotent through the unique index — so this may run every
    // fifteen minutes, be retried, or overlap itself without a customer getting a message twice.
    ctx.waitUntil(
      sweepDepartureReminders(env)
        .then((r) =>
          console.log(
            `[reminders] reminded=${r.reminded} reviews=${r.reviews} failed=${r.failed}`,
          ),
        )
        .catch((err) => console.error('[reminders] departure-reminder sweep failed', err)),
    )
    // devolada-transfer-verification D12 — the Devolada recovery sweep, a THIRD independent
    // waitUntil: a lost notification is applied at the next run. `now` is the trigger's own time,
    // so local validation can advance the clock with `/cdn-cgi/local/scheduled?time=`.
    ctx.waitUntil(
      sweepDevoladaPayments(env, new Date(controller.scheduledTime))
        .then((r) =>
          console.log(`[devolada] checked=${r.checked} applied=${r.applied} failed=${r.failed}`),
        )
        .catch((err) => console.error('[devolada] recovery sweep failed', err)),
    )
  },
}
