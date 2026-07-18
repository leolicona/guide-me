import type { Context } from 'hono'
import { and, eq, gte, inArray, lt, ne, sql } from 'drizzle-orm'
import { getDb, type Db } from '../../db/client'
import { affiliateCompanies, cashDrops, folios, payouts, users } from '../../db/schema'
import type { AppVariables } from '../../types/context'
import type { CommissionReportQuery } from './schema'

export type ReportsContext = Context<{
  Bindings: CloudflareBindings
  Variables: AppVariables
}>

// Minor units → a plain decimal string for CSV cells (not locale-aware; the UI formats the JSON).
const money = (minor: number) => (minor / 100).toFixed(2)

// from/to are inclusive calendar days in the org's UTC reporting model (matches
// routes/pos/handler.ts). Returns [fromDate, toExclusive) for half-open comparisons.
const resolveRange = (from: string, to: string) => ({
  fromDate: new Date(`${from}T00:00:00Z`),
  toExclusive: new Date(Date.parse(`${to}T00:00:00Z`) + 86_400_000),
})

type SellerRole = 'admin' | 'agent' | 'affiliate'

export interface CommissionReportRow {
  seller_id: string
  name: string
  role: SellerRole
  affiliate_company: string | null
  folios_sold: number
  sales_total: number
  cash_collected: number
  electronic_total: number
  commission_earned: number
  confirmed_drops: number
  payouts: number
  net_owed: number
}

export interface CommissionReport {
  period: { from: string; to: string }
  totals: Omit<CommissionReportRow, 'seller_id' | 'name' | 'role' | 'affiliate_company'>
  sellers: CommissionReportRow[]
}

// The core read (US-A17/A18/A53). Three grouped aggregates (folios, confirmed drops, payouts),
// each keyed by agent_id, stitched against the org's user roster in JS — constant in the number
// of sellers (no per-seller derivation; this report needs no shift watermark). All money is
// integer minor units; every query is org-scoped (organization_id from the session).
//
// Keep-semantics mirror the running balance (routes/cash/handler.ts): cancelled folios are
// excluded from sales/collected; commission is kept on a live folio OR a company-absorbed
// cancellation (clawback = false), so summing commission_amount reflects clawbacks for free.
export const buildCommissionReport = async (
  db: Db,
  org: string,
  q: CommissionReportQuery,
): Promise<CommissionReport> => {
  const { fromDate, toExclusive } = resolveRange(q.from, q.to)

  const folioFilters = [
    eq(folios.organizationId, org),
    gte(folios.createdAt, fromDate),
    lt(folios.createdAt, toExclusive),
    ...(q.seller_id ? [eq(folios.agentId, q.seller_id)] : []),
    ...(q.affiliate_company_id
      ? [eq(folios.affiliateCompanyId, q.affiliate_company_id)]
      : []),
  ]

  const folioAgg = await db
    .select({
      agentId: folios.agentId,
      foliosSold: sql<number>`count(case when ${folios.status} != 'cancelled' then 1 end)`,
      salesTotal: sql<number>`coalesce(sum(case when ${folios.status} != 'cancelled' then ${folios.total} end), 0)`,
      cashCollected: sql<number>`coalesce(sum(case when ${folios.status} != 'cancelled' and ${folios.paymentMethod} = 'cash' then ${folios.amountPaid} end), 0)`,
      electronicTotal: sql<number>`coalesce(sum(case when ${folios.status} != 'cancelled' and ${folios.paymentMethod} != 'cash' then ${folios.amountPaid} end), 0)`,
      commission: sql<number>`coalesce(sum(case when (${folios.status} != 'cancelled' or ${folios.cancellationClawback} = 0) then ${folios.commissionAmount} end), 0)`,
    })
    .from(folios)
    .where(and(...folioFilters))
    .groupBy(folios.agentId)

  const dropAgg = await db
    .select({
      agentId: cashDrops.agentId,
      total: sql<number>`coalesce(sum(${cashDrops.amount}), 0)`,
    })
    .from(cashDrops)
    .where(
      and(
        eq(cashDrops.organizationId, org),
        eq(cashDrops.status, 'confirmed'),
        gte(cashDrops.createdAt, fromDate),
        lt(cashDrops.createdAt, toExclusive),
      ),
    )
    .groupBy(cashDrops.agentId)

  const payoutAgg = await db
    .select({
      agentId: payouts.agentId,
      total: sql<number>`coalesce(sum(${payouts.amount}), 0)`,
    })
    .from(payouts)
    .where(
      and(
        eq(payouts.organizationId, org),
        gte(payouts.createdAt, fromDate),
        lt(payouts.createdAt, toExclusive),
      ),
    )
    .groupBy(payouts.agentId)

  const dropBySeller = new Map(dropAgg.map((r) => [r.agentId, Number(r.total ?? 0)]))
  const payoutBySeller = new Map(payoutAgg.map((r) => [r.agentId, Number(r.total ?? 0)]))
  const folioBySeller = new Map(folioAgg.map((r) => [r.agentId, r]))

  // Every seller with ANY activity in range (folios, confirmed drops, or payouts). A
  // drop/payout-only seller — cash settled this period against prior sales — is real activity
  // and appears (with a negative net_owed); a zero-activity seller never does.
  const sellerIds = new Set<string>([
    ...folioBySeller.keys(),
    ...dropBySeller.keys(),
    ...payoutBySeller.keys(),
  ])

  if (sellerIds.size === 0) {
    return emptyReport(q)
  }

  // Roster — org-scoped (no cross-org leak) + role/company for labelling. The org filter is the
  // multitenancy backstop even though the aggregates were already org-scoped.
  const roster = await db
    .select({
      id: users.id,
      name: users.name,
      role: users.role,
      affiliateCompany: affiliateCompanies.name,
      affiliateCompanyId: users.affiliateCompanyId,
    })
    .from(users)
    .leftJoin(affiliateCompanies, eq(affiliateCompanies.id, users.affiliateCompanyId))
    .where(and(eq(users.organizationId, org), inArray(users.id, [...sellerIds])))

  const sellers: CommissionReportRow[] = roster
    // For the per-affiliate (US-A53) drill-down, drops/payouts carry no company column — keep
    // only sellers belonging to the requested company so the settlement totals stay scoped.
    .filter((u) =>
      q.affiliate_company_id ? u.affiliateCompanyId === q.affiliate_company_id : true,
    )
    .map((u) => {
      const f = folioBySeller.get(u.id)
      const cashCollected = Number(f?.cashCollected ?? 0)
      const commission = Number(f?.commission ?? 0)
      const confirmedDrops = dropBySeller.get(u.id) ?? 0
      const payoutsTotal = payoutBySeller.get(u.id) ?? 0
      return {
        seller_id: u.id,
        name: u.name,
        role: u.role as SellerRole,
        affiliate_company: u.affiliateCompany ?? null,
        folios_sold: Number(f?.foliosSold ?? 0),
        sales_total: Number(f?.salesTotal ?? 0),
        cash_collected: cashCollected,
        electronic_total: Number(f?.electronicTotal ?? 0),
        commission_earned: commission,
        confirmed_drops: confirmedDrops,
        payouts: payoutsTotal,
        net_owed: cashCollected - commission - confirmedDrops + payoutsTotal,
      }
    })

  sellers.sort((a, b) => b.sales_total - a.sales_total)

  const totals = sellers.reduce(
    (acc, s) => ({
      folios_sold: acc.folios_sold + s.folios_sold,
      sales_total: acc.sales_total + s.sales_total,
      cash_collected: acc.cash_collected + s.cash_collected,
      electronic_total: acc.electronic_total + s.electronic_total,
      commission_earned: acc.commission_earned + s.commission_earned,
      confirmed_drops: acc.confirmed_drops + s.confirmed_drops,
      payouts: acc.payouts + s.payouts,
      net_owed: acc.net_owed + s.net_owed,
    }),
    zeroTotals(),
  )

  return { period: { from: q.from, to: q.to }, totals, sellers }
}

