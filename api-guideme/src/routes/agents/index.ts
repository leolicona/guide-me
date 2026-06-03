import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth'
import { requireRole } from '../../middleware/role'
import { ApiError } from '../../types/errors'
import type { AppVariables } from '../../types/context'
import {
  deactivateAgent,
  inviteAgent,
  listAgents,
  reactivateAgent,
  updateAgent,
} from './handler'
import { inviteAgentSchema, updateAgentSchema } from './schema'

const agents = new Hono<{
  Bindings: CloudflareBindings
  Variables: AppVariables
}>()

const validationHook = (result: { success: boolean }) => {
  if (!result.success) {
    throw new ApiError('VALIDATION_ERROR', 400, 'Invalid request payload')
  }
}

agents.use('*', authMiddleware, requireRole('admin'))

agents.get('/', listAgents)

agents.post(
  '/invite',
  zValidator('json', inviteAgentSchema, validationHook),
  inviteAgent,
)

agents.put(
  '/:id',
  zValidator('json', updateAgentSchema, validationHook),
  updateAgent,
)

agents.post('/:id/deactivate', deactivateAgent)

agents.post('/:id/reactivate', reactivateAgent)

export default agents
