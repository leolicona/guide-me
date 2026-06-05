import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth'
import { requireRole } from '../../middleware/role'
import { ApiError } from '../../types/errors'
import type { AppVariables } from '../../types/context'
import {
  addExpense,
  cancelDrop,
  createDrop,
  deleteExpense,
  getDropDetail,
  getMyBalance,
  listBalances,
  listDrops,
  registerPayout,
  reviewDrop,
} from './handler'
import {
  addExpenseSchema,
  createDropSchema,
  createPayoutSchema,
  reviewDropSchema,
} from './schema'

// Agent continuous cash balance with cash drops. Mixed-role router: authMiddleware on every
// route, then per-route requireRole — agent for the /me/* surface, admin for the
// balances/drops review surface. Static /me/* is registered BEFORE the /drops/:id routes so
// it can never be shadowed.
const cash = new Hono<{
  Bindings: CloudflareBindings
  Variables: AppVariables
}>()

const validationHook = (result: { success: boolean }) => {
  if (!result.success) {
    throw new ApiError('VALIDATION_ERROR', 400, 'Invalid request payload')
  }
}

cash.use('*', authMiddleware)

const agent = requireRole('agent')
const admin = requireRole('admin')

// Agent surface (/me/*) — scoped to the caller.
cash.get('/me', agent, getMyBalance)
cash.post(
  '/me/expenses',
  agent,
  zValidator('json', addExpenseSchema, validationHook),
  addExpense,
)
cash.delete('/me/expenses/:id', agent, deleteExpense)
cash.post(
  '/me/drops',
  agent,
  zValidator('json', createDropSchema, validationHook),
  createDrop,
)
cash.delete('/me/drops/:id', agent, cancelDrop)

// Admin surface — org-wide (agents in the caller's org only).
cash.get('/balances', admin, listBalances)
cash.get('/drops', admin, listDrops)
cash.get('/drops/:id', admin, getDropDetail)
cash.post(
  '/drops/:id/review',
  admin,
  zValidator('json', reviewDropSchema, validationHook),
  reviewDrop,
)
cash.post(
  '/payouts',
  admin,
  zValidator('json', createPayoutSchema, validationHook),
  registerPayout,
)

export default cash
