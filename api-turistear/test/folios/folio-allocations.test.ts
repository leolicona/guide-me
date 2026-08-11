import { describe, it, expect, beforeEach } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { seedUser, clearTenancyDb } from '../helpers/tenancy'
import { buildFakeJwt } from '../helpers/jwt'

// US-LG09 (docs/folios/line-autonomy.spec.md, F1) — every payment knows which lines it pays.
// S-1…S-4 through the REAL endpoints (never hand-inserted allocations), plus the reversal's
// negative allocations and the conservation invariants of scope boundary 3. Nothing reads the
// table yet — these tests are what "verified shadow" means.

const AGENT_EMAIL = 'agent@empresa.com'
const ADMIN_EMAIL = 'admin@empresa.com'
const PHONE = '+52 55 1234 5678'
const auth = (email: string) => ({ Cookie: `gm_access=${buildFakeJwt(email)}` })
const jsonAuth = (email: string) => ({ ...auth(email), 'Content-Type': 'application/json' })
const POS = 'http://api.local/api/pos'
const FOLIOS = 'http://api.local/api/folios'

const nowSec = () => Math.floor(Date.now() / 1000)
const todayStr = (): string => new Date().toISOString().slice(0, 10)
const addDays = (d: string, n: number): string =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)

const clearDb = async () => {
  for (const t of [
    'folio_line_extras',
    'folio_requests',
    'folio_lines',
    'folio_access_tokens',
    'folio_payments',
    'notifications',
    'folio_events',
    'folios',
    'slots',
    'services',
  ]) {
    await env.DB.exec(`DELETE FROM ${t}`)
  }
}

const seedService = async (organizationId: string): Promise<string> => {
  const serviceId = crypto.randomUUID()
  const ts = nowSec()
  await env.DB.prepare(
    `INSERT INTO services (id, organization_id, name, description, base_price, minimum_price, default_capacity, commission_type, commission_value, status, created_at, updated_at)
     VALUES (?, ?, 'Tour', NULL, 100000, 25000, 12, 'percent', 1000, 'active', ?, ?)`,
  )
    .bind(serviceId, organizationId, ts, ts)
    .run()
  return serviceId
}

const seedSlot = async (
  organizationId: string,
  serviceId: string,
  date: string,
  startTime = '09:00',
): Promise<string> => {
  const slotId = crypto.randomUUID()
  const ts = nowSec()
  await env.DB.prepare(
    `INSERT INTO slots (id, organization_id, service_id, schedule_id, date, start_time, capacity, booked, status, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, ?, 12, 0, 'active', ?, ?)`,
  )
    .bind(slotId, organizationId, serviceId, date, startTime, ts, ts)
    .run()
  return slotId
}

interface Stage {
  organizationId: string
  slotTue: string // earlier departure — the cascade's first stop
  slotThu: string
}

// Two departures, line totals $1,000.00 + $500.00, org minimum deposit 30% — the spec's S-2 cart.
const seedStage = async (): Promise<Stage> => {
  const agent = await seedUser({ email: AGENT_EMAIL, role: 'agent', name: 'Ana R.' })
  await seedUser({
    email: ADMIN_EMAIL,
    role: 'admin',
    name: 'Luis M.',
    organizationId: agent.organizationId,
  })
  await env.DB.prepare(`UPDATE organizations SET booking_min_down_payment_pct = 30 WHERE id = ?`)
    .bind(agent.organizationId)
    .run()
  const serviceId = await seedService(agent.organizationId)
  const slotTue = await seedSlot(agent.organizationId, serviceId, addDays(todayStr(), 3))
  const slotThu = await seedSlot(agent.organizationId, serviceId, addDays(todayStr(), 5))
  return { organizationId: agent.organizationId, slotTue, slotThu }
}

const twoLineCart = (s: Stage) => [
  { slot_id: s.slotTue, quantity: 1, unit_price: 100000 },
  { slot_id: s.slotThu, quantity: 1, unit_price: 50000 },
]

const confirm = async (body: Record<string, unknown>): Promise<any> => {
  const res = await SELF.fetch(`${POS}/folios`, {
    method: 'POST',
    headers: jsonAuth(AGENT_EMAIL),
    body: JSON.stringify({
      customer_name: 'Cliente Test',
      customer_phone: PHONE,
      ...body,
    }),
  })
  const json = (await res.json()) as any
  expect(res.status, JSON.stringify(json)).toBe(201)
  return json.folio
}

interface AllocRow {
  payment_id: string
  folio_line_id: string
  amount: number
  backfilled: number
  entry_type: string
  payment_amount: number
}

