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
import organizationsRouter from './routes/organizations'
import foliosRouter from './routes/folios'
import portalRouter from './routes/portal'
import posRouter from './routes/pos'
import { sweepExpiredBookings } from './routes/pos/sweep'
import reportsRouter from './routes/reports'
import servicesRouter from './routes/services'
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

app.get('/api/me', authMiddleware, (c) => c.json({ user: c.get('user') }))

app.post('/api/admin-only', authMiddleware, requireRole('admin'), (c) =>
  c.json({ ok: true }),
)

app.use(renderer)

// Tourist self-service portal (US-T01–T05) — PUBLIC SSR pages. Registered after the
// renderer so c.render is available; outside /api/* so CORS/auth never apply (the
// folio-scoped token in the URL is the credential).
app.route('/portal', portalRouter)

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
      sweepExpiredBookings(env).catch((err) =>
        console.error('[sweep] expired-bookings sweep failed', err),
      ),
    )
  },
}
