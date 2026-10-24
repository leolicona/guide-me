import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth'
import { requireRole } from '../../middleware/role'
import { ApiError } from '../../types/errors'
import type { AppVariables } from '../../types/context'
import { resolveDevoladaPayment } from './handler'
import { resolveDevoladaPaymentSchema } from './schema'

// devolada-transfer-verification D15 — the admin's decisions on Devolada exceptions. The connection
// itself lives under /organizations/me/devolada; the webhook under /webhooks.
const devoladaRouter = new Hono<{
  Bindings: CloudflareBindings
  Variables: AppVariables
}>()

const validationHook = (result: { success: boolean }) => {
  if (!result.success) {
    throw new ApiError('VALIDATION_ERROR', 400, 'Invalid request payload')
  }
}

devoladaRouter.use('*', authMiddleware, requireRole('admin'))

devoladaRouter.post(
  '/payments/:id/resolve',
  zValidator('json', resolveDevoladaPaymentSchema, validationHook),
  resolveDevoladaPayment,
)

export default devoladaRouter
