// bug: reject-rereleases-cancelled-seats — Rechazar gives back only the seats of the lines it
// cancels, once. A line cancelled earlier released its own seats; a second Rechazar, or one that
// races the first, changes nothing (constitution V). The release builder is the one D11 shares.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { stubResend } from '../helpers/auth-flows'
import { seedTwoOrgs } from '../helpers/tenancy'
import {
  PHONE,
  call,
  clearDevoladaDb,
  seedSellers,
  seedService,
  seedSlot,
  type SeededSellers,
} from '../helpers/devoladaFixtures'

let org: SeededSellers

beforeEach(async () => {
  await clearDevoladaDb()
  stubResend()
  org = await seedSellers('reject')
})
afterEach(() => vi.restoreAllMocks())

const ts = () => Math.floor(Date.now() / 1000)

const booked = async (slotId: string) =>
  (await env.DB.prepare(`SELECT booked FROM slots WHERE id = ?`).bind(slotId).first<{ booked: number }>())!.booked

const zoneBooked = async (slotId: string, zoneId: string) =>
  (await env.DB.prepare(`SELECT booked FROM slot_zones WHERE slot_id = ? AND zone_id = ?`)
    .bind(slotId, zoneId)
    .first<{ booked: number }>())!.booked

const folioRow = (folioId: string) =>
  env.DB.prepare(`SELECT cancelled_at, cancelled_by, cancellation_reason FROM folios WHERE id = ?`)
    .bind(folioId)
    .first<any>()

const rejectedEvents = async (folioId: string) =>
  (
    await env.DB.prepare(`SELECT id FROM folio_events WHERE folio_id = ? AND event_type = 'transfer_rejected'`)
      .bind(folioId)
      .all()
  ).results.length

const refundRows = async (folioId: string) =>
  (
    await env.DB.prepare(`SELECT id FROM folio_payments WHERE folio_id = ? AND entry_type = 'refund'`)
      .bind(folioId)
      .all()
  ).results.length

const linesOf = async (folioId: string) =>
  (await env.DB.prepare(`SELECT id FROM folio_lines WHERE folio_id = ? ORDER BY rowid`).bind(folioId).all<any>())
    .results.map((l) => l.id as string)

type Line = { slot_id: string; quantity: number; zone_id?: string }

const sell = async (lines: Line[], payment: Record<string, unknown>) => {
  const res = await call(org.agentEmail, 'POST', '/pos/folios', {
    customer_name: 'Cliente Test',
    customer_phone: PHONE,
    customer_email: 'cliente@example.com',
    lines: lines.map((l) => ({ ...l, unit_price: 150000 })),
    ...payment,
  })
  expect(res.status, res.text).toBe(201)
  return res.json.folio.id as string
}

const reject = (folioId: string, email = org.adminEmail) =>
  call(email, 'POST', `/pos/folios/${folioId}/reject`, { reason: 'No llegó' })

/**
 * A two-line apartado paid down in cash; its first line is cancelled, then the rest is settled by
 * a transfer nobody verified yet: the sale Rechazar finds with a line already cancelled.
 */
const apartadoWithCancelledLine = async (first: Line, second: Line) => {
  const folioId = await sell([first, second], { payment_method: 'cash', down_payment: 45000 })
  const [cancelled] = await linesOf(folioId)
  const cancel = await call(org.agentEmail, 'POST', `/pos/folios/${folioId}/lines/${cancelled}/cancel`, {})
  expect(cancel.status, cancel.text).toBe(200)
  const settle = await call(org.agentEmail, 'POST', `/pos/folios/${folioId}/settle`, {
    method: 'transfer',
    payment_reference: 'SPEI 0001',
  })
  expect(settle.status, settle.text).toBe(200)
  const pending = await env.DB.prepare(`SELECT payment_verification FROM folios WHERE id = ?`)
    .bind(folioId)
    .first<{ payment_verification: string }>()
  expect(pending!.payment_verification).toBe('pending')
  return folioId
}

