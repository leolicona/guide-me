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
    // US-A12 — per-service commission bonus (major-decimal in the form; converted to minor
    // units before the API call). Optional → 0.
    commission_bonus: amount,
  })
  .refine((v) => v.minimum_price <= v.base_price, {
    message: 'El precio mínimo debe ser ≤ al precio base',
    path: ['minimum_price'],
  })

export type ServiceFormData = z.infer<typeof serviceFormSchema>

export const extraFormSchema = z.object({
  name: z.string().min(1, 'El nombre es obligatorio'),
  price: amount,
})

export type ExtraFormData = z.infer<typeof extraFormSchema>
