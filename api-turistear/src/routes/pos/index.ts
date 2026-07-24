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
  markTicketsSent,
  reactivateBooking,
  rejectPayment,
  settleBooking,
  verifyPayment,
} from './handler'
import { getLodgingAvailability, getUnitTypeCalendar } from './lodging.handler'
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
// Accommodation/lodging availability (US-AG36/AG37, v2). Range-first type search + the type's
// remaining-count calendar. Literal `unit-types` path declared before the `:serviceId` param route.
pos.get('/lodging/unit-types/:typeId/calendar', getUnitTypeCalendar)
pos.get('/lodging/:serviceId/availability', getLodgingAvailability)
pos.post(
  '/folios',
  zValidator('json', confirmSaleSchema, validationHook),
  confirmSale,
)
pos.get('/folios', listAgentFolios)
pos.get('/folios/:id', getFolio)
// US-AG07 — one-shot settlement of a booking (collect the balance → paid + QR). US-AG41: a transfer
// settle carries its reference and defers the QR to admin verification. The body is optional (a cash
// settle sends none), so it is parsed/validated inside the handler rather than via zValidator.
pos.post('/folios/:id/settle', settleBooking)
// US-A67 — ADMIN verifies / rejects an electronic (transfer) payment. Verify releases the tickets
// (signs QR + auto-emails); reject voids the folio (releases spots + commission clawback).
pos.post('/folios/:id/verify', requireRole('admin'), verifyPayment)
pos.post('/folios/:id/reject', requireRole('admin'), rejectPayment)
// US-AG07.4 — manual cancellation of a booking (release spots; deposit retained).
pos.post('/folios/:id/cancel', cancelBooking)
// US-AG07.3 — claim the WhatsApp reminder (atomic, prevents double-contact).
pos.post('/folios/:id/reminder', claimReminder)
// US-AG07.5 — reactivate an expired booking when capacity allows (reactivation only).
pos.post('/folios/:id/reactivate', reactivateBooking)
// whatsapp-qr-delivery — the seller records they sent the tickets over WhatsApp (clears Pendiente).
pos.post('/folios/:id/ticket-delivery', markTicketsSent)

export default pos
