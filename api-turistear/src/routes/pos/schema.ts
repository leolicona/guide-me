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

// US-AG41 — the bank reference for an electronic (transfer) payment. Free text (bank confirmation
// numbers vary), trimmed, 4–64 chars. Required only when the method is 'transfer' (enforced by the
// refine below / the settle handler); absent for cash.
export const paymentReferenceSchema = z.string().trim().min(4).max(64)

// A tour/activity line — a slot + quantity + (discountable) unit price.
// US-A64 — `zone_id` targets a physical zone on a zoned service (required there, refused otherwise;
// enforced in the handler since it depends on the slot's service). A split party is one line per
// zone on the same slot.
const slotLineSchema = z.object({
  slot_id: z.string().min(1),
  zone_id: z.string().min(1).optional(),
  quantity: z.number().int().min(1),
  unit_price: z.number().int().min(0),
  extras: z.array(extraSchema).optional().default([]),
})

// US-AG36/AG38 (v2) — a lodging STAY line: `quantity` rooms of a unit type + date range + total
// guests (D12). No slot, no client price (the server re-quotes via the shared engine).
// Distinguished from a slot line by `unit_type_id`.
const stayLineSchema = z.object({
  unit_type_id: z.string().min(1),
  check_in: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD'),
  check_out: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD'),
  guests: z.number().int().min(1),
  quantity: z.number().int().min(1),
})

// A cart line is EITHER a stay (has unit_type_id) or a slot (has slot_id). union tries stay
// first; a slot line lacks unit_type_id so it falls through to the slot shape.
const lineSchema = z.union([stayLineSchema, slotLineSchema])

export const confirmSaleSchema = z
  .object({
    // D2 (whatsapp-qr-delivery) — every POS sale requires a name and a dialable phone: WhatsApp
    // is now the primary ticket-delivery channel (the agent sends the portal link). Uniform for
    // all roles, so it's enforced here in the schema (no per-role exemption).
    customer_name: z.string().trim().min(1, 'A customer name is required'),
    // Email drops to an OPTIONAL copy — valid only if present (no longer the required channel).
    customer_email: z.string().trim().email('A valid customer email is required').nullish(),
    // Dialable (≥ 10 digits after stripping formatting; mirrors the client's +52 normalizer floor).
    customer_phone: z
      .string()
      .trim()
      .refine((p) => p.replace(/\D/g, '').length >= 10, 'A dialable customer phone is required'),
    // US-AG25/AG29 — how the payment was collected. Defaults to 'cash' (the common case
    // and the pre-feature behaviour). Every non-cash method is electronic: it still earns
    // commission but adds no cash debt (US-AG24 path).
    payment_method: z.enum(['cash', 'card', 'transfer', 'link']).optional().default('cash'),
    // US-AG41 — the transfer's bank reference; required iff payment_method is 'transfer' (see the
    // refine below). Ignored for cash.
    payment_reference: paymentReferenceSchema.optional(),
    // US-AG07 — present ⇒ BOOKING (apartado) mode: the deposit in minor units. Absent ⇒ the
    // existing full paid sale (byte-unchanged). The bounds (0 < deposit < total and ≥ the org
    // minimum %) depend on the server-computed total + org policy, so they live in the handler,
    // not here (mirrors the discount floor). Booking mode also requires a dialable customer_phone.
    down_payment: z.number().int().min(1).optional(),
    lines: z.array(lineSchema).nonempty('Cart must have at least one line'),
  })
  // Business rule 6 — a slot may appear at most once (the UI merges quantities), keeping the
  // inventory decrement one-update-per-slot. US-A64: on a zoned service a split party puts the same
  // slot in different zones, so uniqueness is per (slot_id, zone_id) — the same zone twice is still
  // rejected. Stay lines are exempt (a unit can be booked for non-overlapping ranges in one cart).
  .refine(
    (v) => {
      const keys = v.lines
        .filter((l): l is { slot_id: string; zone_id?: string } => 'slot_id' in l)
        .map((l) => `${l.slot_id}:${l.zone_id ?? ''}`)
      return new Set(keys).size === keys.length
    },
    { message: 'Each slot (zone) may appear at most once', path: ['lines'] },
  )
  // US-AG41 — a transfer payment must carry its bank reference (WhatsApp/QR is held until an admin
  // verifies it against this reference; US-A67).
  .refine((v) => v.payment_method !== 'transfer' || !!v.payment_reference, {
    message: 'A payment reference is required for a bank transfer',
    path: ['payment_reference'],
  })

export type ConfirmSaleInput = z.infer<typeof confirmSaleSchema>

// US-AG41 — settle body: collecting a booking's balance. The settle re-uses the folio's own payment
// method; when that method is 'transfer' the agent records the settling transfer's reference (the
// handler enforces the required-when-transfer rule, since only it knows the folio's method).
export const settleSchema = z.object({
  payment_reference: paymentReferenceSchema.optional(),
})

export type SettleInput = z.infer<typeof settleSchema>

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
