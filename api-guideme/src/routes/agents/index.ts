import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth'
import { requireRole } from '../../middleware/role'
import { ApiError } from '../../types/errors'
import type { AppVariables } from '../../types/context'
import { inviteAgent } from './handler'
import { inviteAgentSchema } from './schema'

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

agents.post(
  '/invite',
  zValidator('json', inviteAgentSchema, validationHook),
  inviteAgent,
)

export default agents
