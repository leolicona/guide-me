import { z } from 'zod'

// US-A46 — admin edits the org's booking policy. All fields optional (a partial update);
// per Multitenancy Rule 1 the org id comes from context, never the body (Zod strips it).
export const updateOrganizationSchema = z.object({
  // Minimum deposit as a percent of the folio total (0–100; 0 = no minimum).
  booking_min_down_payment_pct: z.number().int().min(0).max(100).optional(),
  // Hold window in whole days before an unsettled booking auto-cancels (≥ 1).
  booking_hold_days: z.number().int().min(1).optional(),
  // US-A47 — SIGNED departure offsets in minutes (+ before / − after departure), ±4h bound.
  // salesCutoff closes new walk-in sales; bookingGrace times the unsettled same-day auto-cancel.
  sales_cutoff_offset_minutes: z.number().int().min(-240).max(240).optional(),
  booking_grace_offset_minutes: z.number().int().min(-240).max(240).optional(),
  // Lodging settings (docs/lodging/accommodation-stays.spec.md §2.5). Weekend days as ISO
  // weekday ints (0=Sun … 6=Sat), distinct; free-cancel window in days; penalty percent.
  lodging_weekend_days: z
    .array(z.number().int().min(0).max(6))
    .refine((a) => new Set(a).size === a.length, 'weekday values must be distinct')
    .optional(),
  lodging_free_cancel_days: z.number().int().min(0).optional(),
  lodging_cancel_penalty_pct: z.number().int().min(0).max(100).optional(),
})

export type UpdateOrganizationInput = z.infer<typeof updateOrganizationSchema>
