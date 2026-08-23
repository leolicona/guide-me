import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { seedUser, clearTenancyDb } from '../helpers/tenancy'
import { buildFakeJwt } from '../helpers/jwt'

// Bounded drop reads — `docs/cash-drops/caja-surface-parity.spec.md` D12′.
//
// D12 originally claimed the caja payload was "bounded by construction". It is not: the settlement
// watermark bounds the balance DERIVATION and the `expenses` read, but `drops` had neither a LIMIT
// nor a `since`, so `GET /api/cash/me` shipped an agent's ENTIRE hand-in history — measured at
// 386 bytes per row — on every mount and every window focus.
//
// Both reads now fetch ONE extra row and slice it off, so the response can SAY it capped. A silent
// truncation reads as "everything is here" when it is not.

const ADMIN_EMAIL = 'admin@empresa.com'
const AGENT_EMAIL = 'agent@empresa.com'

const auth = (email: string) => ({ Cookie: `gm_access=${buildFakeJwt(email)}` })
const CASH = 'http://api.local/api/cash'
const nowSec = () => Math.floor(Date.now() / 1000)

const seedOrgWithStaff = async () => {
  const admin = await seedUser({ email: ADMIN_EMAIL, role: 'admin' })
  const agent = await seedUser({
    organizationId: admin.organizationId,
    email: AGENT_EMAIL,
    role: 'agent',
  })
  return {
    organizationId: admin.organizationId,
    adminId: admin.userId,
    agentId: agent.userId,
  }
}

