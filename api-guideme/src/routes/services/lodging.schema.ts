import { z } from 'zod'

// Accommodation admin schemas (docs/lodging/accommodation-stays.spec.md §4.1). No
// organizationId / status fields — Multitenancy Rule 1 (taken from context, never the body).

// Closed amenity enum — keys equal the frontend label map by value (features/catalog/lodging.ts).
export const AMENITY_KEYS = [
  'wifi',
  'parking',
  'kitchen',
  'ac',
  'heating',
  'pool',
  'pets',
  'breakfast',
] as const

const dateStr = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), 'Invalid calendar date')

const timeStr = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:MM (24h)')

const money = z.number().int().min(0) // minor units (centavos)

export const createUnitSchema = z
  .object({
    name: z.string().min(1, 'Name is required'),
    unit_type: z.string().min(1).nullable().optional(),
    beds: z.number().int().min(1),
    base_occupancy: z.number().int().min(1),
    max_capacity: z.number().int().min(1),
    base_rate: money,
    weekend_rate: money.nullable().optional(),
    extra_person_fee: money.optional(), // defaults to 0
    min_nights: z.number().int().min(1).optional(), // defaults to 1
    checkin_time: timeStr.optional(), // defaults to 15:00
    checkout_time: timeStr.optional(), // defaults to 11:00
    amenities: z.array(z.enum(AMENITY_KEYS)).optional(), // defaults to []
    // Per-unit commission override (waterfall, US-A12). NULL/omitted ⇒ inherit the service rate.
    // When set: 'percent' → basis points (≤ 10000); 'fixed' → minor units. No minimum-price cap —
    // lodging has no service price floor and a fixed commission counts per stay line (spec §"Commission").
    commission_type: z.enum(['percent', 'fixed']).nullable().optional(),
    commission_value: money.nullable().optional(),
  })
  .refine((v) => v.max_capacity >= v.base_occupancy, {
    message: 'max_capacity must be ≥ base_occupancy',
    path: ['max_capacity'],
  })
  // Override is all-or-nothing: type and value are set together, or both omitted (= inherit).
  .refine((v) => (v.commission_type == null) === (v.commission_value == null), {
    message: 'commission_type and commission_value must be set together',
    path: ['commission_value'],
  })
  .refine((v) => v.commission_type !== 'percent' || (v.commission_value ?? 0) <= 10000, {
    message: 'percent commission must be ≤ 100% (10000 bp)',
    path: ['commission_value'],
  })

// PUT is a full replace — same shape as create.
export const updateUnitSchema = createUnitSchema

export const createSeasonSchema = z
  .object({
    name: z.string().min(1, 'Name is required'),
    start_date: dateStr,
    end_date: dateStr,
    nightly_rate: money,
  })
  .refine((v) => v.start_date <= v.end_date, {
    message: 'end_date must be ≥ start_date',
    path: ['end_date'],
  })

export const updateSeasonSchema = createSeasonSchema

export const createBlockoutSchema = z
  .object({
    start_date: dateStr,
    end_date: dateStr,
    reason: z.string().min(1).nullable().optional(),
  })
  .refine((v) => v.start_date < v.end_date, {
    message: 'end_date must be after start_date',
    path: ['end_date'],
  })

export type CreateUnitInput = z.infer<typeof createUnitSchema>
export type UpdateUnitInput = z.infer<typeof updateUnitSchema>
export type CreateSeasonInput = z.infer<typeof createSeasonSchema>
export type UpdateSeasonInput = z.infer<typeof updateSeasonSchema>
export type CreateBlockoutInput = z.infer<typeof createBlockoutSchema>
