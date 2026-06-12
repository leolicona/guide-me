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
    // US-A12 (rev.) — the service's commission, earned by ANY seller
    // (docs/commissions/service-based-commission.spec.md). `percent` → commission_value in
    // basis points (1000 = 10%, 0–10000) of the line total; `fixed` → commission_value in
    // minor units PER SPOT. Optional → percent/0 (a service that pays no commission).
    commission_type: z.enum(['percent', 'fixed']).optional().default('percent'),
    commission_value: z.number().int().min(0).optional().default(0),
  })
  .refine((v) => v.minimum_price <= v.base_price, {
    message: 'minimum_price must be ≤ base_price',
    path: ['minimum_price'],
  })
  .refine((v) => v.commission_type !== 'percent' || v.commission_value <= 10000, {
    message: 'percent commission must be ≤ 10000 basis points (100%)',
    path: ['commission_value'],
  })
  // D3 — a fixed commission may never exceed the price floor, so commission can never exceed
  // the revenue of even a maximally-discounted pass (kills the discount-incentive trap).
  .refine((v) => v.commission_type !== 'fixed' || v.commission_value <= v.minimum_price, {
    message: 'fixed commission must be ≤ minimum_price',
    path: ['commission_value'],
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