const seedDrops = async (opts: {
  organizationId: string
  agentId: string
  count: number
  status?: 'pending' | 'confirmed' | 'rejected'
  acknowledgment?: string
  reviewedBy?: string | null
  reviewedAt?: number | null
  from?: number
}) => {
  const base = opts.from ?? nowSec()
  const ids: string[] = []
  for (let i = 0; i < opts.count; i++) {
    const id = crypto.randomUUID()
    ids.push(id)
    await env.DB.prepare(
      `INSERT INTO cash_drops
         (id, organization_id, agent_id, amount, balance_before, status, acknowledgment,
          reviewed_by, reviewed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        opts.organizationId,
        opts.agentId,
        1000 + i,
        0,
        opts.status ?? 'pending',
        opts.acknowledgment ?? 'not_required',
        opts.reviewedBy ?? null,
        opts.reviewedAt ?? null,
        base - opts.count + i, // oldest first, so `desc(created_at)` puts the last one on top
        base,
      )
      .run()
  }
  return ids
}

const getMyBalance = async (email: string) => {
  const res = await SELF.fetch(`${CASH}/me`, { headers: auth(email) })
  return { status: res.status, json: (await res.json()) as any }
}

const listDrops = async (email: string, qs = '') => {
  const res = await SELF.fetch(`${CASH}/drops${qs}`, { headers: auth(email) })
  return { status: res.status, json: (await res.json()) as any }
}

beforeEach(async () => {
  await env.DB.exec('DELETE FROM cash_drops')
  await env.DB.exec('DELETE FROM agent_expenses')
  await clearTenancyDb()
})
afterEach(() => vi.restoreAllMocks())

describe('GET /api/cash/me — the agent’s own hand-in history is capped', () => {
  it('ships at most 50 rows and says it capped', async () => {
    const { organizationId, agentId } = await seedOrgWithStaff()
    await seedDrops({ organizationId, agentId, count: 60 })

    const { status, json } = await getMyBalance(AGENT_EMAIL)
    expect(status).toBe(200)
    expect(json.balance.drops).toHaveLength(50)
    expect(json.balance.drops_truncated).toBe(true)
  })

  it('keeps the newest, not an arbitrary 50', async () => {
    const { organizationId, agentId } = await seedOrgWithStaff()
    await seedDrops({ organizationId, agentId, count: 60 })

    const { json } = await getMyBalance(AGENT_EMAIL)
    const amounts: number[] = json.balance.drops.map((d: any) => d.amount)
    // Seeded 1000…1059 oldest-first; newest-first means the top row is the largest.
    expect(amounts[0]).toBe(1059)
    expect(Math.min(...amounts)).toBe(1010)
  })

  it('says nothing was capped when nothing was', async () => {
    const { organizationId, agentId } = await seedOrgWithStaff()
    await seedDrops({ organizationId, agentId, count: 3 })

    const { json } = await getMyBalance(AGENT_EMAIL)
    expect(json.balance.drops).toHaveLength(3)
    expect(json.balance.drops_truncated).toBe(false)
  })

  it('reports exactly 50 as NOT truncated', async () => {
    const { organizationId, agentId } = await seedOrgWithStaff()
    await seedDrops({ organizationId, agentId, count: 50 })

    const { json } = await getMyBalance(AGENT_EMAIL)
    expect(json.balance.drops).toHaveLength(50)
    expect(json.balance.drops_truncated).toBe(false)
  })

  // The trap in D12′, and the reason the signature queue is now its own query. `pending_acknowledgments`
  // used to be FILTERED OUT of the same array; capping that array would have dropped an obligation
  // off the 51st row — silently, and on the one thing in this payload that is an obligation rather
  // than a record. Someone would simply never be asked to sign.
  it('never loses a signature obligation that falls past the cap', async () => {
    const { organizationId, adminId, agentId } = await seedOrgWithStaff()
    const t = nowSec()
    // The obligation is the OLDEST row: 60 newer drops bury it well beyond the 50-row window.
    await seedDrops({
      organizationId,
      agentId,
      count: 1,
      status: 'confirmed',
      acknowledgment: 'pending',
      reviewedBy: adminId,
      reviewedAt: t - 60,
      from: t - 1000,
    })
    await seedDrops({ organizationId, agentId, count: 60, from: t })

    const { json } = await getMyBalance(AGENT_EMAIL)
    expect(json.balance.drops).toHaveLength(50)
    expect(json.balance.drops_truncated).toBe(true)
    // The buried obligation is absent from the visible list…
    expect(json.balance.drops.some((d: any) => d.acknowledgment === 'pending')).toBe(false)
    // …and still owed.
    expect(json.balance.pending_acknowledgments).toHaveLength(1)
    expect(json.balance.pending_acknowledgments_count).toBe(1)
  })

  // The effective view still decides: a window that has elapsed reads as `auto_signed` and owes
  // nothing, whatever the stored column says.
  it('does not resurrect an obligation whose window has elapsed', async () => {
    const { organizationId, adminId, agentId } = await seedOrgWithStaff()
    await seedDrops({
      organizationId,
      agentId,
      count: 1,
      status: 'confirmed',
      acknowledgment: 'pending',
      reviewedBy: adminId,
      reviewedAt: nowSec() - 60 * 60 * 24 * 365,
    })

    const { json } = await getMyBalance(AGENT_EMAIL)
    expect(json.balance.pending_acknowledgments).toHaveLength(0)
  })
})

describe('GET /api/cash/drops — the team’s history is capped at 500', () => {
  it('says nothing was capped for an ordinary org', async () => {
    const { organizationId, agentId } = await seedOrgWithStaff()
    await seedDrops({ organizationId, agentId, count: 5 })

    const { status, json } = await listDrops(ADMIN_EMAIL, '?status=all')
    expect(status).toBe(200)
    expect(json.drops).toHaveLength(5)
    expect(json.truncated).toBe(false)
  })

  it('still answers a filtered read', async () => {
    const { organizationId, adminId, agentId } = await seedOrgWithStaff()
    await seedDrops({ organizationId, agentId, count: 3, status: 'pending' })
    await seedDrops({
      organizationId,
      agentId,
      count: 2,
      status: 'confirmed',
      reviewedBy: adminId,
      reviewedAt: nowSec(),
    })

    const { json } = await listDrops(ADMIN_EMAIL, '?status=pending')
    expect(json.drops).toHaveLength(3)
    expect(json.truncated).toBe(false)
  })
})