const seedZones = async () => {
  const serviceId = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO services
       (id, organization_id, name, description, base_price, minimum_price, default_capacity,
        commission_type, commission_value, zones_enabled, category, status, created_at, updated_at)
     VALUES (?, ?, 'Turibus', NULL, 150000, 100000, 50, 'percent', 0, 1, 'tours', 'active', ?, ?)`,
  )
    .bind(serviceId, org.organizationId, ts(), ts())
    .run()
  const slotId = await seedSlot(org.organizationId, serviceId)
  const zone = async (name: string, sort: number) => {
    const id = crypto.randomUUID()
    await env.DB.prepare(
      `INSERT INTO service_zones (id, organization_id, service_id, name, capacity, sort_order, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 6, ?, 'active', ?, ?)`,
    )
      .bind(id, org.organizationId, serviceId, name, sort, ts(), ts())
      .run()
    await env.DB.prepare(
      `INSERT INTO slot_zones (id, organization_id, slot_id, zone_id, capacity, booked, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 6, 0, 'active', ?, ?)`,
    )
      .bind(crypto.randomUUID(), org.organizationId, slotId, id, ts(), ts())
      .run()
    return id
  }
  return { slotId, alto: await zone('Piso alto', 0), bajo: await zone('Piso bajo', 1) }
}

describe('bug: reject-rereleases-cancelled-seats — Rechazar releases each seat once', () => {
  it('gives back only the live lines: a line cancelled before keeps what another sale holds', async () => {
    const other = await seedSlot(org.organizationId, org.serviceId, { daysAhead: 5 })
    const folioId = await apartadoWithCancelledLine(
      { slot_id: org.slotId, quantity: 2 },
      { slot_id: other, quantity: 3 },
    )
    // Another sale holds four seats on the first slot once the cancelled line gave its two back.
    await sell([{ slot_id: org.slotId, quantity: 4 }], { payment_method: 'cash' })
    expect(await booked(org.slotId)).toBe(4)
    expect(await booked(other)).toBe(3)

    const res = await reject(folioId)
    expect(res.status, res.text).toBe(200)

    expect(await booked(org.slotId)).toBe(4) // the other sale's seats are still held
    expect(await booked(other)).toBe(0)
    expect(await rejectedEvents(folioId)).toBe(1)
  })

  it('a zoned line cancelled before releases nothing again, from its zone or its slot', async () => {
    const { slotId, alto, bajo } = await seedZones()
    const folioId = await apartadoWithCancelledLine(
      { slot_id: slotId, zone_id: alto, quantity: 2 },
      { slot_id: slotId, zone_id: bajo, quantity: 3 },
    )
    await sell([{ slot_id: slotId, zone_id: alto, quantity: 4 }], { payment_method: 'cash' })
    expect(await zoneBooked(slotId, alto)).toBe(4)
    expect(await zoneBooked(slotId, bajo)).toBe(3)

    expect((await reject(folioId)).status).toBe(200)

    expect(await zoneBooked(slotId, alto)).toBe(4)
    expect(await zoneBooked(slotId, bajo)).toBe(0)
    expect(await booked(slotId)).toBe(4) // the slot's total is re-derived from its zones
  })

  it('a second Rechazar answers 409 and changes nothing', async () => {
    const folioId = await sell([{ slot_id: org.slotId, quantity: 2 }], {
      payment_method: 'transfer',
      payment_reference: 'SPEI 0002',
    })
    await sell([{ slot_id: org.slotId, quantity: 4 }], { payment_method: 'cash' })
    expect(await booked(org.slotId)).toBe(6)

    expect((await reject(folioId)).status).toBe(200)
    const first = await folioRow(folioId)
    const refunds = await refundRows(folioId)
    expect(await booked(org.slotId)).toBe(4)

    const again = await reject(folioId)
    expect(again.status, again.text).toBe(409)
    expect(again.json.error.code).toBe('NOT_PENDING_VERIFICATION')
    expect(await booked(org.slotId)).toBe(4)
    expect(await folioRow(folioId)).toEqual(first)
    expect(await refundRows(folioId)).toBe(refunds)
    expect(await rejectedEvents(folioId)).toBe(1)
  })

  it('two Rechazar at once: one wins, the other changes nothing', async () => {
    const folioId = await sell([{ slot_id: org.slotId, quantity: 2 }], {
      payment_method: 'transfer',
      payment_reference: 'SPEI 0003',
    })
    await sell([{ slot_id: org.slotId, quantity: 4 }], { payment_method: 'cash' })

    const statuses = (await Promise.all([reject(folioId), reject(folioId)])).map((r) => r.status).sort()
    expect(statuses).toEqual([200, 409])
    expect(await booked(org.slotId)).toBe(4)
    expect(await rejectedEvents(folioId)).toBe(1)
  })

  it("another organization's admin gets 404 and the sale is untouched (constitution III)", async () => {
    const folioId = await sell([{ slot_id: org.slotId, quantity: 2 }], {
      payment_method: 'transfer',
      payment_reference: 'SPEI 0004',
    })
    const { orgB } = await seedTwoOrgs()

    const res = await reject(folioId, orgB.adminEmail)
    expect(res.status).toBe(404)
    expect(await booked(org.slotId)).toBe(2)
    expect((await folioRow(folioId))!.cancelled_at).toBeNull()

    // Its own admin still can.
    expect((await reject(folioId)).status).toBe(200)
    expect(await booked(org.slotId)).toBe(0)
  })
})
