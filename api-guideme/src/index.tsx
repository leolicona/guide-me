import { Hono } from 'hono'
import { renderer } from './renderer'
import { errorHandler } from './middleware/errorHandler'
import { authMiddleware } from './middleware/auth'
import { requireRole } from './middleware/role'
import authRouter from './routes/auth'
import type { AppVariables } from './types/context'

const app = new Hono<{
  Bindings: CloudflareBindings
  Variables: AppVariables
}>()

app.onError(errorHandler)

app.route('/api/auth', authRouter)

app.get('/api/me', authMiddleware, (c) => c.json({ user: c.get('user') }))

app.post('/api/admin-only', authMiddleware, requireRole('admin'), (c) =>
  c.json({ ok: true }),
)

app.use(renderer)

app.get('/', (c) => {
  return c.render(<h1>Hello!</h1>)
})

export default app
