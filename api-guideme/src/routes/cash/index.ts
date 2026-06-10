import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth'
import { requireRole } from '../../middleware/role'
import { ApiError } from '../../types/errors'
import type { AppVariables } from '../../types/context'
import {
  acknowledgeDrop,
  addExpense,
  cancelDrop,
  createDrop,
  deleteExpense,
  disputeDrop,
  getDropDetail,
  getMyBalance,
  listBalances,
  listDrops,
  registerCollection,
  registerPayout,
  resolveDispute,
  reviewDrop,
} from './handler'
import {
  addExpenseSchema,
  createDropSchema,
  createPayoutSchema,
  disputeSchema,
  registerCollectionSchema,
  resolveDisputeSchema,
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
// US-AG27/AG28 — sign or dispute a unilateral admin money-move (acknowledgment, non-blocking).
cash.post('/me/drops/:id/acknowledge', agent, acknowledgeDrop)
cash.post(
  '/me/drops/:id/dispute',
  agent,
  zValidator('json', disputeSchema, validationHook),
  disputeDrop,
)

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
// US-A27 — admin-initiated direct collection (immediate, owes signature).
cash.post(
  '/collections',
  admin,
  zValidator('json', registerCollectionSchema, validationHook),
  registerCollection,
)
// US-A27/A28 (D5) — admin resolves an agent's dispute (audit close; no money change).
cash.post(
  '/drops/:id/resolve-dispute',
  admin,
  zValidator('json', resolveDisputeSchema, validationHook),
  resolveDispute,
)
cash.post(
  '/payouts',
  admin,
  zValidator('json', createPayoutSchema, validationHook),
  registerPayout,
)

export default cash