const zeroTotals = (): CommissionReport['totals'] => ({
  folios_sold: 0,
  sales_total: 0,
  cash_collected: 0,
  electronic_total: 0,
  commission_earned: 0,
  confirmed_drops: 0,
  payouts: 0,
  net_owed: 0,
})

const emptyReport = (q: CommissionReportQuery): CommissionReport => ({
  period: { from: q.from, to: q.to },
  totals: zeroTotals(),
  sellers: [],
})

// US-A17 — the per-seller commission & settlement report for a date range.
export const getCommissionReport = async (c: ReportsContext) => {
  const admin = c.get('user')
  const db = getDb(c.env)
  const q = c.req.valid('query' as never) as CommissionReportQuery
  const report = await buildCommissionReport(db, admin.organizationId, q)
  return c.json(report)
}

const ROLE_LABEL: Record<SellerRole, string> = {
  admin: 'Administrador',
  agent: 'Agente',
  affiliate: 'Afiliado',
}

// CSV-injection guard: a cell starting with a formula trigger is prefixed with a quote so a
// spreadsheet treats it as text, never executes it.
const csvCell = (value: string): string => {
  const needsQuote = /[",\r\n]/.test(value)
  const guarded = /^[=+\-@]/.test(value) ? `'${value}` : value
  return needsQuote ? `"${guarded.replace(/"/g, '""')}"` : guarded
}

const HEADER = [
  'seller',
  'role',
  'affiliate_company',
  'folios_sold',
  'sales_total',
  'cash_collected',
  'electronic_total',
  'commission_earned',
  'confirmed_drops',
  'payouts',
  'net_owed',
] as const

// US-A20 — CSV export of the US-A17 read (one row per seller + a TOTALS row). PDF is delivered
// client-side via browser print, so the only server format is CSV.
export const exportCommissionReport = async (c: ReportsContext) => {
  const admin = c.get('user')
  const db = getDb(c.env)
  const q = c.req.valid('query' as never) as CommissionReportQuery
  const report = await buildCommissionReport(db, admin.organizationId, q)

  const rows: string[] = [HEADER.join(',')]
  for (const s of report.sellers) {
    rows.push(
      [
        csvCell(s.name),
        csvCell(ROLE_LABEL[s.role]),
        csvCell(s.affiliate_company ?? ''),
        String(s.folios_sold),
        money(s.sales_total),
        money(s.cash_collected),
        money(s.electronic_total),
        money(s.commission_earned),
        money(s.confirmed_drops),
        money(s.payouts),
        money(s.net_owed),
      ].join(','),
    )
  }
  const t = report.totals
  rows.push(
    [
      csvCell('TOTALS'),
      '',
      '',
      String(t.folios_sold),
      money(t.sales_total),
      money(t.cash_collected),
      money(t.electronic_total),
      money(t.commission_earned),
      money(t.confirmed_drops),
      money(t.payouts),
      money(t.net_owed),
    ].join(','),
  )

  const csv = rows.join('\r\n')
  return new Response(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="comisiones_${q.from}_${q.to}.csv"`,
    },
  })
}
