import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth'
import { requireRole } from '../../middleware/role'
import { ApiError } from '../../types/errors'
import type { AppVariables } from '../../types/context'
import { exportCommissionReport, getCommissionReport } from './handler'
import { commissionExportQuerySchema, commissionReportQuerySchema } from './schema'

// Commission & settlement report by period (US-A17/A18/A20). Admin-only, org-scoped, read-only:
// a date-range query over folios + cash drops + payouts. Spec: docs/reports/commission-report.spec.md.
const reports = new Hono<{
  Bindings: CloudflareBindings
  Variables: AppVariables
}>()

const validationHook = (result: { success: boolean }) => {
  if (!result.success) {
    throw new ApiError('VALIDATION_ERROR', 400, 'Invalid request payload')
  }
}

reports.use('*', authMiddleware)

const admin = requireRole('admin')

reports.get(
  '/commissions',
  admin,
  zValidator('query', commissionReportQuerySchema, validationHook),
  getCommissionReport,
)
reports.get(
  '/commissions/export',
  admin,
  zValidator('query', commissionExportQuerySchema, validationHook),
  exportCommissionReport,
)

export default reports
