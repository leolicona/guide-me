import { describe, it, expect, beforeEach } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { seedUser, seedTwoOrgs, clearTenancyDb } from '../helpers/tenancy'
import { buildFakeJwt } from '../helpers/jwt'

// US-A22 (docs/folios/line-autonomy.spec.md, F2) — cancel one line, the rest untouched.
// S-5 (the sibling survives byte-identical) · S-6 (two debts, two records, two notifications) ·
// S-7 (the PIN rotates between handshakes) · S-14 (another org's line is invisible). Everything
// through the REAL endpoints; the ladder in force is the inherited default (US-A76): 5+ days out
// refunds 100% (commission clawed back), inside that 50%.

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
  slotNear: string // +3d — inside the graded ladder's 50% tier
  slotFar: string // +10d — 100% refund tier
}

const seedStage = async (): Promise<Stage> => {
  const agent = await seedUser({ email: AGENT_EMAIL, role: 'agent', name: 'Ana R.' })
  await seedUser({
    email: ADMIN_EMAIL,
    role: 'admin',
    name: 'Luis M.',
    organizationId: agent.organizationId,
  })
  const serviceId = await seedService(agent.organizationId)
  const slotNear = await seedSlot(agent.organizationId, serviceId, addDays(todayStr(), 3))
  const slotFar = await seedSlot(agent.organizationId, serviceId, addDays(todayStr(), 10))
  return { organizationId: agent.organizationId, slotNear, slotFar }
}

