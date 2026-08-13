import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { renderer } from './renderer'
import { errorHandler } from './middleware/errorHandler'
import { authMiddleware } from './middleware/auth'
import { requireRole } from './middleware/role'
import affiliatesRouter from './routes/affiliates'
import agentsRouter from './routes/agents'
import authRouter from './routes/auth'
import cashRouter from './routes/cash'
import dashboardRouter from './routes/dashboard'
import organizationsRouter from './routes/organizations'
import foliosRouter from './routes/folios'
import { managerOperatorsRouter, operatorAccessRouter } from './routes/operators'
import portalRouter from './routes/portal'
import posRouter from './routes/pos'
import { sweepExpiredBookings } from './routes/pos/sweep'
import { sweepDepartureReminders } from './routes/pos/reminders'
import reportsRouter from './routes/reports'
import notificationsRouter from './routes/notifications'
import servicesRouter from './routes/services'
import ticketRouter from './routes/ticket'
import ticketsRouter from './routes/tickets'
import type { AppVariables } from './types/context'

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
  })(c, next)
})

app.route('/api/auth', authRouter)
app.route('/api/agents', agentsRouter)
app.route('/api/affiliates', affiliatesRouter)
app.route('/api/organizations', organizationsRouter)
app.route('/api/services', servicesRouter)
app.route('/api/pos', posRouter)
app.route('/api/folios', foliosRouter)
app.route('/api/tickets', ticketsRouter)
app.route('/api/cash', cashRouter)
app.route('/api/reports', reportsRouter)
app.route('/api/dashboard', dashboardRouter)
app.route('/api/notifications', notificationsRouter)
app.route('/api/affiliate/operators', managerOperatorsRouter)
app.route('/api/operator', operatorAccessRouter)

app.get('/api/me', authMiddleware, (c) =>
  c.json({ user: c.get('user'), operator: c.get('operator') ?? null }),
)

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
    _event: ScheduledController,
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
  },
}
