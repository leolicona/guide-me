import { Hono } from 'hono'
import { authMiddleware } from '../../middleware/auth'
import type { AppVariables } from '../../types/context'
import { getMyOrganization } from './handler'

const organizations = new Hono<{
  Bindings: CloudflareBindings
  Variables: AppVariables
}>()

// Both admin and agent may read their own organization — no role gate.
organizations.use('*', authMiddleware)

organizations.get('/me', getMyOrganization)

export default organizations