// Two lines: $1,000.00 on the near departure, $500.00 on the far one, paid in full.
const confirmPaid = async (stage: Stage): Promise<any> => {
  const res = await SELF.fetch(`${POS}/folios`, {
    method: 'POST',
    headers: jsonAuth(AGENT_EMAIL),
    body: JSON.stringify({
      customer_name: 'Cliente Test',
      customer_email: 'cliente@example.com',
      customer_phone: PHONE,
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

const cancelLine = async (folioId: string, lineId: string, email = ADMIN_EMAIL) => {
  const res = await SELF.fetch(`${FOLIOS}/${folioId}/lines/${lineId}/cancel`, {
    method: 'POST',
    headers: jsonAuth(email),
    body: JSON.stringify({ reason: 'cliente cancela una actividad' }),
  })
  return { status: res.status, json: (await res.json().catch(() => null)) as any }
}

const dbLine = async (lineId: string) => {
  const { results } = await env.DB.prepare(`SELECT * FROM folio_lines WHERE id = ?`)
    .bind(lineId)
    .all()
  return results[0] as Record<string, unknown>
}

const dbFolio = async (folioId: string) => {
  const { results } = await env.DB.prepare(`SELECT * FROM folios WHERE id = ?`)
    .bind(folioId)
    .all()
  return results[0] as Record<string, unknown>
}

const slotBooked = async (slotId: string): Promise<number> => {
  const { results } = await env.DB.prepare(`SELECT booked FROM slots WHERE id = ?`)
    .bind(slotId)
    .all()
  return (results[0] as { booked: number }).booked
}

const lineBySlot = (folio: any, slotId: string) =>
  folio.lines.find((l: any) => l.slot_id === slotId)

// Scope boundary 3 — every payment/refund row's allocations sum to its amount.
const expectConserved = async (folioId: string) => {
  const { results } = await env.DB.prepare(
    `SELECT p.id, p.amount, COALESCE(SUM(a.amount), 0) AS allocated
     FROM folio_payments p LEFT JOIN folio_payment_allocations a ON a.payment_id = p.id
     WHERE p.folio_id = ? AND p.entry_type IN ('payment', 'refund') GROUP BY p.id`,
  )
    .bind(folioId)
    .all()
  for (const row of results as Array<{ amount: number; allocated: number }>) {
    expect(row.allocated).toBe(row.amount)
  }
}

beforeEach(async () => {
  await clearDb()
  await clearTenancyDb()
})

describe('US-A22 — S-5: the sibling survives byte-identical', () => {
  it('cancels the far line only: its seats release, its money reverses, the folio stays paid', async () => {
    const stage = await seedStage()
    const folio = await confirmPaid(stage)
    const nearLine = lineBySlot(folio, stage.slotNear)
    const farLine = lineBySlot(folio, stage.slotFar)
    const nearBefore = await dbLine(nearLine.id)

    const { status, json } = await cancelLine(folio.id, farLine.id)
    expect(status, JSON.stringify(json)).toBe(200)

    // The far line (+10d → 100% refund tier): full refund of its $500, commission clawed back.
    expect(json.cancellation.refund).toBe(50000)
    expect(json.cancellation.reversed_commission).toBe(5000)

    // Its seats went back; the near line's did not move.
    expect(await slotBooked(stage.slotFar)).toBe(0)
    expect(await slotBooked(stage.slotNear)).toBe(1)

    // The line records its own life; the folio does NOT flip — the near line is alive.
    const far = await dbLine(farLine.id)
    expect(far.cancelled_at).not.toBeNull()
    expect(far.cancellation_source).toBe('admin')
    expect(far.refund_status).toBe('pending')
    expect(far.refund_amount).toBe(50000)
    const f = await dbFolio(folio.id)
    expect(f.status).toBe('paid')
    expect(f.refund_status).toBe('pending')
    expect(f.refund_amount).toBe(50000)
    expect(f.refund_pin).not.toBeNull()

    // The sibling is byte-identical.
    expect(await dbLine(nearLine.id)).toEqual(nearBefore)

    // The reversal's ledger rows: refund −50000 stamped with the line, allocations only on it.
    const { results: refunds } = await env.DB.prepare(
      `SELECT id, amount, folio_line_id FROM folio_payments WHERE folio_id = ? AND entry_type = 'refund'`,
    )
      .bind(folio.id)
      .all()
    expect(refunds).toHaveLength(1)
    expect((refunds[0] as any).amount).toBe(-50000)
    expect((refunds[0] as any).folio_line_id).toBe(farLine.id)
    const { results: refundAllocs } = await env.DB.prepare(
      `SELECT folio_line_id, amount FROM folio_payment_allocations WHERE payment_id = ?`,
    )
      .bind((refunds[0] as any).id)
      .all()
    expect(refundAllocs).toEqual([{ folio_line_id: farLine.id, amount: -50000 }])
    await expectConserved(folio.id)

    // The detail reads the line's own state.
    const detail = await SELF.fetch(`${FOLIOS}/${folio.id}`, { headers: auth(ADMIN_EMAIL) })
    const detailJson = (await detail.json()) as any
    const farOut = detailJson.folio.lines.find((l: any) => l.id === farLine.id)
    const nearOut = detailJson.folio.lines.find((l: any) => l.id === nearLine.id)
    expect(farOut.money_state).toBe('cancelled')
    expect(farOut.refund_status).toBe('pending')
    expect(nearOut.money_state).toBe('paid')
    expect(nearOut.pending_balance).toBe(0)
  })

  it('a second cancel of the same line is a 409, and a foreign line id a 404', async () => {
    const stage = await seedStage()
    const folio = await confirmPaid(stage)
    const farLine = lineBySlot(folio, stage.slotFar)

    expect((await cancelLine(folio.id, farLine.id)).status).toBe(200)
    const again = await cancelLine(folio.id, farLine.id)
    expect(again.status).toBe(409)
    expect(again.json.error?.code ?? again.json.code).toBe('LINE_ALREADY_CANCELLED')

    const missing = await cancelLine(folio.id, crypto.randomUUID())
    expect(missing.status).toBe(404)
  })
})

describe('US-A22 — the gates honour the LINE (the F2 hole, closed)', () => {
  it("the cancelled line's QR refuses CANCELLED while the sibling's still admits", async () => {
    const stage = await seedStage()
    const folio = await confirmPaid(stage)
    const nearLine = lineBySlot(folio, stage.slotNear)
    const farLine = lineBySlot(folio, stage.slotFar)
    expect((await cancelLine(folio.id, farLine.id)).status).toBe(200)

    const tokenOf = async (lineId: string) =>
      ((await env.DB.prepare(`SELECT qr_token FROM folio_lines WHERE id = ?`).bind(lineId).all())
        .results[0] as { qr_token: string }).qr_token

    const scan = async (token: string) => {
      const res = await SELF.fetch('http://api.local/api/tickets/scan', {
        method: 'POST',
        headers: jsonAuth(AGENT_EMAIL),
        body: JSON.stringify({ token }),
      })
      return (await res.json()) as any
    }

    // The half-cancelled folio is still `paid` — without the line gate this token would admit a
    // passenger whose seat already went back to the pool.
    const refused = await scan(await tokenOf(farLine.id))
    expect(refused.result).toBe('invalid')
    expect(refused.reason).toBe('CANCELLED')
    const admitted = await scan(await tokenOf(nearLine.id))
    expect(admitted.result, JSON.stringify(admitted)).toBe('valid')
  })

  it('a booking folio refuses the line cancel until F3 (LINE_CANCEL_UNSUPPORTED)', async () => {
    const stage = await seedStage()
    const res = await SELF.fetch(`${POS}/folios`, {
      method: 'POST',
      headers: jsonAuth(AGENT_EMAIL),
      body: JSON.stringify({
        customer_name: 'Cliente Test',
        customer_phone: PHONE,
        down_payment: 45000,
        lines: [
          { slot_id: stage.slotNear, quantity: 1, unit_price: 100000 },
          { slot_id: stage.slotFar, quantity: 1, unit_price: 50000 },
        ],
      }),
    })
    const booking = ((await res.json()) as any).folio
    expect(res.status).toBe(201)
    const attempt = await cancelLine(booking.id, booking.lines[0].id)
    expect(attempt.status).toBe(409)
    expect(JSON.stringify(attempt.json)).toMatch(/LINE_CANCEL_UNSUPPORTED/)
  })
})

describe('US-A22 — S-6: two debts, two records, and the folio flips only at the end', () => {
  it('cancelling both lines on separate days leaves two line-debts and four line-scoped outbox rows', async () => {
    const stage = await seedStage()
    const folio = await confirmPaid(stage)
    const nearLine = lineBySlot(folio, stage.slotNear)
    const farLine = lineBySlot(folio, stage.slotFar)

    expect((await cancelLine(folio.id, farLine.id)).status).toBe(200)
    const second = await cancelLine(folio.id, nearLine.id)
    expect(second.status).toBe(200)
    // The near line (+3d → 50% tier): half its $1,000 comes back.
    expect(second.json.cancellation.refund).toBe(50000)

    const far = await dbLine(farLine.id)
    const near = await dbLine(nearLine.id)
    expect(far.refund_status).toBe('pending')
    expect(far.refund_amount).toBe(50000)
    expect(near.refund_status).toBe('pending')
    expect(near.refund_amount).toBe(50000)

    // Folio roll-up: Σ of the pending line debts, and — both lines gone — the folio itself flips.
    const f = await dbFolio(folio.id)
    expect(f.refund_amount).toBe(100000)
    expect(f.status).toBe('cancelled')
    expect(f.cancelled_at).not.toBeNull()

    // D13 — the guard is keyed by line: the second cancellation's messages were NOT swallowed.
    const { results: outbox } = await env.DB.prepare(
      `SELECT folio_line_id, channel FROM notifications WHERE folio_id = ? AND event = 'cancellation_approved'`,
    )
      .bind(folio.id)
      .all()
    expect(outbox).toHaveLength(4) // 2 lines × (whatsapp + email)
    expect(new Set((outbox as any[]).map((r) => r.folio_line_id))).toEqual(
      new Set([farLine.id, nearLine.id]),
    )
    await expectConserved(folio.id)
  })
})

describe('US-A22 — S-7: the PIN rotates between handshakes', () => {
  it('confirming debt A consumes its PIN; debt B needs the new one', async () => {
    const stage = await seedStage()
    const folio = await confirmPaid(stage)
    const nearLine = lineBySlot(folio, stage.slotNear)
    const farLine = lineBySlot(folio, stage.slotFar)

    expect((await cancelLine(folio.id, farLine.id)).status).toBe(200)
    const pinA = (await dbFolio(folio.id)).refund_pin as string
    expect(pinA).toMatch(/^\d{6}$/)

    // Handshake A: the tourist is present, the PIN confirms, and is CONSUMED (D7).
    const confirmA = await SELF.fetch(`${FOLIOS}/${folio.id}/refund/confirm`, {
      method: 'POST',
      headers: jsonAuth(ADMIN_EMAIL),
      body: JSON.stringify({ pin: pinA }),
    })
    expect(confirmA.status).toBe(200)
    const afterA = await dbFolio(folio.id)
    expect(afterA.refund_pin).not.toBe(pinA)
    expect(afterA.refund_pin_attempts).toBe(0)
    expect((await dbLine(farLine.id)).refund_status).toBe('refunded')

    // Debt B opens later; the agent who learned pinA cannot confirm it with the tourist absent.
    expect((await cancelLine(folio.id, nearLine.id)).status).toBe(200)
    const withOldPin = await SELF.fetch(`${FOLIOS}/${folio.id}/refund/confirm`, {
      method: 'POST',
      headers: jsonAuth(ADMIN_EMAIL),
      body: JSON.stringify({ pin: pinA }),
    })
    expect(withOldPin.status).toBe(422)

    const pinB = (await dbFolio(folio.id)).refund_pin as string
    const confirmB = await SELF.fetch(`${FOLIOS}/${folio.id}/refund/confirm`, {
      method: 'POST',
      headers: jsonAuth(ADMIN_EMAIL),
      body: JSON.stringify({ pin: pinB }),
    })
    expect(confirmB.status).toBe(200)
    expect((await dbLine(nearLine.id)).refund_status).toBe('refunded')
  })
})

describe('Multitenancy isolation (S-14)', () => {
  it("another org's line is a 404 — never a 403", async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    const serviceB = await seedService(orgB.organizationId)
    const slotB = await seedSlot(orgB.organizationId, serviceB, addDays(todayStr(), 10))
    const res = await SELF.fetch(`${POS}/folios`, {
      method: 'POST',
      headers: jsonAuth(orgB.adminEmail),
      body: JSON.stringify({
        customer_name: 'B',
        customer_phone: PHONE,
        lines: [{ slot_id: slotB, quantity: 1, unit_price: 100000 }],
      }),
    })
    const folioB = ((await res.json()) as any).folio
    expect(res.status).toBe(201)

    const cross = await SELF.fetch(
      `${FOLIOS}/${folioB.id}/lines/${folioB.lines[0].id}/cancel`,
      {
        method: 'POST',
        headers: jsonAuth(orgA.adminEmail),
        body: JSON.stringify({ reason: 'x' }),
      },
    )
    expect(cross.status).toBe(404)
  })
})
