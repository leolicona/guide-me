import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth'
import { requireRole } from '../../middleware/role'
import { ApiError } from '../../types/errors'
import type { AppVariables } from '../../types/context'
import {
  cancelBooking,
  claimReminder,
  confirmSale,
  getFolio,
  getPosService,
  listAgentFolios,
  listAvailabilityDays,
  listPosServices,
  reactivateBooking,
  settleBooking,
} from './handler'
import { getLodgingAvailability, getUnitCalendar } from './lodging.handler'
import { availabilityDaysQuerySchema, confirmSaleSchema } from './schema'

const pos = new Hono<{
  Bindings: CloudflareBindings
  Variables: AppVariables
}>()

const validationHook = (result: { success: boolean }) => {
  if (!result.success) {
    throw new ApiError('VALIDATION_ERROR', 400, 'Invalid request payload')
  }
}

// Selling is a daily activity for agents, admins AND affiliates (US-A31 / affiliate-portal D1):
// all three run the same POS flow, role-widened then filtered (the curated catalog + commission
// source differ for an affiliate; see the handler). Folios are attributed to the caller
// (agent_id = seller.userId) uniformly; an affiliate sale additionally stamps affiliate_company_id.
pos.use('*', authMiddleware, requireRole('agent', 'admin', 'affiliate'))

pos.get('/services', listPosServices)
// US-AG35 — month availability for the calendar Bottom Sheet (declared before the
// `/services/:id` param route is irrelevant — distinct path — but kept with the reads).
pos.get(
  '/availability/days',
  zValidator('query', availabilityDaysQuerySchema, validationHook),
  listAvailabilityDays,
)
pos.get('/services/:id', getPosService)
// Accommodation/lodging availability (US-AG36/AG37). Range-first units search + unit calendar.
pos.get('/lodging/:serviceId/availability', getLodgingAvailability)
pos.get('/lodging/units/:unitId/calendar', getUnitCalendar)
pos.post(
  '/folios',
  zValidator('json', confirmSaleSchema, validationHook),
  confirmSale,
)
pos.get('/folios', listAgentFolios)
pos.get('/folios/:id', getFolio)
// US-AG07 — one-shot settlement of a booking (collect the balance → paid + QR).
pos.post('/folios/:id/settle', settleBooking)
// US-AG07.4 — manual cancellation of a booking (release spots; deposit retained).
pos.post('/folios/:id/cancel', cancelBooking)
// US-AG07.3 — claim the WhatsApp reminder (atomic, prevents double-contact).
pos.post('/folios/:id/reminder', claimReminder)
// US-AG07.5 — reactivate an expired booking when capacity allows (reactivation only).
pos.post('/folios/:id/reactivate', reactivateBooking)

export default pos
