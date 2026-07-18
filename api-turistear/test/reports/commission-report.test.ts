import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import {
  seedUser,
  seedTwoOrgs,
  seedAffiliateCompany,
  clearAffiliateDb,
} from '../helpers/tenancy'
import { buildFakeJwt } from '../helpers/jwt'

// Commission & settlement report by period — US-A17/A18/A20.
// Spec: docs/reports/commission-report.spec.md. Read-only date-range aggregate over
// folios + confirmed cash drops + payouts, per seller (agent + affiliate + admin), with
//   net_owed = cash_collected − commission_earned − confirmed_drops + payouts.

const ADMIN_EMAIL = 'admin@empresa.com'
const AGENT_EMAIL = 'agent@empresa.com'
const AGENT2_EMAIL = 'agent2@empresa.com'

const auth = (email: string) => ({ Cookie: `gm_access=${buildFakeJwt(email)}` })

const REPORTS = 'http://api.local/api/reports'
const nowSec = () => Math.floor(Date.now() / 1000)

// --- Local seeders (raw D1) ------------------------------------------------

interface SeedFolioOptions {
  organizationId: string
  agentId: string
  affiliateCompanyId?: string
  status?: 'paid' | 'booking' | 'cancelled'
  total?: number
  amountPaid: number
  paymentMethod?: 'cash' | 'card' | 'transfer' | 'link'
  commissionAmount?: number
  cancellationClawback?: boolean
  createdAt?: number
}

