import type { Context } from 'hono'
import { eq } from 'drizzle-orm'
import { getDb } from '../../db/client'
import { organizations } from '../../db/schema'
import { ApiError } from '../../types/errors'
import type { AppVariables } from '../../types/context'
import type { UpdateOrganizationInput } from './schema'
import { parseCancellationPolicy } from '../../utils/cancellationPolicy'

type OrganizationsContext = Context<{
  Bindings: CloudflareBindings
  Variables: AppVariables
}>

// Org read shape — id + name + the booking policy (US-A46), so the admin settings screen and the
// adaptive-checkout deposit chip (US-AG07.2) can read the minimum % without a separate call.
const orgColumns = {
  id: organizations.id,
  name: organizations.name,
  bookingMinDownPaymentPct: organizations.bookingMinDownPaymentPct,
  bookingHoldDays: organizations.bookingHoldDays,
  salesCutoffOffsetMinutes: organizations.salesCutoffOffsetMinutes,
  bookingGraceOffsetMinutes: organizations.bookingGraceOffsetMinutes,
  bookingPreDepartureBufferHours: organizations.bookingPreDepartureBufferHours,
  bookingCreationCutoffHours: organizations.bookingCreationCutoffHours,
  lodgingWeekendDays: organizations.lodgingWeekendDays,
  lodgingFreeCancelDays: organizations.lodgingFreeCancelDays,
  lodgingCancelPenaltyPct: organizations.lodgingCancelPenaltyPct,
  waTicketTemplate: organizations.waTicketTemplate,
  waReminderTemplate: organizations.waReminderTemplate,
  timezone: organizations.timezone,
  cancellationPolicy: organizations.cancellationPolicy,
  agentCancellationEnabled: organizations.agentCancellationEnabled,
  qrRedemptionMode: organizations.qrRedemptionMode,
} as const

const serializeOrg = (o: {
  id: string
  name: string
  bookingMinDownPaymentPct: number
  bookingHoldDays: number
  salesCutoffOffsetMinutes: number
  bookingGraceOffsetMinutes: number
  bookingPreDepartureBufferHours: number
  bookingCreationCutoffHours: number
  lodgingWeekendDays: string
  lodgingFreeCancelDays: number
  lodgingCancelPenaltyPct: number
  waTicketTemplate: string | null
  waReminderTemplate: string | null
  timezone: string
  cancellationPolicy: string | null
  agentCancellationEnabled: boolean
  qrRedemptionMode: 'per_pass' | 'all_passes'
}) => ({
  id: o.id,
  name: o.name,
  booking_min_down_payment_pct: o.bookingMinDownPaymentPct,
  booking_hold_days: o.bookingHoldDays,
  sales_cutoff_offset_minutes: o.salesCutoffOffsetMinutes,
  booking_grace_offset_minutes: o.bookingGraceOffsetMinutes,
  booking_pre_departure_buffer_hours: o.bookingPreDepartureBufferHours,
  booking_creation_cutoff_hours: o.bookingCreationCutoffHours,
  lodging_weekend_days: o.lodgingWeekendDays
    ? o.lodgingWeekendDays.split(',').map(Number)
    : [],
  lodging_free_cancel_days: o.lodgingFreeCancelDays,
  lodging_cancel_penalty_pct: o.lodgingCancelPenaltyPct,
  // WhatsApp templates (whatsapp-qr-delivery D10) — null ⇒ the client uses the shipped default.
  wa_ticket_template: o.waTicketTemplate,
  wa_reminder_template: o.waReminderTemplate,
  // US-A66 — the org's IANA time zone (the client anchors "today" + audit-time display to it).
  timezone: o.timezone,
  // The cancellation ladder as an OBJECT (it is stored as a JSON string). `null` means no policy
  // is configured, which is what puts every cancellation path on its pre-feature behaviour (D1) —
  // the settings screen reads this to decide between "configure a policy" and "edit the ladder".
  // Parsed rather than passed through raw so a corrupted row can never reach the client as junk.
  cancellation_policy: parseCancellationPolicy(o.cancellationPolicy),
  agent_cancellation_enabled: o.agentCancellationEnabled,
  // US-A81 (docs/scanner/group-redemption.spec.md) — how a scan consumes a ticket's passes.
  qr_redemption_mode: o.qrRedemptionMode,
})

export const getMyOrganization = async (c: OrganizationsContext) => {
  const user = c.get('user')
  const db = getDb(c.env)

  const result = await db
    .select(orgColumns)
    .from(organizations)
    .where(eq(organizations.id, user.organizationId))
    .limit(1)

  const org = result[0]
  if (!org) {
    // Unreachable in normal operation: users.organization_id is a NOT NULL
    // foreign key, so the org always exists. Its absence is an invariant
    // violation, not a client error.
    throw new ApiError('INTERNAL_ERROR', 500, 'Organization not found')
  }

  return c.json({ organization: serializeOrg(org) })
}

