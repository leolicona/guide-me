import { z } from 'zod'
import { FLEX_CAP_MAX_PCT } from './types'
import { SERVICE_CATEGORIES } from './categories'
import { AMENITY_KEYS } from './lodging'

// Money fields are entered as major-unit decimals (e.g. 1500.00) the admin
// types; the form converts them to minor units (amountToCents) before calling
// the API. Mirrors the backend's createServiceSchema (minimum ≤ base).
const amount = z
  .number({ message: 'Ingresa un monto válido' })
  .min(0, 'El monto no puede ser negativo')

// The unrefined field set, shared by the single-dialog form and the create Wizard
// (US-A38). Kept as a plain ZodObject so the Wizard can `.merge` its availability
// fields; the cross-field refines are applied below (and re-stated in the Wizard's
// own superRefine), so both forms enforce the identical rules.
export const serviceCoreObject = z.object({
  name: z.string().min(1, 'El nombre es obligatorio'),
    description: z.string().optional(),
    base_price: amount,
    minimum_price: amount,
    default_capacity: z
      .number({ message: 'Ingresa una capacidad válida' })
      .int('La capacidad debe ser un entero')
      .min(1, 'La capacidad mínima es 1'),
    // US-A12 (rev.) — the service's commission, earned by any seller
    // (docs/commissions/service-based-commission.spec.md). The admin enters either a percent
    // (0–100 → basis points) or a fixed amount per spot in pesos (→ minor units).
    commission_type: z.enum(['percent', 'fixed']),
    commission_value: z
      .number({ message: 'Ingresa un valor válido' })
      .min(0, 'El valor no puede ser negativo'),
    // US-A37 — required primary category. The dropdown starts empty for a new service; an
    // empty value fails the enum, surfacing "Selecciona una categoría" (mirrors the backend).
    category: z.enum(SERVICE_CATEGORIES, { message: 'Selecciona una categoría' }),
    // US-A36 — capacity mode + overbooking tolerance (mirrors the backend services schema).
    is_flexible: z.boolean(),
    flex_capacity_pct: z
      .number({ message: 'Ingresa un porcentaje válido' })
      .int('El porcentaje debe ser un entero')
      .min(0, 'El porcentaje no puede ser negativo')
      .max(FLEX_CAP_MAX_PCT, `El máximo permitido es ${FLEX_CAP_MAX_PCT}%`),
})

export const serviceFormSchema = serviceCoreObject
  .refine((v) => v.minimum_price <= v.base_price, {
    message: 'El precio mínimo debe ser ≤ al precio base',
    path: ['minimum_price'],
  })
  // US-A36 — Flexible (Soft Cap) requires a tolerance of at least 1%; the form blocks saving
  // when Flexible is selected but the field is empty or 0.
  .refine((v) => !v.is_flexible || v.flex_capacity_pct >= 1, {
    message: `Ingresa un porcentaje entre 1% y ${FLEX_CAP_MAX_PCT}%`,
    path: ['flex_capacity_pct'],
  })
  .refine((v) => v.commission_type !== 'percent' || v.commission_value <= 100, {
    message: 'El porcentaje máximo es 100',
    path: ['commission_value'],
  })
  // Mirrors the backend D3 cap: a fixed commission may never exceed the price floor (both
  // values are entered in major units here, so they compare directly).
  .refine((v) => v.commission_type !== 'fixed' || v.commission_value <= v.minimum_price, {
    message: 'La comisión fija no puede exceder el precio mínimo',
    path: ['commission_value'],
  })

export type ServiceFormData = z.infer<typeof serviceFormSchema>

export const extraFormSchema = z.object({
  name: z.string().min(1, 'El nombre es obligatorio'),
  price: amount,
})

export type ExtraFormData = z.infer<typeof extraFormSchema>

// --- Accommodation / lodging form schemas (docs/lodging/accommodation-stays.spec.md) ---
// Money fields are entered as major-unit decimals (the admin types $); convert with
// amountToCents on submit. Dates are 'YYYY-MM-DD', times 'HH:MM'. Mirrors the API schemas.

