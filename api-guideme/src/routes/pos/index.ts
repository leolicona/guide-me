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

// POS is agent-facing: folios are agent-attributed (agent_id). Admins get
// dashboards/reports instead (separate feature).
pos.use('*', authMiddleware, requireRole('agent'))

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
