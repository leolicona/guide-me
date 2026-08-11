import { describe, it, expect, beforeEach } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { seedUser, seedTwoOrgs, clearTenancyDb } from '../helpers/tenancy'
import { buildFakeJwt } from '../helpers/jwt'
import { sweepExpiredBookings } from '../../src/routes/pos/sweep'

// US-AG54 (docs/folios/line-autonomy.spec.md, F3) — the gesture: collect and settle per line.
// S-8 (settle one line only) · S-9 (one clock fires, one line dies) · S-10 (an unverified
// transfer blocks only its lines' QR) + cross-org. Everything through the real endpoints.

const AGENT_EMAIL = 'agent@empresa.com'
const PHONE = '+52 55 1234 5678'
const auth = (email: string) => ({ Cookie: `gm_access=${buildFakeJwt(email)}` })
const jsonAuth = (email: string) => ({ ...auth(email), 'Content-Type': 'application/json' })
const POS = 'http://api.local/api/pos'

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
): Promise<string> => {
  const slotId = crypto.randomUUID()
  const ts = nowSec()
  await env.DB.prepare(
    `INSERT INTO slots (id, organization_id, service_id, schedule_id, date, start_time, capacity, booked, status, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, '09:00', 12, 0, 'active', ?, ?)`,
  )
    .bind(slotId, organizationId, serviceId, date, ts, ts)
    .run()
  return slotId
}

interface Stage {
  organizationId: string
  slotNear: string // +3d
  slotFar: string // +10d
}

// Org minimum 30%, lines $1,000 (near) + $500 (far) — the spec's S-2 cart, held as an apartado
// with a $600 deposit: seeds 300/150, surplus 150 → near, so near holds 450 and far 150.
const seedStage = async (): Promise<Stage> => {
  const agent = await seedUser({ email: AGENT_EMAIL, role: 'agent', name: 'Ana R.' })
  await env.DB.prepare(`UPDATE organizations SET booking_min_down_payment_pct = 30 WHERE id = ?`)
    .bind(agent.organizationId)
    .run()
  const serviceId = await seedService(agent.organizationId)
  const slotNear = await seedSlot(agent.organizationId, serviceId, addDays(todayStr(), 3))
  const slotFar = await seedSlot(agent.organizationId, serviceId, addDays(todayStr(), 10))
  return { organizationId: agent.organizationId, slotNear, slotFar }
}

const createBooking = async (stage: Stage, deposit = 60000): Promise<any> => {
  const res = await SELF.fetch(`${POS}/folios`, {
    method: 'POST',
    headers: jsonAuth(AGENT_EMAIL),
    body: JSON.stringify({
      customer_name: 'Cliente Test',
      customer_phone: PHONE,
      down_payment: deposit,
      lines: [
        { slot_id: stage.slotNear, quantity: 1, unit_price: 100000 },
        { slot_id: stage.slotFar, quantity: 1, unit_price: 50000 },
      ],
    }),
  })
  const json = (await res.json()) as any
  expect(res.status, JSON.stringify(json)).toBe(201)
  return json.folio
}

const lineBySlot = (folio: any, slotId: string) =>
  folio.lines.find((l: any) => l.slot_id === slotId)

