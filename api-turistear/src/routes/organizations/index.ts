import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth'
import { requireRole } from '../../middleware/role'
import { ApiError } from '../../types/errors'
import type { AppVariables } from '../../types/context'
import {
  connectMyDevolada,
  disconnectMyDevolada,
  getMyDevolada,
  getMyOrganization,
  updateMyOrganization,
} from './handler'
import { connectDevoladaSchema, updateOrganizationSchema } from './schema'

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

// devolada-transfer-verification D1-D3 — the organization's Devolada connection: admin only, for
// reading its health as much as for changing it (FR-001).
organizations.get('/me/devolada', requireRole('admin'), getMyDevolada)
organizations.put(
  '/me/devolada',
  requireRole('admin'),
  zValidator('json', connectDevoladaSchema, validationHook),
  connectMyDevolada,
)
organizations.delete('/me/devolada', requireRole('admin'), disconnectMyDevolada)

export default organizations
