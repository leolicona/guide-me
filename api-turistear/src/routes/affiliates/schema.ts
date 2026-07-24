import { z } from 'zod'

// A single commission entry (allow-list row, D1/D2). `commission_value` is whole-number basis
// points for `percent` (1500 = 15%) | minor units per spot for `fixed`. Must be > 0 (a service
// cannot be enabled at a zero rate — D2). The fixed ≤ minimum_price guard (D10) needs the
// service's price, so it is enforced in the handler, not here.
export const commissionEntrySchema = z.object({
  service_id: z.string().min(1),
  commission_type: z.enum(['percent', 'fixed']),
  commission_value: z.number().int().positive('Commission must be greater than zero'),
})

export type CommissionEntry = z.infer<typeof commissionEntrySchema>

const companyFields = {
  name: z.string().min(1, 'Company name is required'),
  contact_email: z.string().email().nullish(),
  contact_phone: z.string().min(1).nullish(),
}

// Wizard finalize (US-A54–A57, D9). `commissions` + `invites` default to [] so an empty Step 2/3
// is valid (invite later). Per Multitenancy Rule 1, no organization_id is ever accepted.
// D13 (docs/affiliate-operators/spec.md) — at most ONE affiliate (the manager) per company; extra
// sellers are PIN operators (US-AF10). So Step 3 invites at most one email.
export const createAffiliateSchema = z.object({
  company: z.object(companyFields),
  commissions: z.array(commissionEntrySchema).default([]),
  invites: z.array(z.string().email()).max(1).default([]),
})

export type CreateAffiliateInput = z.infer<typeof createAffiliateSchema>

export const updateAffiliateSchema = z.object(companyFields)

export type UpdateAffiliateInput = z.infer<typeof updateAffiliateSchema>

// Bulk upsert of the allow-list (US-A50). The full desired set: any service absent from the
// array has its row deleted (disabled). Empty array clears the affiliate's catalog.
export const bulkCommissionsSchema = z.array(commissionEntrySchema)

export type BulkCommissionsInput = z.infer<typeof bulkCommissionsSchema>

export const inviteAffiliateSchema = z.object({
  email: z.string().email(),
})

export type InviteAffiliateInput = z.infer<typeof inviteAffiliateSchema>

export const reportQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
})

export type ReportQuery = z.infer<typeof reportQuerySchema>