const dateStr = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Selecciona una fecha válida')
const timeStr = z.string().regex(/^\d{2}:\d{2}$/, 'Hora inválida (HH:MM)')
const positiveInt = (label: string) =>
  z.number({ message: `Ingresa ${label}` }).int(`${label} debe ser un entero`).min(1, `El mínimo es 1`)

export const unitFormSchema = z
  .object({
    name: z.string().min(1, 'El nombre es obligatorio'),
    unit_type: z.string().optional(),
    // v2 — how many interchangeable rooms of this type exist (1 = a unique boutique unit).
    inventory_count: positiveInt('el inventario'),
    beds: positiveInt('las camas'),
    base_occupancy: positiveInt('la ocupación base'),
    max_capacity: positiveInt('la capacidad máxima'),
    base_rate: amount,
    // Weekend rate is optional ("use base" when empty → null). The form input coerces an empty
    // field to null via RHF `setValueAs` (see UnitFields), so the schema stays a clean number|null.
    weekend_rate: amount.nullable(),
    extra_person_fee: amount,
    min_nights: positiveInt('la estancia mínima'),
    checkin_time: timeStr,
    checkout_time: timeStr,
    amenities: z.array(z.enum(AMENITY_KEYS)),
    // Commission override (waterfall): 'inherit' ⇒ use the service's base commission. 'percent' is
    // entered 0–100, 'fixed' as a major-unit amount; the form converts on submit. Value is null
    // when inheriting (RHF setValueAs in UnitFields).
    commission_type: z.enum(['inherit', 'percent', 'fixed']),
    commission_value: amount.nullable(),
  })
  .refine((v) => v.max_capacity >= v.base_occupancy, {
    message: 'La capacidad máxima no puede ser menor a la base',
    path: ['max_capacity'],
  })
  .superRefine((v, ctx) => {
    if (v.commission_type === 'inherit') return
    if (v.commission_value == null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['commission_value'], message: 'Ingresa la comisión' })
    } else if (v.commission_type === 'percent' && v.commission_value > 100) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['commission_value'], message: 'El máximo es 100%' })
    }
  })

export type UnitFormData = z.infer<typeof unitFormSchema>

export const seasonFormSchema = z
  .object({
    name: z.string().min(1, 'El nombre es obligatorio'),
    start_date: dateStr,
    end_date: dateStr,
    nightly_rate: amount,
  })
  .refine((v) => v.end_date >= v.start_date, {
    message: 'La fecha de fin debe ser igual o posterior al inicio',
    path: ['end_date'],
  })

export type SeasonFormData = z.infer<typeof seasonFormSchema>

export const blockoutFormSchema = z
  .object({
    start_date: dateStr,
    end_date: dateStr,
    // v2 (D11) — rooms of the type taken out of inventory for the range (≥ 1).
    quantity: positiveInt('la cantidad'),
    reason: z.string().optional(),
  })
  .refine((v) => v.end_date > v.start_date, {
    message: 'La fecha de fin debe ser posterior al inicio',
    path: ['end_date'],
  })

export type BlockoutFormData = z.infer<typeof blockoutFormSchema>

/** Two inclusive date ranges overlap (seasons are inclusive on both ends, like the API guard). */
export const rangesOverlap = (
  a: { start_date: string; end_date: string },
  b: { start_date: string; end_date: string },
): boolean => a.start_date <= b.end_date && b.start_date <= a.end_date

/** Client-side season overlap guard so the wizard's draft seasons reject overlaps inline
 * (the API's 409 SEASON_OVERLAP stays the backstop). `excludeId` skips the row being edited. */
export const seasonOverlaps = (
  draft: { start_date: string; end_date: string },
  existing: { id?: string; start_date: string; end_date: string }[],
  excludeId?: string,
): boolean =>
  existing.some((s) => (excludeId ? s.id !== excludeId : true) && rangesOverlap(draft, s))
