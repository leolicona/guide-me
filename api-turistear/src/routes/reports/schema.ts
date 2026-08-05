import { z } from 'zod'

// Commission & settlement report by period (US-A17/A18/A20). Spec:
// docs/reports/commission-report.spec.md. `from`/`to` are inclusive calendar days
// (YYYY-MM-DD, UTC reporting model — POS precedent). `seller_id` narrows to one seller;
// `affiliate_company_id` is the US-A53 per-affiliate drill-down.
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')

export const commissionReportQuerySchema = z
  .object({
    from: ymd,
    to: ymd,
    seller_id: z.string().min(1).optional(),
    affiliate_company_id: z.string().min(1).optional(),
  })
  .refine((q) => q.from <= q.to, {
    message: 'from must be on or before to',
    path: ['from'],
  })

// Export is the same query plus a format (CSV only server-side; PDF is client print).
export const commissionExportQuerySchema = z
  .object({
    from: ymd,
    to: ymd,
    seller_id: z.string().min(1).optional(),
    affiliate_company_id: z.string().min(1).optional(),
    format: z.enum(['csv']).default('csv'),
  })
  .refine((q) => q.from <= q.to, {
    message: 'from must be on or before to',
    path: ['from'],
  })

export type CommissionReportQuery = z.infer<typeof commissionReportQuerySchema>
export type CommissionExportQuery = z.infer<typeof commissionExportQuerySchema>

// US-A85 — the wasted-seat report. `from`/`to` are inclusive calendar days compared against the
// line's own snapshotted DEPARTURE, so a seat sold in June for an August tour is wasted in August.
export const wastedSeatsQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
})
export type WastedSeatsQuery = z.infer<typeof wastedSeatsQuerySchema>
