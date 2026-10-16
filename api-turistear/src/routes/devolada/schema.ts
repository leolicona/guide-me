import { z } from 'zod'

// devolada-transfer-verification D15 — the admin resolves a Devolada exception. Only the action and
// an optional note are client-supplied; the payment, its organization and the actor come from the
// path and the session (constitution III). Zod strips unknown keys.
export const resolveDevoladaPaymentSchema = z.object({
  action: z.enum(['accept', 'dismiss', 'returned']),
  note: z.string().trim().max(500).optional(),
})

export type ResolveDevoladaPaymentInput = z.infer<typeof resolveDevoladaPaymentSchema>
