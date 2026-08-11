import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth'
import { requireRole } from '../../middleware/role'
import { ApiError } from '../../types/errors'
import type { AppVariables } from '../../types/context'
import {
  approveCancellationRequest,
  cancelFolio,
  cancelFolioLine,
  confirmRefund,
  getFolioDetail,
  listCancellationRequests,
  listFolioCounts,
  listFolios,
  markTicketsSentAdmin,
  rejectCancellationRequest,
} from './handler'
import {
  cancelFolioSchema,
  confirmRefundSchema,
  rejectCancellationRequestSchema,
} from './schema'

const foliosRouter = new Hono<{
  Bindings: CloudflareBindings
  Variables: AppVariables
}>()

const validationHook = (result: { success: boolean }) => {
  if (!result.success) {
    throw new ApiError('VALIDATION_ERROR', 400, 'Invalid request payload')
  }
}

// US-A21 — admin-only folio management (browse + total cancellation). The agent receipt
// read stays at GET /api/pos/folios/:id (agent-scoped) and is untouched.
foliosRouter.use('*', authMiddleware, requireRole('admin'))

foliosRouter.get('/', listFolios)

// US-A84 — the pending-work counts, as one aggregate. Literal, so it is registered before /:id.
foliosRouter.get('/counts', listFolioCounts)

// US-T04 — tourist cancellation requests (review queue + approve/reject). Literal routes
// registered BEFORE /:id so the param route can never shadow them.
foliosRouter.get('/requests', listCancellationRequests)
foliosRouter.post('/requests/:requestId/approve', approveCancellationRequest)
foliosRouter.post(
  '/requests/:requestId/reject',
  zValidator('json', rejectCancellationRequestSchema, validationHook),
  rejectCancellationRequest,
)

foliosRouter.get('/:id', getFolioDetail)
foliosRouter.post(
  '/:id/cancel',
  zValidator('json', cancelFolioSchema, validationHook),
  cancelFolio,
)
// US-A22 (line-autonomy F2) — cancel ONE line; the siblings come out byte-identical. Same body
// contract as the total cancel: reason only, money always derived (the ladder decides).
foliosRouter.post(
  '/:id/lines/:lineId/cancel',
  zValidator('json', cancelFolioSchema, validationHook),
  cancelFolioLine,
)
// US-A23 / US-T05 — confirm the physical cash refund (PIN or override).
foliosRouter.post(
  '/:id/refund/confirm',
  zValidator('json', confirmRefundSchema, validationHook),
  confirmRefund,
)
// whatsapp-qr-delivery — admin records the tickets were sent over WhatsApp (oversight re-send).
foliosRouter.post('/:id/ticket-delivery', markTicketsSentAdmin)

export default foliosRouter
