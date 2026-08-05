import { Hono } from 'hono'
import { authMiddleware } from '../../middleware/auth'
import { requireRole } from '../../middleware/role'
import type { AppVariables } from '../../types/context'
import { listNotifications, markNotificationSent } from './handler'

// US-A86 / US-AG51 — the notification outbox.
// Spec: docs/folios/folio-state-machine.spec.md.
//
// Two routes and no more, because the outbox needs no screen for the seller (D13): an action-tail
// leaves with the tap that caused it, and clock-produced work reaches a seller as a rung on their
// card's single suggested action. The LIST is the admin's oversight surface; the DRAIN is the tap
// that records a WhatsApp actually being sent.
const notifications = new Hono<{
  Bindings: CloudflareBindings
  Variables: AppVariables
}>()

notifications.use('*', authMiddleware)

// Admin-only: the whole org's outbox is an oversight view.
notifications.get('/', requireRole('admin'), listNotifications)

// The folio's agent OR an admin may drain a WhatsApp row — whoever actually opened the composer.
notifications.post('/:id/sent', markNotificationSent)

export default notifications
