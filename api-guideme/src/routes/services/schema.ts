import { z } from 'zod'

// Money is stored and transported as integer minor units (centavos), never floats.
const money = z.number().int().min(0)

// US-A36 — the largest overbooking tolerance (%) a Soft Cap service may set. The spec makes
// this admin-configurable per org via a settings panel; until that lands it is a hardcoded
// ceiling shared by validation and (eventually) the catalog form.
// TODO(US-A36): defer to an org setting — add an org-settings PUT endpoint +
// organizations.flex_cap_max_pct column and read it per-caller instead of this constant.
export const FLEX_CAP_MAX_PCT = 30

// US-A37 — a service's primary category (docs/catalog/service-categories.spec.md). A closed
// enum of stable lowercase keys; the frontend owns the localized (Spanish) labels. Required
// on every create/edit — the column is nullable only to absorb pre-migration rows.
export const SERVICE_CATEGORIES = [
  'lodging',
  'tours',
  'dining',
  'adventure',
  'culture',
] as const

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
    // US-A36 — capacity mode. Hard Cap (default, strict) vs Soft Cap (controlled overbooking).
    // For Hard Cap, flex_capacity_pct is 0 (any value is coerced to 0 by the refine below).
    // For Soft Cap, flex_capacity_pct must be 1..FLEX_CAP_MAX_PCT (empty/0 blocks the save).
    is_flexible: z.boolean().optional().default(false),
    flex_capacity_pct: z.number().int().min(0).max(FLEX_CAP_MAX_PCT).optional().default(0),
    // US-A37 — required primary category. Missing / empty / unknown → 400 VALIDATION_ERROR
    // (the form mirrors this; the column is nullable only for pre-migration rows).
    category: z.enum(SERVICE_CATEGORIES, { message: 'Please select a category' }),
  })
  .refine((v) => v.minimum_price <= v.base_price, {
    message: 'minimum_price must be ≤ base_price',
    path: ['minimum_price'],
  })
  // US-A36 — a Soft Cap service must allow at least one extra place (1..FLEX_CAP_MAX_PCT);
  // an empty/0 tolerance with Flexible selected is rejected (the spec's save-block rule).
  .refine((v) => !v.is_flexible || v.flex_capacity_pct >= 1, {
    message: `Soft Cap requires an extra-places tolerance of 1–${FLEX_CAP_MAX_PCT}%`,
    path: ['flex_capacity_pct'],
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
