// Commission & settlement report by period (US-A17/A18/A20). Money is integer minor units
// (centavos); format with `formatMoney`. Spec: docs/reports/commission-report.spec.md.

export interface CommissionReportRow {
  seller_id: string
  name: string
  role: 'admin' | 'agent' | 'affiliate'
  affiliate_company: string | null
  folios_sold: number
  sales_total: number
  cash_collected: number
  electronic_total: number
  commission_earned: number
  confirmed_drops: number
  payouts: number
  // > 0 → the seller still owes the company this cash; < 0 → the company owes the seller.
  net_owed: number
}

export type CommissionReportTotals = Omit<
  CommissionReportRow,
  'seller_id' | 'name' | 'role' | 'affiliate_company'
>

export interface CommissionReport {
  period: { from: string; to: string }
  totals: CommissionReportTotals
  sellers: CommissionReportRow[]
}

export interface CommissionReportParams {
  from: string // YYYY-MM-DD (inclusive)
  to: string // YYYY-MM-DD (inclusive)
  seller_id?: string
  affiliate_company_id?: string
}

// Client-side ranking key for the US-A18 performance comparison.
export type ReportSortKey = 'sales_total' | 'folios_sold' | 'commission_earned'
