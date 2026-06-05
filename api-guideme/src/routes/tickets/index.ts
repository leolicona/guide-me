import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth'
import { requireRole } from '../../middleware/role'
import { ApiError } from '../../types/errors'
import type { AppVariables } from '../../types/context'
import { scanTicket } from './handler'
import { scanTicketSchema } from './schema'

const tickets = new Hono<{
  Bindings: CloudflareBindings
  Variables: AppVariables
}>()

const validationHook = (result: { success: boolean }) => {
  if (!result.success) {
    throw new ApiError('VALIDATION_ERROR', 400, 'Invalid request payload')
  }
}

// Ticket redemption is agent-facing (the agent scans at the gate). Leaves room for the
// Phase-2 `POST /api/tickets/sync` sibling (offline validation) on the same router.
tickets.use('*', authMiddleware, requireRole('agent'))

tickets.post(
  '/scan',
  zValidator('json', scanTicketSchema, validationHook),
  scanTicket,
)

export default tickets
