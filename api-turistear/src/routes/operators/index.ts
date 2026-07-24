import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth'
import { requireRole } from '../../middleware/role'
import { ApiError } from '../../types/errors'
import type { AppVariables } from '../../types/context'
import {
  changePin,
  createOperator,
  listOperators,
  login,
  logoutOperator,
  removeOperator,
  resetOperatorPin,
  resolveAccess,
  setPin,
} from './handler'
import { changePinSchema, createOperatorSchema, loginSchema, setPinSchema } from './schema'

type Env = { Bindings: CloudflareBindings; Variables: AppVariables }

const validationHook = (result: { success: boolean }) => {
  if (!result.success) {
    throw new ApiError('VALIDATION_ERROR', 400, 'Invalid request payload')
  }
}

// Manager surface — mounted at /api/affiliate/operators. A real affiliate manager session (an
// operator's borrowed session is rejected inside the handlers — D6).
export const managerOperatorsRouter = new Hono<Env>()
managerOperatorsRouter.use('*', authMiddleware, requireRole('affiliate'))
managerOperatorsRouter.get('/', listOperators)
managerOperatorsRouter.post('/', zValidator('json', createOperatorSchema, validationHook), createOperator)
managerOperatorsRouter.post('/:id/reset-pin', resetOperatorPin)
managerOperatorsRouter.post('/:id/remove', removeOperator)

// Operator access surface — mounted at /api/operator. Token-based (pre-session) for resolve /
// set-pin / login; the shift-session cookie guards change-pin / logout.
export const operatorAccessRouter = new Hono<Env>()
operatorAccessRouter.get('/access/:token', resolveAccess)
operatorAccessRouter.post('/access/:token/set-pin', zValidator('json', setPinSchema, validationHook), setPin)
operatorAccessRouter.post('/access/:token/login', zValidator('json', loginSchema, validationHook), login)
operatorAccessRouter.post(
  '/change-pin',
  authMiddleware,
  zValidator('json', changePinSchema, validationHook),
  changePin,
)
operatorAccessRouter.post('/logout', logoutOperator)
