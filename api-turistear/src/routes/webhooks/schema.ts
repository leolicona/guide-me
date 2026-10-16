import { z } from 'zod'

// devolada-transfer-verification D4 — Devolada's `WebhookEvent` (contracts/devolada-collections-v1
// § WebhookEvent). Only its routing facts are trusted, and only after the signature verified: the
// payment itself is always RE-READ with the link's own credential before anything changes.
export const DEVOLADA_EVENT_STATUSES = [
  'validating',
  'queued_for_credit',
  'confirmed',
  'partial',
  'unapplied',
  'invalid',
  'expired',
  'superseded',
] as const

export const devoladaWebhookEventSchema = z.object({
  eventId: z.string().min(1).max(255),
  type: z.enum(DEVOLADA_EVENT_STATUSES.map((s) => `payment.${s}`) as [string, ...string[]]),
  createdAt: z.number().int().nonnegative(),
  data: z.object({
    paymentId: z.string().min(1).max(255),
    paymentLinkId: z.string().min(1).max(255),
    customerRef: z.string(),
    isTest: z.boolean(),
    askedCents: z.number().int().optional(),
    claimedCents: z.number().int().nullable().optional(),
    proofDoor: z.enum(['transfer', 'receipt']).optional(),
    receivedCents: z.number().int().nullable().optional(),
    match: z.enum(['exact', 'short', 'over']).nullable().optional(),
    folio: z.string().nullable().optional(),
    confirmedAt: z.number().nullable().optional(),
  }),
})

export type DevoladaWebhookEvent = z.infer<typeof devoladaWebhookEventSchema>
