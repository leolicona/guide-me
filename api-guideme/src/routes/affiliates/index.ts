import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth'
import { requireRole } from '../../middleware/role'
import { ApiError } from '../../types/errors'
import type { AppVariables } from '../../types/context'
import {
  createAffiliate,
  deactivateAffiliate,
  getAffiliate,
  getAffiliateReport,
  inviteAffiliate,
  listAffiliates,
  reactivateAffiliate,
  setAffiliateCommissions,
  updateAffiliate,
} from './handler'
import {
  bulkCommissionsSchema,
  createAffiliateSchema,
  inviteAffiliateSchema,
  reportQuerySchema,
  updateAffiliateSchema,
} from './schema'

// Affiliate setup & commissions (admin-only). docs/affiliates/affiliate-setup-commissions.spec.md.
const affiliates = new Hono<{
  Bindings: CloudflareBindings
  Variables: AppVariables
}>()

const validationHook = (result: { success: boolean }) => {
  if (!result.success) {
    throw new ApiError('VALIDATION_ERROR', 400, 'Invalid request payload')
  }
}

affiliates.use('*', authMiddleware, requireRole('admin'))

affiliates.get('/', listAffiliates)
affiliates.post(
  '/',
  zValidator('json', createAffiliateSchema, validationHook),
  createAffiliate,
)
affiliates.get('/:id', getAffiliate)
affiliates.put(
  '/:id',
  zValidator('json', updateAffiliateSchema, validationHook),
  updateAffiliate,
)
affiliates.put(
  '/:id/commissions',
  zValidator('json', bulkCommissionsSchema, validationHook),
  setAffiliateCommissions,
)
affiliates.post(
  '/:id/invite',
  zValidator('json', inviteAffiliateSchema, validationHook),
  inviteAffiliate,
)
affiliates.post('/:id/deactivate', deactivateAffiliate)
affiliates.post('/:id/reactivate', reactivateAffiliate)
affiliates.get(
  '/:id/report',
  zValidator('query', reportQuerySchema, validationHook),
  getAffiliateReport,
)

export default affiliates
