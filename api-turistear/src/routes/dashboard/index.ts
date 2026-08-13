import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth'
import { requireRole } from '../../middleware/role'
import { ApiError } from '../../types/errors'
import type { AppVariables } from '../../types/context'
import { getDashboardDay } from './handler'
import { dashboardDayQuerySchema } from './schema'

// US-A14/A15/A16/A90 — the Daily Operations Dashboard (docs/dashboard/occupancy-dashboard.spec.md).
// Admin-only, org-scoped, read-only: one aggregate per day, polled by the Hoy screen (60 s).
const dashboard = new Hono<{
  Bindings: CloudflareBindings
  Variables: AppVariables
}>()

const validationHook = (result: { success: boolean }) => {
  if (!result.success) {
    throw new ApiError('VALIDATION_ERROR', 400, 'Invalid request payload')
  }
}

dashboard.use('*', authMiddleware, requireRole('admin'))

dashboard.get('/day', zValidator('query', dashboardDayQuerySchema, validationHook), getDashboardDay)

export default dashboard