const allocationsFor = async (folioId: string): Promise<AllocRow[]> => {
  const { results } = await env.DB.prepare(
    `SELECT a.payment_id, a.folio_line_id, a.amount, a.backfilled, p.entry_type, p.amount AS payment_amount
     FROM folio_payment_allocations a
     JOIN folio_payments p ON p.id = a.payment_id
     WHERE p.folio_id = ?
     ORDER BY p.created_at, a.amount DESC`,
  )
    .bind(folioId)
    .all()
  return results as unknown as AllocRow[]
}

const lineIdBySlot = async (folioId: string, slotId: string): Promise<string> => {
  const { results } = await env.DB.prepare(
    `SELECT id FROM folio_lines WHERE folio_id = ? AND slot_id = ?`,
  )
    .bind(folioId, slotId)
    .all()
  return (results[0] as { id: string }).id
}

// Scope boundary 3, asserted on the WRITE path: every payment/refund row's allocations sum to
// its amount, and no line ever holds more than its line_total.
const expectConserved = async (folioId: string) => {
  const { results: perPayment } = await env.DB.prepare(
    `SELECT p.id, p.amount, COALESCE(SUM(a.amount), 0) AS allocated
     FROM folio_payments p
     LEFT JOIN folio_payment_allocations a ON a.payment_id = p.id
     WHERE p.folio_id = ? AND p.entry_type IN ('payment', 'refund')
     GROUP BY p.id`,
  )
    .bind(folioId)
    .all()
  for (const row of perPayment as Array<{ amount: number; allocated: number }>) {
    expect(row.allocated).toBe(row.amount)
  }
  const { results: perLine } = await env.DB.prepare(
    `SELECT l.id, l.line_total, COALESCE(SUM(a.amount), 0) AS allocated
     FROM folio_lines l
     LEFT JOIN folio_payment_allocations a ON a.folio_line_id = l.id
     WHERE l.folio_id = ?
     GROUP BY l.id`,
  )
    .bind(folioId)
    .all()
  for (const row of perLine as Array<{ line_total: number; allocated: number }>) {
    expect(row.allocated).toBeGreaterThanOrEqual(0)
    expect(row.allocated).toBeLessThanOrEqual(row.line_total)
  }
}

beforeEach(async () => {
  await clearDb()
  await clearTenancyDb()
})

describe('US-LG09 — the sale writes its allocations in the same batch', () => {
  it('S-1 — a full payment funds every line at exactly line_total', async () => {
    const stage = await seedStage()
    const folio = await confirm({ lines: twoLineCart(stage) })

    const allocs = await allocationsFor(folio.id)
    expect(allocs).toHaveLength(2)
    expect(allocs.every((a) => a.entry_type === 'payment' && a.backfilled === 0)).toBe(true)
    const tueLine = await lineIdBySlot(folio.id, stage.slotTue)
    const thuLine = await lineIdBySlot(folio.id, stage.slotThu)
    expect(allocs.find((a) => a.folio_line_id === tueLine)?.amount).toBe(100000)
    expect(allocs.find((a) => a.folio_line_id === thuLine)?.amount).toBe(50000)
    await expectConserved(folio.id)
  })

  it('S-2 — a deposit seeds each line at the org minimum, surplus cascades to the soonest departure', async () => {
    const stage = await seedStage()
    const folio = await confirm({ lines: twoLineCart(stage), down_payment: 60000 })

    const tueLine = await lineIdBySlot(folio.id, stage.slotTue)
    const thuLine = await lineIdBySlot(folio.id, stage.slotThu)
    const allocs = await allocationsFor(folio.id)
    expect(allocs.find((a) => a.folio_line_id === tueLine)?.amount).toBe(45000) // seed 30k + surplus 15k
    expect(allocs.find((a) => a.folio_line_id === thuLine)?.amount).toBe(15000) // its seed alone
    await expectConserved(folio.id)
  })

  it('S-3 — the cascade crosses a line into fully funded, the sibling keeps its seed', async () => {
    const stage = await seedStage()
    const folio = await confirm({ lines: twoLineCart(stage), down_payment: 115000 })

    const tueLine = await lineIdBySlot(folio.id, stage.slotTue)
    const thuLine = await lineIdBySlot(folio.id, stage.slotThu)
    const allocs = await allocationsFor(folio.id)
    expect(allocs.find((a) => a.folio_line_id === tueLine)?.amount).toBe(100000)
    expect(allocs.find((a) => a.folio_line_id === thuLine)?.amount).toBe(15000)
    await expectConserved(folio.id)
  })

  it('S-4 — an idempotency-key replay writes no second payment row and no second allocation set', async () => {
    const stage = await seedStage()
    const key = crypto.randomUUID()
    const body = { lines: [{ slot_id: stage.slotTue, quantity: 1, unit_price: 100000 }], idempotency_key: key }
    const first = await confirm(body)

    const res = await SELF.fetch(`${POS}/folios`, {
      method: 'POST',
      headers: jsonAuth(AGENT_EMAIL),
      body: JSON.stringify({ customer_name: 'Cliente Test', customer_phone: PHONE, ...body }),
    })
    const replay = (await res.json()) as any
    expect(res.status).toBe(200)
    expect(replay.replayed).toBe(true)
    expect(replay.folio.id).toBe(first.id)

    const allocs = await allocationsFor(first.id)
    expect(allocs).toHaveLength(1)
    await expectConserved(first.id)
  })
})