const settleLine = async (folioId: string, lineId: string, body?: Record<string, unknown>) => {
  const res = await SELF.fetch(`${POS}/folios/${folioId}/lines/${lineId}/settle`, {
    method: 'POST',
    headers: jsonAuth(AGENT_EMAIL),
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  return { status: res.status, json: (await res.json().catch(() => null)) as any }
}

const dbFolio = async (folioId: string) =>
  (await env.DB.prepare(`SELECT * FROM folios WHERE id = ?`).bind(folioId).all())
    .results[0] as Record<string, unknown>

const dbLine = async (lineId: string) =>
  (await env.DB.prepare(`SELECT * FROM folio_lines WHERE id = ?`).bind(lineId).all())
    .results[0] as Record<string, unknown>

const slotBooked = async (slotId: string): Promise<number> =>
  ((await env.DB.prepare(`SELECT booked FROM slots WHERE id = ?`).bind(slotId).all())
    .results[0] as { booked: number }).booked

beforeEach(async () => {
  await clearDb()
  await clearTenancyDb()
})

describe('US-AG54 — S-8: settle one line only', () => {
  it("collects the line's remaining, signs ITS QR, and leaves the sibling apartada", async () => {
    const stage = await seedStage()
    const folio = await createBooking(stage)
    const near = lineBySlot(folio, stage.slotNear)
    const far = lineBySlot(folio, stage.slotFar)

    const { status, json } = await settleLine(folio.id, near.id)
    expect(status, JSON.stringify(json)).toBe(200)

    // The near line completed: full allocation, its own QR; the far one untouched, no QR.
    const nearRow = await dbLine(near.id)
    const farRow = await dbLine(far.id)
    expect(nearRow.qr_token).not.toBeNull()
    expect(farRow.qr_token).toBeNull()

    const f = await dbFolio(folio.id)
    expect(f.status).toBe('booking') // the far line still owes — the folio is NOT paid
    expect(f.amount_paid).toBe(115000) // 60,000 deposit + the near line's 55,000 remainder
    expect(f.settled_at).toBeNull()

    // The response's per-line reading says the same thing the columns do.
    const nearOut = json.folio.lines.find((l: any) => l.id === near.id)
    const farOut = json.folio.lines.find((l: any) => l.id === far.id)
    expect(nearOut.money_state).toBe('paid')
    expect(nearOut.pending_balance).toBe(0)
    expect(farOut.money_state).toBe('booking')
    expect(farOut.pending_balance).toBe(35000)
  })

  it('settling the LAST live line completes the folio (paid + settled_at)', async () => {
    const stage = await seedStage()
    const folio = await createBooking(stage)
    const near = lineBySlot(folio, stage.slotNear)
    const far = lineBySlot(folio, stage.slotFar)

    expect((await settleLine(folio.id, near.id)).status).toBe(200)
    expect((await settleLine(folio.id, far.id)).status).toBe(200)

    const f = await dbFolio(folio.id)
    expect(f.status).toBe('paid')
    expect(f.amount_paid).toBe(150000)
    expect(f.settled_at).not.toBeNull()
    // Full commission arrived with the completions: 10% of 150,000.
    expect(f.commission_amount).toBe(15000)

    // Re-settling a paid line is a 409, not a second charge.
    const again = await settleLine(folio.id, near.id)
    expect(again.status).toBe(409)
  })
})

describe('US-AG54 — S-9: one clock fires, one line dies', () => {
  it('the sweep cancels only the expired line; the sibling keeps its hold and its clock', async () => {
    const stage = await seedStage()
    const folio = await createBooking(stage)
    const near = lineBySlot(folio, stage.slotNear)
    const far = lineBySlot(folio, stage.slotFar)

    // Simulate elapsed time for the NEAR line only: its departure arrives (grace reached) and its
    // own clock passes; the folio's MIN clock follows. The far line's clock stays in the future.
    const nowIso = new Date()
    await env.DB.prepare(
      `UPDATE folio_lines SET slot_date = ?, slot_start_time = ?, booking_expires_at = ? WHERE id = ?`,
    )
      .bind(nowIso.toISOString().slice(0, 10), nowIso.toISOString().slice(11, 16), nowSec() - 60, near.id)
      .run()
    await env.DB.prepare(`UPDATE folios SET booking_expires_at = ? WHERE id = ?`)
      .bind(nowSec() - 60, folio.id)
      .run()

    const result = await sweepExpiredBookings(env)
    expect(result.failed).toBe(0)
    expect(result.cancelled).toBe(1)

    const nearRow = await dbLine(near.id)
    const farRow = await dbLine(far.id)
    expect(nearRow.cancelled_at).not.toBeNull()
    expect(nearRow.cancellation_source).toBe('system_expiry')
    expect(farRow.cancelled_at).toBeNull()

    // The folio LIVES: still a booking, its clock re-rolled to the surviving line's own.
    const f = await dbFolio(folio.id)
    expect(f.status).toBe('booking')
    expect(f.booking_expires_at).toBe(farRow.booking_expires_at)

    // Only the near line's seats went back.
    expect(await slotBooked(stage.slotNear)).toBe(0)
    expect(await slotBooked(stage.slotFar)).toBe(1)

    // No cash debt from a clock-produced close (US-A87): the terminal tier retained everything.
    expect(f.refund_status).toBe('none')
    expect(f.refund_pin).toBeNull()

    // US-T09, line-scoped (D13): the close announced for THAT line.
    const { results: outbox } = await env.DB.prepare(
      `SELECT folio_line_id, channel FROM notifications WHERE folio_id = ? AND event = 'booking_expired'`,
    )
      .bind(folio.id)
      .all()
    expect((outbox as any[]).length).toBe(2) // whatsapp + email, one line
    expect((outbox as any[]).every((r) => r.folio_line_id === near.id)).toBe(true)

    // And the survivor still settles normally afterwards.
    const settle = await settleLine(folio.id, far.id)
    expect(settle.status).toBe(200)
    expect((await dbFolio(folio.id)).status).toBe('paid')
  })
})

describe('US-AG54 — S-10: an unverified transfer blocks only its line', () => {
  it('a transfer line-settle completes the line but defers ITS QR; the cash sibling keeps its QR', async () => {
    const stage = await seedStage()
    const folio = await createBooking(stage)
    const near = lineBySlot(folio, stage.slotNear)
    const far = lineBySlot(folio, stage.slotFar)

    // Near settles in cash → its QR mints now.
    expect((await settleLine(folio.id, near.id)).status).toBe(200)
    expect((await dbLine(near.id)).qr_token).not.toBeNull()

    // Far settles by transfer → fully allocated, but no QR until an admin verifies (US-A67).
    const transfer = await settleLine(folio.id, far.id, {
      method: 'transfer',
      payment_reference: 'REF-12345',
    })
    expect(transfer.status, JSON.stringify(transfer.json)).toBe(200)
    const farRow = await dbLine(far.id)
    expect(farRow.qr_token).toBeNull()

    const f = await dbFolio(folio.id)
    expect(f.status).toBe('paid')
    expect(f.payment_verification).toBe('pending')
    // The cash sibling's QR is untouched by the pending transfer.
    expect((await dbLine(near.id)).qr_token).not.toBeNull()
  })
})

describe('Multitenancy isolation', () => {
  it("another org's line settle and cancel are 404 — never 403", async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    const serviceB = await seedService(orgB.organizationId)
    const slotB = await seedSlot(orgB.organizationId, serviceB, addDays(todayStr(), 10))
    const res = await SELF.fetch(`${POS}/folios`, {
      method: 'POST',
      headers: jsonAuth(orgB.adminEmail),
      body: JSON.stringify({
        customer_name: 'B',
        customer_phone: PHONE,
        down_payment: 30000,
        lines: [{ slot_id: slotB, quantity: 1, unit_price: 100000 }],
      }),
    })
    const folioB = ((await res.json()) as any).folio
    expect(res.status).toBe(201)
    const lineB = folioB.lines[0].id

    for (const verb of ['settle', 'cancel']) {
      const cross = await SELF.fetch(`${POS}/folios/${folioB.id}/lines/${lineB}/${verb}`, {
        method: 'POST',
        headers: jsonAuth(orgA.adminEmail),
        body: '{}',
      })
      expect(cross.status, verb).toBe(404)
    }
  })
})
