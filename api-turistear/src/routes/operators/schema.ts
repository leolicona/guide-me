import { z } from 'zod'

// docs/affiliate-operators/spec.md. Manager-facing operator management (US-AF10/AF12) + the
// token-based operator access flow (US-OP01/OP02).

export const createOperatorSchema = z.object({
  name: z.string().trim().min(2).max(80),
  phone: z.string().trim().min(8).max(24),
})

const pinSchema = z
  .string()
  .trim()
  .regex(/^\d{4}$/, 'El PIN debe tener 4 dígitos')

// First-run PIN setup (US-OP01): set + confirm.
export const setPinSchema = z
  .object({
    pin: pinSchema,
    confirm: pinSchema,
  })
  .refine((v) => v.pin === v.confirm, {
    message: 'Los PIN no coinciden',
    path: ['confirm'],
  })

// Daily unlock (US-OP02).
export const loginSchema = z.object({
  pin: pinSchema,
})

// Self-service change from within a shift (US-OP02).
export const changePinSchema = z
  .object({
    current: pinSchema,
    new: pinSchema,
    confirm: pinSchema,
  })
  .refine((v) => v.new === v.confirm, {
    message: 'Los PIN no coinciden',
    path: ['confirm'],
  })

export type CreateOperatorInput = z.infer<typeof createOperatorSchema>
export type SetPinInput = z.infer<typeof setPinSchema>
export type LoginInput = z.infer<typeof loginSchema>
export type ChangePinInput = z.infer<typeof changePinSchema>
