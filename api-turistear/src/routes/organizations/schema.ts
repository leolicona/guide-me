import { z } from 'zod'
import { cancellationPolicySchema } from '../../utils/cancellationPolicy'

// US-A66 (docs/timezone/timezone.spec.md — D3/D5) — the curated set of IANA zones an admin may pick, one
// human label per mainland-Mexico offset. IANA (not a raw offset) so DST + multi-zone resolve
// automatically — incl. the northern border strip that still observes US DST. The FIRST entry is
// the app-wide default (D4). If non-Mexico operators ever onboard, widen this to a searchable list.
export const ORG_TIMEZONES = [
  'America/Mexico_City',
  'America/Cancun',
  'America/Hermosillo',
  'America/Mazatlan',
  'America/Tijuana',
] as const
export type OrgTimezone = (typeof ORG_TIMEZONES)[number]

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
  // US-AG07.1 — pre-departure buffer (hours): a deposit-hold must be settled at least this long
  // before departure; within this window of departure the tighter grace applies. 0–168h (0–7 days).
  booking_pre_departure_buffer_hours: z.number().int().min(0).max(168).optional(),
  // US-A77 — how close to departure an APARTADO may still be created, in hours. 0 = no restriction.
  // The coherence rule (`>= booking_pre_departure_buffer_hours` when set) is enforced below, where
  // both values are in scope.
  booking_creation_cutoff_hours: z.number().int().min(0).max(720).optional(),
  // Lodging settings (docs/lodging/accommodation-stays.spec.md §2.5). Weekend days as ISO
  // weekday ints (0=Sun … 6=Sat), distinct; free-cancel window in days; penalty percent.
  lodging_weekend_days: z
    .array(z.number().int().min(0).max(6))
    .refine((a) => new Set(a).size === a.length, 'weekday values must be distinct')
    .optional(),
  lodging_free_cancel_days: z.number().int().min(0).optional(),
  lodging_cancel_penalty_pct: z.number().int().min(0).max(100).optional(),
  // WhatsApp message templates (whatsapp-qr-delivery D10). `null` resets to the shipped default.
  // The ticket template MUST contain {portal_link} — without it the tourist can't reach their QR.
  wa_ticket_template: z
    .string()
    .trim()
    .max(2000)
    .refine((t) => t.includes('{portal_link}'), 'The template must include {portal_link}')
    .nullable()
    .optional(),
  wa_reminder_template: z.string().trim().max(2000).nullable().optional(),
  // US-A66 — the org's IANA time zone; must be one of the curated allow-list.
  timezone: z.enum(ORG_TIMEZONES).optional(),
  // US-A69/A70/A72 — the cancellation refund ladder
  // (docs/cancellation/cancellation-policy-engine.spec.md). Validated as a whole document, so a
  // stored policy is always evaluable. `null` CLEARS it, which returns the org to the pre-feature
  // cancellation behaviour (D1) — that is the rollback, and the only way back.
  cancellation_policy: cancellationPolicySchema.nullable().optional(),
  // US-A73 (D14) — may an agent cancel their own current-shift sale? A single org-level switch;
  // per-agent grants are a permissions system, not this.
  agent_cancellation_enabled: z.boolean().optional(),
  // US-A79 (docs/scanner/group-redemption.spec.md, D1/D7) — how a scan consumes a ticket's
  // passes. Admin-only, org-wide, deliberately NOT an agent-facing toggle: a mis-tap would burn a
  // whole party's passes and nothing in the system can un-redeem one.
  qr_redemption_mode: z.enum(['per_pass', 'all_passes']).optional(),
})

export type UpdateOrganizationInput = z.infer<typeof updateOrganizationSchema>
