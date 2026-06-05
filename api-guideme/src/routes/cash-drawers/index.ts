import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth'
import { requireRole } from '../../middleware/role'
import { ApiError } from '../../types/errors'
import type { AppVariables } from '../../types/context'
import {
  addExpense,
  closeDrawer,
  deleteExpense,
  getDrawerDetail,
  getMyDrawer,
  listDrawers,
  reviewDrawer,
} from './handler'
import {
  addExpenseSchema,
  closeDrawerSchema,
  reviewDrawerSchema,
} from './schema'

const drawers = new Hono<{
  Bindings: CloudflareBindings
  Variables: AppVariables
}>()

const validationHook = (result: { success: boolean }) => {
  if (!result.success) {
    throw new ApiError('VALIDATION_ERROR', 400, 'Invalid request payload')
  }
}

// Mixed-role resource: authenticate everyone, then gate per route. The agent surface is
// `/me/*` (the caller's own drawer); the admin surface reviews all drawers in the org.
drawers.use('*', authMiddleware)
const agent = requireRole('agent')
const admin = requireRole('admin')

// Static `/me/*` routes are registered BEFORE the `/:id` routes so "me" is never
// captured as an :id.
drawers.get('/me', agent, getMyDrawer)
drawers.post(
  '/me/expenses',
  agent,
  zValidator('json', addExpenseSchema, validationHook),
  addExpense,
)
drawers.delete('/me/expenses/:id', agent, deleteExpense)
drawers.post(
  '/me/close',
  agent,
  zValidator('json', closeDrawerSchema, validationHook),
  closeDrawer,
)

drawers.get('/', admin, listDrawers)
drawers.get('/:id', admin, getDrawerDetail)
drawers.post(
  '/:id/review',
  admin,
  zValidator('json', reviewDrawerSchema, validationHook),
  reviewDrawer,
)

export default drawers
