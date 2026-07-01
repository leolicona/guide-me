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
  deleteService,
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
import {
  addBlockout,
  addSeason,
  createUnit,
  deactivateUnit,
  deleteBlockout,
  deleteSeason,
  listBlockouts,
  listSeasons,
  listUnits,
  reactivateUnit,
  updateSeason,
  updateUnit,
} from './lodging.handler'
import {
  createBlockoutSchema,
  createSeasonSchema,
  createUnitSchema,
  updateSeasonSchema,
  updateUnitSchema,
} from './lodging.schema'

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
// US-A58 — guarded hard-delete (409 SERVICE_HAS_FOLIOS if it has sales history).
services.delete('/:id', deleteService)

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

// Accommodation / lodging (US-A59–A63) — units + per-unit seasons & blockouts, nested under a
// lodging service. Admin-only via the `*` middleware above. Spec: docs/lodging/accommodation-stays.spec.md.
services.post(
  '/:id/units',
  zValidator('json', createUnitSchema, validationHook),
  createUnit,
)
services.get('/:id/units', listUnits)
services.put(
  '/:id/units/:unitId',
  zValidator('json', updateUnitSchema, validationHook),
  updateUnit,
)
services.post('/:id/units/:unitId/deactivate', deactivateUnit)
services.post('/:id/units/:unitId/reactivate', reactivateUnit)

services.post(
  '/:id/units/:unitId/seasons',
  zValidator('json', createSeasonSchema, validationHook),
  addSeason,
)
services.get('/:id/units/:unitId/seasons', listSeasons)
services.put(
  '/:id/units/:unitId/seasons/:seasonId',
  zValidator('json', updateSeasonSchema, validationHook),
  updateSeason,
)
services.delete('/:id/units/:unitId/seasons/:seasonId', deleteSeason)

services.post(
  '/:id/units/:unitId/blockouts',
  zValidator('json', createBlockoutSchema, validationHook),
  addBlockout,
)
services.get('/:id/units/:unitId/blockouts', listBlockouts)
services.delete('/:id/units/:unitId/blockouts/:blockoutId', deleteBlockout)

export default services
