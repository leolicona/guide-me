import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth'
import { requireRole } from '../../middleware/role'
import { ApiError } from '../../types/errors'
import type { AppVariables } from '../../types/context'
import {
  addExtra,
  createService,
  deactivateService,
  deleteExtra,
  getService,
  listServices,
  reactivateService,
  updateExtra,
  updateService,
} from './handler'
import {
  createExtraSchema,
  createServiceSchema,
  updateExtraSchema,
  updateServiceSchema,
} from './schema'
import {
  createSchedule,
  createSlot,
  deactivateSchedule,
  deactivateSlot,
  listSchedules,
  listSlots,
  reactivateSlot,
  updateSlot,
} from './slots.handler'
import {
  createScheduleSchema,
  createSlotSchema,
  updateSlotSchema,
} from './slots.schema'

const services = new Hono<{
  Bindings: CloudflareBindings
  Variables: AppVariables
}>()

const validationHook = (result: { success: boolean }) => {
  if (!result.success) {
    throw new ApiError('VALIDATION_ERROR', 400, 'Invalid request payload')
  }
}

services.use('*', authMiddleware, requireRole('admin'))

services.post(
  '/',
  zValidator('json', createServiceSchema, validationHook),
  createService,
)
services.get('/', listServices)
services.get('/:id', getService)
services.put(
  '/:id',
  zValidator('json', updateServiceSchema, validationHook),
  updateService,
)
services.post('/:id/deactivate', deactivateService)
services.post('/:id/reactivate', reactivateService)

services.post(
  '/:id/extras',
  zValidator('json', createExtraSchema, validationHook),
  addExtra,
)
services.put(
  '/:id/extras/:extraId',
  zValidator('json', updateExtraSchema, validationHook),
  updateExtra,
)
services.delete('/:id/extras/:extraId', deleteExtra)

// Slots & schedules (US-A10) — nested under a service, admin-only via the `*`
// middleware above.
services.post(
  '/:id/slots',
  zValidator('json', createSlotSchema, validationHook),
  createSlot,
)
services.get('/:id/slots', listSlots)
services.put(
  '/:id/slots/:slotId',
  zValidator('json', updateSlotSchema, validationHook),
  updateSlot,
)
services.post('/:id/slots/:slotId/deactivate', deactivateSlot)
services.post('/:id/slots/:slotId/reactivate', reactivateSlot)

services.post(
  '/:id/schedules',
  zValidator('json', createScheduleSchema, validationHook),
  createSchedule,
)
services.get('/:id/schedules', listSchedules)
services.post('/:id/schedules/:scheduleId/deactivate', deactivateSchedule)

export default services
