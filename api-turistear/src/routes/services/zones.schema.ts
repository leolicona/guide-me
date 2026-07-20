import { z } from 'zod'

// Zoned Capacity (US-A64 — docs/catalog/zoned-capacity.spec.md). No `organizationId` / `status`
// fields — Multitenancy Rule 1 (from context, never the body). Zod strips unknown keys.

const zoneName = z
  .string()
  .trim()
  .min(1, 'Zone name is required')
  .max(40, 'Zone name may not exceed 40 characters')

const zoneCapacity = z.number().int().min(1, 'Zone capacity must be at least 1')

// Case-insensitively distinct names within one request.
const distinctNames = (zones: { name: string }[]): boolean => {
  const seen = new Set(zones.map((z) => z.name.trim().toLowerCase()))
  return seen.size === zones.length
}

// A single zone create (used on the standalone POST — adds one zone to an already-zoned service).
export const createZoneSchema = z.object({
  name: zoneName,
  capacity: zoneCapacity,
  sort_order: z.number().int().min(0).optional(),
})

// A zone edit (rename / resize / reorder). Full replace of the editable fields.
export const updateZoneSchema = z.object({
  name: zoneName,
  capacity: zoneCapacity,
  sort_order: z.number().int().min(0).optional(),
})

// Enable zones on a service: 2–6 zones defined at once, plus which one absorbs any seats already
// sold on future departures (an index into `zones`, required only when such sales exist — the
// handler enforces the conditional requirement since it depends on DB state).
export const enableZonesSchema = z
  .object({
    zones: z.array(createZoneSchema).min(2, 'At least 2 zones are required').max(
      6,
      'At most 6 zones are allowed',
    ),
    assign_existing_to: z.number().int().min(0).optional(),
    // Naive org-local today ('YYYY-MM-DD'); partitions past vs future slots. Defaults server-side.
    today: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
  })
  .refine((v) => distinctNames(v.zones), {
    message: 'Zone names must be distinct',
    path: ['zones'],
  })
  .refine((v) => v.assign_existing_to === undefined || v.assign_existing_to < v.zones.length, {
    message: 'assign_existing_to is out of range',
    path: ['assign_existing_to'],
  })

export const disableZonesSchema = z.object({
  today: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
})

export type CreateZoneInput = z.infer<typeof createZoneSchema>
export type UpdateZoneInput = z.infer<typeof updateZoneSchema>
export type EnableZonesInput = z.infer<typeof enableZonesSchema>
export type DisableZonesInput = z.infer<typeof disableZonesSchema>
