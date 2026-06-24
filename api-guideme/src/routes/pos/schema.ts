import { z } from 'zod'

// Cart confirm payload. Money is integer minor units (centavos). Per Multitenancy
// Rule 1, no `organizationId` / `agent_id` / `status` / totals fields — those come
// from context or are computed server-side; Zod strips unknown keys. `service_id`
// is intentionally NOT accepted: it is derived from the slot at confirm time.
//
// `unit_price`'s discount floor depends on the service's snapshot `minimum_price`
// read from the DB, so it is enforced in the handler, not here (see business rule 1).

const extraSchema = z.object({
  extra_id: z.string().min(1),
  quantity: z.number().int().min(1),
})

const lineSchema = z.object({
  slot_id: z.string().min(1),
  quantity: z.number().int().min(1),
  unit_price: z.number().int().min(0),
  extras: z.array(extraSchema).optional().default([]),
})

export const confirmSaleSchema = z
  .object({
    customer_name: z.string().nullable().optional(),
    // For an agent/admin sale, customer_email is the only ticket-delivery channel and is
    // REQUIRED — enforced in the handler (it can't be enforced here because an affiliate sale
    // delivers to the affiliate's own account email, so the field is optional for that role;
    // affiliate-portal.spec.md D8). When present it must be a valid address either way.
    customer_email: z.string().trim().email('A valid customer email is required').nullish(),
    // Phone stays optional metadata (no delivery dependency on it yet).
    customer_phone: z.string().nullable().optional(),
    // US-AG25/AG29 — how the payment was collected. Defaults to 'cash' (the common case
    // and the pre-feature behaviour). Every non-cash method is electronic: it still earns
    // commission but adds no cash debt (US-AG24 path).
    payment_method: z.enum(['cash', 'card', 'transfer', 'link']).optional().default('cash'),
    // US-AG07 — present ⇒ BOOKING (apartado) mode: the deposit in minor units. Absent ⇒ the
    // existing full paid sale (byte-unchanged). The bounds (0 < deposit < total and ≥ the org
    // minimum %) depend on the server-computed total + org policy, so they live in the handler,
    // not here (mirrors the discount floor). Booking mode also requires a dialable customer_phone.
    down_payment: z.number().int().min(1).optional(),
    lines: z.array(lineSchema).nonempty('Cart must have at least one line'),
  })
  // Business rule 6 — a slot may appear at most once (the UI merges quantities). This
  // keeps the inventory decrement one-update-per-slot and avoids intra-cart self-contention.
  .refine((v) => new Set(v.lines.map((l) => l.slot_id)).size === v.lines.length, {
    message: 'Each slot may appear at most once',
    path: ['lines'],
  })

export type ConfirmSaleInput = z.infer<typeof confirmSaleSchema>

// US-AG35 — month-availability query for the POS calendar Bottom Sheet. The caller names
// a MONTH (not a free from/to range): the server derives the scan window itself, so there
// is no caller-controlled width to bound. `month` must be a real calendar month (01–12);
// `today` is the optional org-local anchor (past days are never returned). Validated via
// `zValidator('query', …)` → 400 on a malformed value.
export const availabilityDaysQuerySchema = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Expected YYYY-MM'),
  today: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
    .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), 'Invalid calendar date')
    .optional(),
})

export type AvailabilityDaysQuery = z.infer<typeof availabilityDaysQuerySchema>
