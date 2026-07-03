import { z } from 'zod'
import { SERVICE_CATEGORIES } from '../services/schema'

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

// A tour/activity line — a slot + quantity + (discountable) unit price.
const slotLineSchema = z.object({
  slot_id: z.string().min(1),
  quantity: z.number().int().min(1),
  unit_price: z.number().int().min(0),
  extras: z.array(extraSchema).optional().default([]),
})

// US-AG36/AG38 — a lodging STAY line: a unit + date range + guests. No slot, no client price
// (the server re-quotes via the shared engine). Distinguished from a slot line by `unit_id`.
const stayLineSchema = z.object({
  unit_id: z.string().min(1),
  check_in: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD'),
  check_out: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD'),
  guests: z.number().int().min(1),
})

// A cart line is EITHER a stay (has unit_id) or a slot (has slot_id). union tries stay first;
// a slot line lacks unit_id so it falls through to the slot shape.
const lineSchema = z.union([stayLineSchema, slotLineSchema])

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
  // Business rule 6 — a slot may appear at most once (the UI merges quantities). This keeps the
  // inventory decrement one-update-per-slot. Only applies to slot lines; stay lines are exempt
  // (the same unit can be booked for non-overlapping ranges in one cart).
  .refine(
    (v) => {
      const slotIds = v.lines
        .filter((l): l is { slot_id: string } => 'slot_id' in l)
        .map((l) => l.slot_id)
      return new Set(slotIds).size === slotIds.length
    },
    { message: 'Each slot may appear at most once', path: ['lines'] },
  )

export type ConfirmSaleInput = z.infer<typeof confirmSaleSchema>

// US-AG35 — month-availability query for the POS calendar Bottom Sheet. The caller names
// a MONTH (not a free from/to range): the server derives the scan window itself, so there
// is no caller-controlled width to bound. `month` must be a real calendar month (01–12);
// `today` is the optional org-local anchor (past days are never returned). Validated via
// `zValidator('query', …)` → 400 on a malformed value.
//
// `categories` (optional CSV of US-A37 category keys) scopes the availability dots to the
// agent's selected category filter: only slots of a service in that set count. Unknown
// keys are dropped; an empty/absent value means "all categories" (the default). Lodging
// has no slots, so it never contributes a dot here regardless of selection.
export const availabilityDaysQuerySchema = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Expected YYYY-MM'),
  today: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
    .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), 'Invalid calendar date')
    .optional(),
  categories: z
    .string()
    .optional()
    .transform((s) =>
      s
        ? (s
            .split(',')
            .filter((k): k is (typeof SERVICE_CATEGORIES)[number] =>
              (SERVICE_CATEGORIES as readonly string[]).includes(k),
            ) as (typeof SERVICE_CATEGORIES)[number][])
        : undefined,
    )
    .transform((arr) => (arr && arr.length > 0 ? arr : undefined)),
})

export type AvailabilityDaysQuery = z.infer<typeof availabilityDaysQuerySchema>
