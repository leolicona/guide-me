import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth'
import { requireRole } from '../../middleware/role'
import { ApiError } from '../../types/errors'
import type { AppVariables } from '../../types/context'
import { cancelFolio, getFolioDetail, listFolios } from './handler'
import { cancelFolioSchema } from './schema'

const foliosRouter = new Hono<{
  Bindings: CloudflareBindings
  Variables: AppVariables
}>()

const validationHook = (result: { success: boolean }) => {
  if (!result.success) {
    throw new ApiError('VALIDATION_ERROR', 400, 'Invalid request payload')
  }
}

// US-A21 — admin-only folio management (browse + total cancellation). The agent receipt
// read stays at GET /api/pos/folios/:id (agent-scoped) and is untouched.
foliosRouter.use('*', authMiddleware, requireRole('admin'))

foliosRouter.get('/', listFolios)
foliosRouter.get('/:id', getFolioDetail)
foliosRouter.post(
  '/:id/cancel',
  zValidator('json', cancelFolioSchema, validationHook),
  cancelFolio,
)

export default foliosRouter
