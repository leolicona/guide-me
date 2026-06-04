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
    // Email/phone validation (format, deliverability) is the Email-delivery feature's
    // concern; POS captures them as optional metadata.
    customer_email: z.string().nullable().optional(),
    customer_phone: z.string().nullable().optional(),
    lines: z.array(lineSchema).nonempty('Cart must have at least one line'),
  })
  // Business rule 6 — a slot may appear at most once (the UI merges quantities). This
  // keeps the inventory decrement one-update-per-slot and avoids intra-cart self-contention.
  .refine((v) => new Set(v.lines.map((l) => l.slot_id)).size === v.lines.length, {
    message: 'Each slot may appear at most once',
    path: ['lines'],
  })

export type ConfirmSaleInput = z.infer<typeof confirmSaleSchema>
