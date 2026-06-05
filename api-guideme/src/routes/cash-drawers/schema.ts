import { z } from 'zod'

// Cash drawer payloads. Money is integer minor units (centavos). Per Multitenancy
// Rules 1 & 3, no `organizationId` / `agent_id` / `status` / totals fields — those come
// from context or are computed server-side from folios; Zod strips unknown keys.
// `business_date` is the only client-chosen scoping value and defaults to today.

const dateField = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')

export const addExpenseSchema = z.object({
  description: z.string().trim().min(1, 'Description is required'),
  amount: z.number().int().positive(), // minor units, > 0
  date: dateField.optional(),
})

export const closeDrawerSchema = z.object({ date: dateField.optional() })

export const reviewDrawerSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  note: z.string().trim().min(1).nullable().optional(),
})

export type AddExpenseInput = z.infer<typeof addExpenseSchema>
export type CloseDrawerInput = z.infer<typeof closeDrawerSchema>
export type ReviewDrawerInput = z.infer<typeof reviewDrawerSchema>
