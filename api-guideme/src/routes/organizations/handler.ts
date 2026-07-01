import type { Context } from 'hono'
import { eq } from 'drizzle-orm'
import { getDb } from '../../db/client'
import { organizations } from '../../db/schema'
import { ApiError } from '../../types/errors'
import type { AppVariables } from '../../types/context'
import type { UpdateOrganizationInput } from './schema'

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
  lodgingWeekendDays: organizations.lodgingWeekendDays,
  lodgingFreeCancelDays: organizations.lodgingFreeCancelDays,
  lodgingCancelPenaltyPct: organizations.lodgingCancelPenaltyPct,
} as const

const serializeOrg = (o: {
  id: string
  name: string
  bookingMinDownPaymentPct: number
  bookingHoldDays: number
  salesCutoffOffsetMinutes: number
  bookingGraceOffsetMinutes: number
  lodgingWeekendDays: string
  lodgingFreeCancelDays: number
  lodgingCancelPenaltyPct: number
}) => ({
  id: o.id,
  name: o.name,
  booking_min_down_payment_pct: o.bookingMinDownPaymentPct,
  booking_hold_days: o.bookingHoldDays,
  sales_cutoff_offset_minutes: o.salesCutoffOffsetMinutes,
  booking_grace_offset_minutes: o.bookingGraceOffsetMinutes,
  lodging_weekend_days: o.lodgingWeekendDays
    ? o.lodgingWeekendDays.split(',').map(Number)
    : [],
  lodging_free_cancel_days: o.lodgingFreeCancelDays,
  lodging_cancel_penalty_pct: o.lodgingCancelPenaltyPct,
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
  if (input.lodging_weekend_days !== undefined)
    updates.lodgingWeekendDays = input.lodging_weekend_days.join(',')
  if (input.lodging_free_cancel_days !== undefined)
    updates.lodgingFreeCancelDays = input.lodging_free_cancel_days
  if (input.lodging_cancel_penalty_pct !== undefined)
    updates.lodgingCancelPenaltyPct = input.lodging_cancel_penalty_pct

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
