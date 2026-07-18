import { z } from 'zod'

// QR scan payload. The body carries ONLY the raw QR contents (the signed token);
// per Multitenancy Rules 1 & 3 the organization and agent come from context, never the
// body (Zod strips unknown keys).
export const scanTicketSchema = z.object({
  token: z.string().min(1, 'A token is required'),
})

export type ScanTicketInput = z.infer<typeof scanTicketSchema>
