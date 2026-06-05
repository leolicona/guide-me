import { z } from 'zod'

// Money is stored and transported as integer minor units (centavos), never floats.
const money = z.number().int().min(0)

// No `organizationId` / `status` fields — Multitenancy Rule 1 (taken from
// context, never the body). Zod strips unknown keys, so an injected
// organizationId in the payload is silently dropped.
export const createServiceSchema = z
  .object({
    name: z.string().min(1, 'Name is required'),
    description: z.string().nullable().optional(),
    base_price: money,
    minimum_price: money,
    default_capacity: z.number().int().min(1),
    // US-A12 — per-service commission bonus (minor units, ≥ 0) added to the agent's base %
    // per pass sold. Optional → 0 (a service with no special bonus).
    commission_bonus: money.optional().default(0),
  })
  .refine((v) => v.minimum_price <= v.base_price, {
    message: 'minimum_price must be ≤ base_price',
    path: ['minimum_price'],
  })

// Same shape as create — PUT is a full replace.
export const updateServiceSchema = createServiceSchema

export const createExtraSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  price: money,
})

export const updateExtraSchema = createExtraSchema

export type CreateServiceInput = z.infer<typeof createServiceSchema>
export type UpdateServiceInput = z.infer<typeof updateServiceSchema>
export type CreateExtraInput = z.infer<typeof createExtraSchema>
export type UpdateExtraInput = z.infer<typeof updateExtraSchema>
