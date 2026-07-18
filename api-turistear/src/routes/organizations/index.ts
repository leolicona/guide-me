import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth'
import { requireRole } from '../../middleware/role'
import { ApiError } from '../../types/errors'
import type { AppVariables } from '../../types/context'
import { getMyOrganization, updateMyOrganization } from './handler'
import { updateOrganizationSchema } from './schema'

const organizations = new Hono<{
  Bindings: CloudflareBindings
  Variables: AppVariables
}>()

const validationHook = (result: { success: boolean }) => {
  if (!result.success) {
    throw new ApiError('VALIDATION_ERROR', 400, 'Invalid request payload')
  }
}

// Both admin and agent may read their own organization — no role gate.
organizations.use('*', authMiddleware)

organizations.get('/me', getMyOrganization)
// US-A46 — only an admin may edit the org booking policy.
organizations.put(
  '/me',
  requireRole('admin'),
  zValidator('json', updateOrganizationSchema, validationHook),
  updateMyOrganization,
)

export default organizations