// US-A46 — admin updates the org booking policy. Org-scoped (the id comes from context); takes
// effect for NEW bookings only (existing bookings keep their snapshotted expiry).
export const updateMyOrganization = async (c: OrganizationsContext) => {
  const user = c.get('user')
  const db = getDb(c.env)
  const input = c.req.valid('json' as never) as UpdateOrganizationInput

  const updates: Record<string, unknown> = { updatedAt: new Date() }
  if (input.booking_min_down_payment_pct !== undefined)
    updates.bookingMinDownPaymentPct = input.booking_min_down_payment_pct
  if (input.booking_hold_days !== undefined)
    updates.bookingHoldDays = input.booking_hold_days
  if (input.sales_cutoff_offset_minutes !== undefined)
    updates.salesCutoffOffsetMinutes = input.sales_cutoff_offset_minutes
  if (input.booking_grace_offset_minutes !== undefined)
    updates.bookingGraceOffsetMinutes = input.booking_grace_offset_minutes
  if (input.booking_pre_departure_buffer_hours !== undefined)
    updates.bookingPreDepartureBufferHours = input.booking_pre_departure_buffer_hours
  if (input.booking_creation_cutoff_hours !== undefined)
    updates.bookingCreationCutoffHours = input.booking_creation_cutoff_hours

  // US-A77 (S1) — the two apartado windows have to stay coherent, and the check needs the STORED
  // value of whichever field this request did not send. A PATCH that raises the settle deadline
  // above an existing creation cutoff is just as incoherent as one that lowers the cutoff below the
  // deadline, so both directions are checked against the merged result rather than the body alone.
  //
  // An apartado created inside its own settle window is born owing money it has no time to pay:
  // that is the shape that produced the one-minute apartado.
  if (
    input.booking_creation_cutoff_hours !== undefined ||
    input.booking_pre_departure_buffer_hours !== undefined
  ) {
    const [stored] = await db
      .select({
        cutoff: organizations.bookingCreationCutoffHours,
        buffer: organizations.bookingPreDepartureBufferHours,
      })
      .from(organizations)
      .where(eq(organizations.id, user.organizationId))
      .limit(1)

    const cutoff = input.booking_creation_cutoff_hours ?? stored?.cutoff ?? 0
    const buffer = input.booking_pre_departure_buffer_hours ?? stored?.buffer ?? 24
    // 0 means "no restriction", which is coherent with any deadline.
    if (cutoff !== 0 && cutoff < buffer) {
      throw new ApiError(
        'VALIDATION_ERROR',
        400,
        `El límite para crear apartados (${cutoff} h) no puede ser menor que el plazo para pagar el saldo (${buffer} h).`,
      )
    }
  }
  if (input.lodging_weekend_days !== undefined)
    updates.lodgingWeekendDays = input.lodging_weekend_days.join(',')
  if (input.lodging_free_cancel_days !== undefined)
    updates.lodgingFreeCancelDays = input.lodging_free_cancel_days
  if (input.lodging_cancel_penalty_pct !== undefined)
    updates.lodgingCancelPenaltyPct = input.lodging_cancel_penalty_pct
  // whatsapp-qr-delivery D10 — null resets to the shipped default; a string was {portal_link}-checked.
  if (input.wa_ticket_template !== undefined)
    updates.waTicketTemplate = input.wa_ticket_template
  if (input.wa_reminder_template !== undefined)
    updates.waReminderTemplate = input.wa_reminder_template
  // US-A66 — the org's IANA time zone (Zod-validated against the curated allow-list).
  if (input.timezone !== undefined) updates.timezone = input.timezone
  // US-A69/A70/A72 — the cancellation ladder, stored as JSON. Zod has already validated the whole
  // document, so what lands in the column is always evaluable. `null` clears it and returns every
  // cancellation path to its pre-feature behaviour (D1).
  if (input.cancellation_policy !== undefined)
    updates.cancellationPolicy = input.cancellation_policy
      ? JSON.stringify(input.cancellation_policy)
      : null
  if (input.agent_cancellation_enabled !== undefined)
    updates.agentCancellationEnabled = input.agent_cancellation_enabled
  // US-A81 — the scan-consumption mode (group-redemption D1); enum-validated in the schema.
  if (input.qr_redemption_mode !== undefined)
    updates.qrRedemptionMode = input.qr_redemption_mode

  await db
    .update(organizations)
    .set(updates)
    .where(eq(organizations.id, user.organizationId))

  const result = await db
    .select(orgColumns)
    .from(organizations)
    .where(eq(organizations.id, user.organizationId))
    .limit(1)

  return c.json({ organization: serializeOrg(result[0]!) })
}
