import type { Context } from 'hono'
import { eq } from 'drizzle-orm'
import { getDb } from '../../db/client'
import { organizations } from '../../db/schema'
import { ApiError } from '../../types/errors'
import type { AppVariables } from '../../types/context'
import type { UpdateOrganizationInput } from './schema'
import { parseCancellationPolicy } from '../../utils/cancellationPolicy'
import { bookingExpiryEpoch } from '../pos/handler'

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
  salesCutoffOffsetMinutes: organizations.salesCutoffOffsetMinutes,
  bookingGraceOffsetMinutes: organizations.bookingGraceOffsetMinutes,
  bookingPreDepartureBufferHours: organizations.bookingPreDepartureBufferHours,
  bookingCreationCutoffHours: organizations.bookingCreationCutoffHours,
  noShowMarginMinutes: organizations.noShowMarginMinutes,
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
  salesCutoffOffsetMinutes: number
  bookingGraceOffsetMinutes: number
  bookingPreDepartureBufferHours: number
  bookingCreationCutoffHours: number
  noShowMarginMinutes: number
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
  sales_cutoff_offset_minutes: o.salesCutoffOffsetMinutes,
  booking_grace_offset_minutes: o.bookingGraceOffsetMinutes,
  booking_pre_departure_buffer_hours: o.bookingPreDepartureBufferHours,
  booking_creation_cutoff_hours: o.bookingCreationCutoffHours,
  no_show_margin_minutes: o.noShowMarginMinutes,
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
  if (input.sales_cutoff_offset_minutes !== undefined)
    updates.salesCutoffOffsetMinutes = input.sales_cutoff_offset_minutes
  if (input.booking_grace_offset_minutes !== undefined)
    updates.bookingGraceOffsetMinutes = input.booking_grace_offset_minutes
  if (input.booking_pre_departure_buffer_hours !== undefined)
    updates.bookingPreDepartureBufferHours = input.booking_pre_departure_buffer_hours
  if (input.booking_creation_cutoff_hours !== undefined)
    updates.bookingCreationCutoffHours = input.booking_creation_cutoff_hours

  // US-A77 (S1), corrected by BUG-029 — the apartado windows have to stay coherent, and the check
  // needs the STORED value of whichever field this request did not send.
  //
  // The rule this replaces was `cutoff >= buffer`, on the reasoning that an apartado created inside
  // its own settle window is born owing money it has no time to pay. That ignored the GRACE stage,
  // which `apartado-stages.spec.md` S2 documents as a legitimate birthplace: *"sales made close to
  // departure are BORN here"*. It was wrong at both ends —
  //
  //   · it forbade the only useful configurations ("no apartados inside 2 hours" → 400), and
  //   · at its own boundary `cutoff == buffer` it ACCEPTED an apartado born with zero life:
  //     `nearDeparture` is `distance < buffer`, so at exactly the buffer the FAR branch applies and
  //     the expiry lands on the instant of sale.
  //
  // The rule now asks the real function what an apartado created at the tightest legal moment would
  // get, and requires it to be alive. Same arithmetic as production, so it cannot drift from it.
  if (
    input.booking_creation_cutoff_hours !== undefined ||
    input.booking_pre_departure_buffer_hours !== undefined ||
    input.booking_grace_offset_minutes !== undefined
  ) {
    const [stored] = await db
      .select({
        cutoff: organizations.bookingCreationCutoffHours,
        buffer: organizations.bookingPreDepartureBufferHours,
        grace: organizations.bookingGraceOffsetMinutes,
      })
      .from(organizations)
      .where(eq(organizations.id, user.organizationId))
      .limit(1)

    const cutoff = input.booking_creation_cutoff_hours ?? stored?.cutoff ?? 0
    const buffer = input.booking_pre_departure_buffer_hours ?? stored?.buffer ?? 24
    const grace = input.booking_grace_offset_minutes ?? stored?.grace ?? 15

    // `0` means "no restriction", so there is no tightest legal moment to evaluate — and nothing a
    // settings rule can promise. The sale-time guard in `confirmSale` is what covers that case.
    if (cutoff > 0) {
      const departure = 0
      const createdAt = -cutoff * 3_600
      const expiry = bookingExpiryEpoch(
        { preDepartureBufferHours: buffer, bookingGraceOffsetMinutes: grace },
        createdAt,
        departure,
      )
      if (expiry <= createdAt) {
        throw new ApiError(
          'VALIDATION_ERROR',
          400,
          `Con estos valores un apartado creado en el límite (${cutoff} h antes de la salida) nacería ya vencido. ` +
            `Sube el límite para crear apartados, o baja el plazo para pagar el saldo (${buffer} h).`,
        )
      }
    }
  }
  // US-A85 (D23) — the no-show margin may not mark a customer absent while their seat is still on
  // sale. An org that keeps selling 30 minutes past departure and calls people no-shows at the
  // departure instant would be declaring someone absent BEFORE it sold them their ticket. Both are
  // signed the same way (+ before / − after), so "still sellable" is simply the LOWER number.
  if (
    input.no_show_margin_minutes !== undefined ||
    input.sales_cutoff_offset_minutes !== undefined
  ) {
    const [stored] = await db
      .select({
        margin: organizations.noShowMarginMinutes,
        cutoff: organizations.salesCutoffOffsetMinutes,
      })
      .from(organizations)
      .where(eq(organizations.id, user.organizationId))
      .limit(1)

    const margin = input.no_show_margin_minutes ?? stored?.margin ?? 0
    const cutoff = input.sales_cutoff_offset_minutes ?? stored?.cutoff ?? 0
    if (margin > cutoff) {
      throw new ApiError(
        'NO_SHOW_MARGIN_TOO_EARLY',
        422,
        'El margen de no-show no puede marcar a un cliente como ausente mientras su lugar todavía está a la venta.',
      )
    }
  }
  if (input.no_show_margin_minutes !== undefined)
    updates.noShowMarginMinutes = input.no_show_margin_minutes
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
