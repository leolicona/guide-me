import { z } from 'zod'

// Money fields are entered as major-unit decimals (e.g. 1500.00) the admin
// types; the form converts them to minor units (amountToCents) before calling
// the API. Mirrors the backend's createServiceSchema (minimum ≤ base).
const amount = z
  .number({ message: 'Ingresa un monto válido' })
  .min(0, 'El monto no puede ser negativo')

export const serviceFormSchema = z
  .object({
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
  })
  .refine((v) => v.minimum_price <= v.base_price, {
    message: 'El precio mínimo debe ser ≤ al precio base',
    path: ['minimum_price'],
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
