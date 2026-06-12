import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth'
import { requireRole } from '../../middleware/role'
import { ApiError } from '../../types/errors'
import type { AppVariables } from '../../types/context'
import {
  confirmSale,
  getFolio,
  getPosService,
  listAgentFolios,
  listPosServices,
} from './handler'
import { confirmSaleSchema } from './schema'

const pos = new Hono<{
  Bindings: CloudflareBindings
  Variables: AppVariables
}>()

const validationHook = (result: { success: boolean }) => {
  if (!result.success) {
    throw new ApiError('VALIDATION_ERROR', 400, 'Invalid request payload')
  }
}

// Selling is a daily activity for BOTH roles (US-A31): agents and admins run the same POS
// flow. Folios are attributed to the caller (agent_id = seller.userId) uniformly, so an
// admin's sales roll up to the admin's own drawer and commission report row.
pos.use('*', authMiddleware, requireRole('agent', 'admin'))

pos.get('/services', listPosServices)
pos.get('/services/:id', getPosService)
pos.post(
  '/folios',
  zValidator('json', confirmSaleSchema, validationHook),
  confirmSale,
)
pos.get('/folios', listAgentFolios)
pos.get('/folios/:id', getFolio)

export default pos
