import { z } from 'zod'

// US-A14/A15/A16/A90 — the Daily Operations Dashboard read (docs/dashboard/occupancy-dashboard.spec.md).
// `date` is optional: absent means the org's today, resolved server-side in the org's zone; the
// client may pin a day from the quick-day strip.
export const dashboardDayQuerySchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
})

export type DashboardDayQuery = z.infer<typeof dashboardDayQuerySchema>