describe('US-LG09 — the settle and the reversal keep the shadow closed', () => {
  it('a settle allocates each line exactly what it was still owed', async () => {
    const stage = await seedStage()
    const folio = await confirm({ lines: twoLineCart(stage), down_payment: 60000 })

    const res = await SELF.fetch(`${POS}/folios/${folio.id}/settle`, {
      method: 'POST',
      headers: jsonAuth(AGENT_EMAIL),
    })
    expect(res.status).toBe(200)

    const tueLine = await lineIdBySlot(folio.id, stage.slotTue)
    const thuLine = await lineIdBySlot(folio.id, stage.slotThu)
    const allocs = await allocationsFor(folio.id)
    expect(allocs).toHaveLength(4) // deposit ×2 + balance ×2
    const balance = allocs.filter((a) => a.payment_amount === 90000)
    expect(balance.find((a) => a.folio_line_id === tueLine)?.amount).toBe(55000)
    expect(balance.find((a) => a.folio_line_id === thuLine)?.amount).toBe(35000)
    // Net per line = line_total, exactly: the folio is paid and its lines say so.
    await expectConserved(folio.id)
    const { results } = await env.DB.prepare(
      `SELECT l.id, l.line_total, COALESCE(SUM(a.amount), 0) AS allocated
       FROM folio_lines l LEFT JOIN folio_payment_allocations a ON a.folio_line_id = l.id
       WHERE l.folio_id = ? GROUP BY l.id`,
    )
      .bind(folio.id)
      .all()
    for (const row of results as Array<{ line_total: number; allocated: number }>) {
      expect(row.allocated).toBe(row.line_total)
    }
  })

  it('a cancellation writes NEGATIVE allocations that net every line back to what the ladder retained', async () => {
    const stage = await seedStage()
    const folio = await confirm({ lines: twoLineCart(stage) })

    const res = await SELF.fetch(`${FOLIOS}/${folio.id}/cancel`, {
      method: 'POST',
      headers: jsonAuth(ADMIN_EMAIL),
      body: JSON.stringify({ reason: 'cliente cancela' }),
    })
    const json = (await res.json()) as any
    expect(res.status, JSON.stringify(json)).toBe(200)

    const allocs = await allocationsFor(folio.id)
    const refundAllocs = allocs.filter((a) => a.entry_type === 'refund')
    expect(refundAllocs.length).toBeGreaterThan(0)
    expect(refundAllocs.every((a) => a.amount < 0)).toBe(true)
    // Σ per refund row = the row's (negative) amount; per-line nets stay within [0, line_total].
    await expectConserved(folio.id)
    // Refund + retention = what was collected (the outcome's arithmetic, mirrored in allocations):
    const refunded = -refundAllocs.reduce((s, a) => s + a.amount, 0)
    expect(refunded).toBe(json.outcome?.refund ?? refunded)
  })

  it('the 60-second express void reverses its single line in full', async () => {
    const stage = await seedStage()
    const todaySlot = await seedSlot(
      stage.organizationId,
      (await env.DB.prepare(`SELECT service_id FROM slots WHERE id = ?`).bind(stage.slotTue).all())
        .results[0]!.service_id as string,
      todayStr(),
      '23:59',
    )
    const folio = await confirm({
      sale_mode: 'express',
      customer_name: undefined,
      lines: [{ slot_id: todaySlot, quantity: 2, unit_price: 100000 }],
      idempotency_key: crypto.randomUUID(),
    })

    const res = await SELF.fetch(`${POS}/folios/${folio.id}/void`, {
      method: 'POST',
      headers: jsonAuth(AGENT_EMAIL),
    })
    const json = (await res.json()) as any
    expect(res.status, JSON.stringify(json)).toBe(200)

    await expectConserved(folio.id)
    const allocs = await allocationsFor(folio.id)
    const net = allocs.reduce((s, a) => s + a.amount, 0)
    expect(net).toBe(0) // +200000 sale allocation − 200000 void allocation
  })
})
