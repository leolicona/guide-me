import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { renderer } from './renderer'
import { errorHandler } from './middleware/errorHandler'
import { authMiddleware } from './middleware/auth'
import { requireRole } from './middleware/role'
import agentsRouter from './routes/agents'
import authRouter from './routes/auth'
import organizationsRouter from './routes/organizations'
import cashDrawersRouter from './routes/cash-drawers'
import posRouter from './routes/pos'
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
app.route('/api/organizations', organizationsRouter)
app.route('/api/services', servicesRouter)
app.route('/api/pos', posRouter)
app.route('/api/tickets', ticketsRouter)
app.route('/api/cash-drawers', cashDrawersRouter)

app.get('/api/me', authMiddleware, (c) => c.json({ user: c.get('user') }))

app.post('/api/admin-only', authMiddleware, requireRole('admin'), (c) =>
  c.json({ ok: true }),
)

app.use(renderer)

app.get('/', (c) => {
  return c.render(<h1>Hello!</h1>)
})

export default app
