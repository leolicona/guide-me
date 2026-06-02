import { Hono } from 'hono'
import { renderer } from './renderer'
import { errorHandler } from './middleware/errorHandler'
import authRouter from './routes/auth'

const app = new Hono<{ Bindings: CloudflareBindings }>()

app.onError(errorHandler)

app.route('/api/auth', authRouter)

app.use(renderer)

app.get('/', (c) => {
  return c.render(<h1>Hello!</h1>)
})

export default app