const seedFolio = async ({
  organizationId,
  agentId,
  affiliateCompanyId,
  status = 'paid',
  total,
  amountPaid,
  paymentMethod = 'cash',
  commissionAmount = 0,
  cancellationClawback = false,
  createdAt,
}: SeedFolioOptions): Promise<string> => {
  const id = crypto.randomUUID()
  const ts = createdAt ?? nowSec()
  await env.DB.prepare(
    `INSERT INTO folios
       (id, organization_id, agent_id, affiliate_company_id, customer_name, status, payment_method,
        subtotal, discount_total, total, amount_paid, commission_amount,
        cancellation_clawback, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'John Diver', ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      organizationId,
      agentId,
      affiliateCompanyId ?? null,
      status,
      paymentMethod,
      total ?? amountPaid,
      total ?? amountPaid,
      amountPaid,
      commissionAmount,
      cancellationClawback ? 1 : 0,
      ts,
      ts,
    )
    .run()
  return id
}

const seedDrop = async (opts: {
  organizationId: string
  agentId: string
  amount: number
  status?: 'pending' | 'confirmed' | 'rejected'
  createdAt?: number
}): Promise<void> => {
  const ts = opts.createdAt ?? nowSec()
  await env.DB.prepare(
    `INSERT INTO cash_drops (id, organization_id, agent_id, amount, balance_before, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      opts.organizationId,
      opts.agentId,
      opts.amount,
      opts.amount,
      opts.status ?? 'confirmed',
      ts,
      ts,
    )
    .run()
}

const seedPayout = async (opts: {
  organizationId: string
  agentId: string
  amount: number
  createdBy: string
  createdAt?: number
}): Promise<void> => {
  await env.DB.prepare(
    `INSERT INTO payouts (id, organization_id, agent_id, amount, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      opts.organizationId,
      opts.agentId,
      opts.amount,
      opts.createdBy,
      opts.createdAt ?? nowSec(),
    )
    .run()
}

const seedOrgWithStaff = async () => {
  const { organizationId, userId: adminId } = await seedUser({ email: ADMIN_EMAIL, role: 'admin' })
  const { userId: agentId } = await seedUser({ email: AGENT_EMAIL, role: 'agent', organizationId })
  return { organizationId, adminId, agentId }
}

interface ReportRow {
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
  net_owed: number
}
interface ReportBody {
  period: { from: string; to: string }
  totals: Omit<ReportRow, 'seller_id' | 'name' | 'role' | 'affiliate_company'>
  sellers: ReportRow[]
}

// A wide window that contains "now" (the default seed timestamp).
const WINDOW = `from=2020-01-01&to=2999-12-31`
const getReport = (qs: string, email = ADMIN_EMAIL) =>
  SELF.fetch(`${REPORTS}/commissions?${qs}`, { headers: auth(email) })

beforeEach(async () => {
  await clearAffiliateDb()
})
afterEach(async () => {
  await clearAffiliateDb()
})

describe('US-A17 — per-seller settlement math', () => {
  it('computes sales/cash/electronic/commission and net_owed with clawback semantics', async () => {
    const { organizationId, agentId } = await seedOrgWithStaff()
    // Cash sale: total 200000, collected 200000, commission 30000.
    await seedFolio({ organizationId, agentId, total: 200000, amountPaid: 200000, commissionAmount: 30000 })
    // Card sale: collected electronically (no cash debt), commission 10000.
    await seedFolio({ organizationId, agentId, total: 100000, amountPaid: 100000, paymentMethod: 'card', commissionAmount: 10000 })
    // Cancelled WITH clawback → excluded from sales AND commission dropped.
    await seedFolio({ organizationId, agentId, total: 50000, amountPaid: 50000, status: 'cancelled', commissionAmount: 8000, cancellationClawback: true })
    // Cancelled, company ABSORBS the loss (no clawback) → excluded from sales, commission KEPT.
    await seedFolio({ organizationId, agentId, total: 40000, amountPaid: 40000, status: 'cancelled', commissionAmount: 5000, cancellationClawback: false })
    // A confirmed hand-in and a payout in range.
    await seedDrop({ organizationId, agentId, amount: 120000 })
    await seedPayout({ organizationId, agentId, amount: 7000, createdBy: agentId })

    const res = await getReport(WINDOW)
    expect(res.status).toBe(200)
    const body = (await res.json()) as ReportBody
    const row = body.sellers.find((s) => s.seller_id === agentId)!
    expect(row).toBeDefined()
    expect(row.folios_sold).toBe(2) // two non-cancelled
    expect(row.sales_total).toBe(300000) // 200000 + 100000
    expect(row.cash_collected).toBe(200000)
    expect(row.electronic_total).toBe(100000)
    // 30000 (cash) + 10000 (card) + 5000 (absorbed cancel) = 45000; clawed-back 8000 excluded.
    expect(row.commission_earned).toBe(45000)
    expect(row.confirmed_drops).toBe(120000)
    expect(row.payouts).toBe(7000)
    // 200000 − 45000 − 120000 + 7000 = 42000
    expect(row.net_owed).toBe(42000)

    // Org totals mirror the single seller.
    expect(body.totals.sales_total).toBe(300000)
    expect(body.totals.net_owed).toBe(42000)
  })

  it('counts only CONFIRMED drops (pending/rejected excluded)', async () => {
    const { organizationId, agentId } = await seedOrgWithStaff()
    await seedFolio({ organizationId, agentId, amountPaid: 100000, commissionAmount: 0 })
    await seedDrop({ organizationId, agentId, amount: 40000, status: 'confirmed' })
    await seedDrop({ organizationId, agentId, amount: 99999, status: 'pending' })
    await seedDrop({ organizationId, agentId, amount: 88888, status: 'rejected' })

    const body = (await (await getReport(WINDOW)).json()) as ReportBody
    const row = body.sellers.find((s) => s.seller_id === agentId)!
    expect(row.confirmed_drops).toBe(40000)
    expect(row.net_owed).toBe(60000) // 100000 − 0 − 40000
  })
})

describe('US-A17 — date-range boundaries (half-open [from, to+1d))', () => {
  it('includes a folio at the end of `to` and excludes one before `from`', async () => {
    const { organizationId, agentId } = await seedOrgWithStaff()
    // from=2026-06-01, to=2026-06-30 (UTC). Boundaries computed against those.
    const before = Math.floor(Date.parse('2026-05-31T23:59:59Z') / 1000)
    const lastInstant = Math.floor(Date.parse('2026-06-30T23:59:59Z') / 1000)
    const after = Math.floor(Date.parse('2026-07-01T00:00:00Z') / 1000)
    await seedFolio({ organizationId, agentId, amountPaid: 11111, createdAt: before })
    await seedFolio({ organizationId, agentId, amountPaid: 22222, createdAt: lastInstant })
    await seedFolio({ organizationId, agentId, amountPaid: 33333, createdAt: after })

    const body = (await (await getReport('from=2026-06-01&to=2026-06-30')).json()) as ReportBody
    const row = body.sellers.find((s) => s.seller_id === agentId)!
    expect(row.cash_collected).toBe(22222) // only the in-range folio
    expect(row.folios_sold).toBe(1)
  })
})

describe('US-A18 — affiliates + admin appear as sellers; ranked', () => {
  it('tags affiliate rows with role + company and includes the admin as a seller', async () => {
    const { organizationId, adminId, agentId } = await seedOrgWithStaff()
    const { companyId } = await seedAffiliateCompany({ organizationId, name: 'Hotel Maya' })
    const { userId: affId } = await seedUser({
      email: 'aff@maya.com',
      role: 'affiliate',
      organizationId,
      affiliateCompanyId: companyId,
    })
    await seedFolio({ organizationId, agentId, amountPaid: 100000 })
    await seedFolio({ organizationId, agentId: adminId, amountPaid: 500000 }) // admin sells
    await seedFolio({ organizationId, agentId: affId, affiliateCompanyId: companyId, amountPaid: 300000, commissionAmount: 60000 })

    const body = (await (await getReport(WINDOW)).json()) as ReportBody
    expect(body.sellers).toHaveLength(3)
    // Ranked by sales_total desc → admin (500k) first.
    expect(body.sellers[0].seller_id).toBe(adminId)
    expect(body.sellers[0].role).toBe('admin')

    const aff = body.sellers.find((s) => s.role === 'affiliate')!
    expect(aff.affiliate_company).toBe('Hotel Maya')
    expect(aff.commission_earned).toBe(60000)
    expect(aff.net_owed).toBe(240000) // 300000 − 60000
  })
})

describe('US-A53 — per-affiliate drill-down via affiliate_company_id', () => {
  it('returns only the requested company sellers', async () => {
    const { organizationId, agentId } = await seedOrgWithStaff()
    const { companyId } = await seedAffiliateCompany({ organizationId, name: 'Hotel Maya' })
    const { userId: affId } = await seedUser({
      email: 'aff@maya.com',
      role: 'affiliate',
      organizationId,
      affiliateCompanyId: companyId,
    })
    await seedFolio({ organizationId, agentId, amountPaid: 100000 }) // in-house — should NOT appear
    await seedFolio({ organizationId, agentId: affId, affiliateCompanyId: companyId, amountPaid: 300000 })

    const body = (await (await getReport(`${WINDOW}&affiliate_company_id=${companyId}`)).json()) as ReportBody
    expect(body.sellers).toHaveLength(1)
    expect(body.sellers[0].seller_id).toBe(affId)
    expect(body.sellers[0].sales_total).toBe(300000)
  })
})

describe('US-A17 — activity gating', () => {
  it('omits zero-activity sellers but includes a drop-only seller (negative net_owed)', async () => {
    const { organizationId, agentId } = await seedOrgWithStaff()
    // agent2 has NO folios but handed in cash this period (settling prior sales).
    const { userId: agent2Id } = await seedUser({ email: AGENT2_EMAIL, role: 'agent', organizationId })
    await seedFolio({ organizationId, agentId, amountPaid: 100000 })
    await seedDrop({ organizationId, agentId: agent2Id, amount: 25000 })

    const body = (await (await getReport(WINDOW)).json()) as ReportBody
    const ids = body.sellers.map((s) => s.seller_id)
    expect(ids).toContain(agentId)
    expect(ids).toContain(agent2Id)
    const a2 = body.sellers.find((s) => s.seller_id === agent2Id)!
    expect(a2.folios_sold).toBe(0)
    expect(a2.net_owed).toBe(-25000) // 0 − 0 − 25000 + 0
  })
})

describe('Validation', () => {
  it('rejects from > to with 400', async () => {
    await seedOrgWithStaff()
    const res = await getReport('from=2026-06-30&to=2026-06-01')
    expect(res.status).toBe(400)
  })

  it('rejects a malformed date with 400', async () => {
    await seedOrgWithStaff()
    const res = await getReport('from=June&to=2026-06-30')
    expect(res.status).toBe(400)
  })

  it('rejects an unsupported export format with 400', async () => {
    await seedOrgWithStaff()
    const res = await SELF.fetch(`${REPORTS}/commissions/export?${WINDOW}&format=pdf`, {
      headers: auth(ADMIN_EMAIL),
    })
    expect(res.status).toBe(400)
  })

  it('denies a non-admin (agent) with 403', async () => {
    await seedOrgWithStaff()
    const res = await getReport(WINDOW, AGENT_EMAIL)
    expect(res.status).toBe(403)
  })
})

describe('US-A20 — CSV export', () => {
  it('streams a CSV attachment with a TOTALS row and an injection guard', async () => {
    const { organizationId } = await seedOrgWithStaff()
    // A seller whose name would be a spreadsheet formula if unguarded.
    const { userId: evilId } = await seedUser({
      email: 'evil@empresa.com',
      name: '=cmd()',
      role: 'agent',
      organizationId,
    })
    await seedFolio({ organizationId, agentId: evilId, amountPaid: 100000, commissionAmount: 10000 })

    const res = await SELF.fetch(`${REPORTS}/commissions/export?${WINDOW}`, {
      headers: auth(ADMIN_EMAIL),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('text/csv')
    expect(res.headers.get('Content-Disposition')).toContain('attachment')
    const csv = await res.text()
    expect(csv).toContain('seller,role,affiliate_company')
    expect(csv).toContain('TOTALS')
    // The "=cmd()" name is neutralized with a leading quote (no CSV-quoting needed — no comma).
    expect(csv).toContain(`'=cmd()`)
    expect(csv).not.toMatch(/^=cmd/m)
  })
})

describe('Multitenancy — cross-org isolation (seedTwoOrgs)', () => {
  it("org A's admin never sees org B's sellers, folios, drops, or payouts", async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    const { userId: agentB } = await seedUser({
      email: 'agent-b@empresa.com',
      role: 'agent',
      organizationId: orgB.organizationId,
    })
    await seedFolio({ organizationId: orgB.organizationId, agentId: agentB, amountPaid: 999000, commissionAmount: 10000 })
    await seedDrop({ organizationId: orgB.organizationId, agentId: agentB, amount: 5000 })
    await seedPayout({ organizationId: orgB.organizationId, agentId: agentB, amount: 3000, createdBy: orgB.adminUserId })

    const body = (await (await getReport(WINDOW, orgA.adminEmail)).json()) as ReportBody
    expect(body.sellers).toHaveLength(0)
    expect(body.totals.sales_total).toBe(0)

    // And org B's admin DOES see org B's data.
    const bodyB = (await (await getReport(WINDOW, orgB.adminEmail)).json()) as ReportBody
    expect(bodyB.sellers.find((s) => s.seller_id === agentB)).toBeDefined()
  })
})
