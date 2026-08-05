import type { Context } from 'hono'
import { and, eq, gte, inArray, lt, lte, ne, sql } from 'drizzle-orm'
import { getDb, type Db } from '../../db/client'
import {
  affiliateCompanies,
  cashDrops,
  folioLines,
  folioPayments,
  folios,
  organizations,
  payouts,
  users,
} from '../../db/schema'
import type { AppVariables } from '../../types/context'
import type { CommissionReportQuery } from './schema'
import { fulfillmentResolution, lineFulfillment } from '../../utils/folioFulfillment'

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
      commission: sql<number>`coalesce(sum(case when (${folios.status} != 'cancelled' or ${folios.cancellationClawback} = 0) then ${folios.commissionAmount} end), 0)`,
    })
    .from(folios)
    .where(and(...folioFilters))
    .groupBy(folios.agentId)

  // US-LG08 — cash vs electronic collected come from the LEDGER (each payment/refund row's own
  // method), so a MIXED folio splits correctly and a cancellation's reversal rows net it out. Joined
  // to folios for the SAME range/scope filters (and grouped by seller), so the period semantics are
  // unchanged — only the bucketing is now method-accurate.
  const paymentAgg = await db
    .select({
      agentId: folios.agentId,
      cashCollected: sql<number>`coalesce(sum(case when ${folioPayments.method} = 'cash' then ${folioPayments.amount} else 0 end), 0)`,
      electronicTotal: sql<number>`coalesce(sum(case when ${folioPayments.method} != 'cash' then ${folioPayments.amount} else 0 end), 0)`,
    })
    .from(folioPayments)
    .innerJoin(folios, eq(folios.id, folioPayments.folioId))
    .where(and(inArray(folioPayments.entryType, ['payment', 'refund']), ...folioFilters))
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
  const paymentBySeller = new Map(paymentAgg.map((r) => [r.agentId, r]))

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
      const p = paymentBySeller.get(u.id)
      const cashCollected = Number(p?.cashCollected ?? 0)
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
        electronic_total: Number(p?.electronicTotal ?? 0),
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


// --- US-A85 — the wasted seat ------------------------------------------------------------------
//
// Spec: docs/folios/folio-state-machine.spec.md. Seats that were sold, held against capacity, and
// used by nobody. `folio_lines.redeemed_count` has been written by the scanner since the QR
// shipped; nothing ever read it for reporting, so an operator could not answer "how many seats did
// I sell and nobody used, and on which departures" — the single question that says where their
// overbooking tolerance should go.
//
// Read-only. No column, no cron, no state change: every number here is a reading of counts that
// already exist (D4).
export const getWastedSeatsReport = async (c: ReportsContext) => {
  const admin = c.get('user')
  const org = admin.organizationId
  const db = getDb(c.env)

  const { from, to } = c.req.valid('query' as never) as { from: string; to: string }

  const [orgRow] = await db
    .select({
      tz: organizations.timezone,
      noShowMargin: organizations.noShowMarginMinutes,
      redemptionMode: organizations.qrRedemptionMode,
    })
    .from(organizations)
    .where(eq(organizations.id, org))
    .limit(1)
  const tz = orgRow?.tz ?? 'America/Mexico_City'
  const margin = orgRow?.noShowMargin ?? 0
  const mode = orgRow?.redemptionMode ?? 'per_pass'
  const nowEpoch = Math.floor(Date.now() / 1000)

  // Only a PAID folio can waste a seat. A booking never got its QR, and a cancellation gave the
  // seat back — its emptiness is not waste, it is a release.
  const rows = await db
    .select({
      lineId: folioLines.id,
      serviceId: folioLines.serviceId,
      serviceName: folioLines.serviceName,
      slotDate: folioLines.slotDate,
      slotStartTime: folioLines.slotStartTime,
      checkIn: folioLines.checkIn,
      lineType: folioLines.lineType,
      quantity: folioLines.quantity,
      redeemedCount: folioLines.redeemedCount,
      lineTotal: folioLines.lineTotal,
    })
    .from(folioLines)
    .innerJoin(folios, eq(folioLines.folioId, folios.id))
    .where(
      and(
        eq(folioLines.organizationId, org),
        eq(folios.organizationId, org),
        eq(folios.status, 'paid'),
        // The DEPARTURE decides which period a wasted seat belongs to, not the sale date: a seat
        // sold in June for an August tour is wasted in August.
        gte(sql`COALESCE(${folioLines.slotDate}, ${folioLines.checkIn})`, from),
        lte(sql`COALESCE(${folioLines.slotDate}, ${folioLines.checkIn})`, to),
      ),
    )

  // Grouped by the departure a seat was wasted ON — service + date + time, which is the unit an
  // operator schedules and therefore the unit they can act on.
  const groups = new Map<
    string,
    {
      service_id: string
      service_name: string
      departure_date: string | null
      departure_time: string | null
      seats_sold: number
      seats_redeemed: number
      seats_wasted: number
      cents_wasted: number
      folios: number
    }
  >()

  let seatsWasted = 0
  let centsWasted = 0

  for (const r of rows) {
    const state = lineFulfillment(
      {
        lineId: r.lineId,
        lineType: r.lineType,
        slotDate: r.slotDate,
        slotStartTime: r.slotStartTime,
        checkIn: r.checkIn,
        lineTotal: r.lineTotal,
        quantity: r.quantity,
        redeemedCount: r.redeemedCount,
      },
      tz,
      margin,
      nowEpoch,
    )
    // A line still `pending` has not departed yet — nothing is wasted, it simply has not happened.
    if (state !== 'no_show' && state !== 'partial') continue

    const wasted = r.quantity - r.redeemedCount
    if (wasted <= 0) continue

    // The money a wasted seat represents: its share of the line, floored. Deliberately NOT a claim
    // about revenue — that money was collected and kept. It is what the empty seat was worth.
    const cents = Math.floor((r.lineTotal * wasted) / r.quantity)

    const key = `${r.serviceId}|${r.slotDate ?? r.checkIn ?? ''}|${r.slotStartTime ?? ''}`
    const g = groups.get(key) ?? {
      service_id: r.serviceId,
      service_name: r.serviceName,
      departure_date: r.slotDate ?? r.checkIn,
      departure_time: r.slotStartTime,
      seats_sold: 0,
      seats_redeemed: 0,
      seats_wasted: 0,
      cents_wasted: 0,
      folios: 0,
    }
    g.seats_sold += r.quantity
    g.seats_redeemed += r.redeemedCount
    g.seats_wasted += wasted
    g.cents_wasted += cents
    g.folios += 1
    groups.set(key, g)

    seatsWasted += wasted
    centsWasted += cents
  }

  const departures = [...groups.values()].sort(
    (a, b) =>
      b.seats_wasted - a.seats_wasted ||
      (a.departure_date ?? '').localeCompare(b.departure_date ?? ''),
  )

  return c.json({
    from,
    to,
    // D24 — WHAT THESE NUMBERS CAN DISTINGUISH, stated rather than assumed. Under `all_passes` a
    // single scan sets redeemed_count = quantity, so a party of four where two boarded reads as
    // fully used: the report can only separate "the party came" from "nobody came". Without this
    // field the same title would mean two different things in two organizations.
    redemption_mode: mode,
    resolution: fulfillmentResolution(mode),
    totals: {
      seats_wasted: seatsWasted,
      cents_wasted: centsWasted,
      departures: departures.length,
    },
    departures,
  })
}
