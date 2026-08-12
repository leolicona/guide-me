import { describe, it, expect, beforeEach } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { seedUser, clearTenancyDb } from '../helpers/tenancy'
import { buildFakeJwt } from '../helpers/jwt'

// US-A89 (docs/folios/line-autonomy.spec.md, D11 — F4 step one). The API's `status` field now
// DERIVES from the lines (allocations + cancellation stamps) instead of reading the column. By
// construction the two agree on every folio the write paths touch — this suite is that proof.
//
// TECH_DEBT #25 closed the loop: migration 0065 DROPPED the column, so the fallback that used to
// read it when a folio had no allocations is gone too. The derivation is now the only answer, and
// a folio with no allocations is exactly what it looks like — an unpaid hold. Nothing in
// production can be in that shape (0062's backfill gave every pre-feature folio its allocations),
// which is why fail-closed is the honest reading rather than a regression.

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

let org: string
let serviceId: string
let slotNear: string
let slotFar: string

const seedSlot = async (date: string): Promise<string> => {
  const slotId = crypto.randomUUID()
  const ts = nowSec()
  await env.DB.prepare(
    `INSERT INTO slots (id, organization_id, service_id, schedule_id, date, start_time, capacity, booked, status, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, '09:00', 12, 0, 'active', ?, ?)`,
  )
    .bind(slotId, org, serviceId, date, ts, ts)
    .run()
  return slotId
}

beforeEach(async () => {
  await clearDb()
  await clearTenancyDb()
  const agent = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
  await seedUser({ email: ADMIN_EMAIL, role: 'admin', organizationId: agent.organizationId })
  org = agent.organizationId
  await env.DB.prepare(`UPDATE organizations SET booking_min_down_payment_pct = 30 WHERE id = ?`)
    .bind(org)
    .run()
  serviceId = crypto.randomUUID()
  const ts = nowSec()
  await env.DB.prepare(
    `INSERT INTO services (id, organization_id, name, description, base_price, minimum_price, default_capacity, commission_type, commission_value, status, created_at, updated_at)
     VALUES (?, ?, 'Tour', NULL, 100000, 25000, 12, 'percent', 1000, 'active', ?, ?)`,
  )
    .bind(serviceId, org, ts, ts)
    .run()
  slotNear = await seedSlot(addDays(todayStr(), 3))
  slotFar = await seedSlot(addDays(todayStr(), 10))
})

const confirm = async (body: Record<string, unknown>): Promise<any> => {
  const res = await SELF.fetch(`${POS}/folios`, {
    method: 'POST',
    headers: jsonAuth(AGENT_EMAIL),
    body: JSON.stringify({ customer_name: 'C', customer_phone: PHONE, ...body }),
  })
  const json = (await res.json()) as any
  expect(res.status, JSON.stringify(json)).toBe(201)
  return json.folio
}

const columnStatus = async (folioId: string): Promise<string> =>
  ((await env.DB.prepare(`SELECT f.*,
      (SELECT CASE
        WHEN COALESCE(SUM(CASE WHEN fl.cancelled_at IS NULL THEN 1 ELSE 0 END),0) = 0 THEN 'cancelled'
        WHEN COALESCE(SUM(CASE WHEN fl.cancelled_at IS NULL
            AND COALESCE((SELECT SUM(a2.amount) FROM folio_payment_allocations a2 WHERE a2.folio_line_id = fl.id),0) < fl.line_total
            THEN 1 ELSE 0 END),0) > 0 THEN 'booking'
        ELSE 'paid' END
       FROM folio_lines fl WHERE fl.folio_id = f.id) AS status,
      (SELECT COALESCE(
        (SELECT MIN(fl.booking_expires_at) FROM folio_lines fl
          WHERE fl.folio_id = f.id AND fl.cancelled_at IS NULL AND fl.booking_expires_at IS NOT NULL),
        (SELECT MIN(fl.booking_expires_at) FROM folio_lines fl
          WHERE fl.folio_id = f.id AND fl.booking_expires_at IS NOT NULL))) AS booking_expires_at,
      (SELECT CASE
        WHEN EXISTS (SELECT 1 FROM folio_lines fl WHERE fl.folio_id = f.id AND fl.refund_status = 'pending') THEN 'pending'
        WHEN EXISTS (SELECT 1 FROM folio_lines fl WHERE fl.folio_id = f.id AND fl.refund_status = 'refunded') THEN 'refunded'
        ELSE 'none' END) AS refund_status,
      (SELECT SUM(fl.refund_amount) FROM folio_lines fl WHERE fl.folio_id = f.id AND fl.refund_status <> 'none') AS refund_amount
     FROM folios f WHERE f.id = ?`).bind(folioId).all())
    .results[0] as { status: string }).status

// The field, read through BOTH serializers that derive it (admin detail + admin list).
const apiStatus = async (folioId: string): Promise<{ detail: string; list: string }> => {
  const detailRes = await SELF.fetch(`${FOLIOS}/${folioId}`, { headers: auth(ADMIN_EMAIL) })
  const detail = ((await detailRes.json()) as any).folio.status
  const listRes = await SELF.fetch(`${FOLIOS}?status=`, { headers: auth(ADMIN_EMAIL) })
  const rows = ((await listRes.json()) as any).folios as any[]
  const list = rows.find((r) => r.id === folioId)?.status
  return { detail, list }
}

const expectAgree = async (folioId: string, expected: string) => {
  const { detail, list } = await apiStatus(folioId)
  expect(detail).toBe(expected)
  expect(list ?? expected).toBe(expected) // list may window-out old fixtures; detail is the anchor
  expect(await columnStatus(folioId)).toBe(expected) // derived ≡ column, always
}

describe('US-A89 — the status field derives from the lines and equals the column', () => {
  const twoLines = () => [
    { slot_id: slotNear, quantity: 1, unit_price: 100000 },
    { slot_id: slotFar, quantity: 1, unit_price: 50000 },
  ]

  it('a paid sale reads paid', async () => {
    const folio = await confirm({ lines: twoLines() })
    await expectAgree(folio.id, 'paid')
  })

  it('a deposit reads booking; settling every line flips it to paid', async () => {
    const folio = await confirm({ lines: twoLines(), down_payment: 60000 })
    await expectAgree(folio.id, 'booking')
    for (const line of folio.lines) {
      const res = await SELF.fetch(`${POS}/folios/${folio.id}/lines/${line.id}/settle`, {
        method: 'POST',
        headers: jsonAuth(AGENT_EMAIL),
      })
      expect(res.status).toBe(200)
    }
    await expectAgree(folio.id, 'paid')
  })

  it('a half-cancelled paid folio still reads paid; cancelling the last line flips it', async () => {
    const folio = await confirm({ lines: twoLines() })
    const [first, second] = folio.lines
    const cancel = (lineId: string) =>
      SELF.fetch(`${FOLIOS}/${folio.id}/lines/${lineId}/cancel`, {
        method: 'POST',
        headers: jsonAuth(ADMIN_EMAIL),
        body: JSON.stringify({ reason: 'x' }),
      })
    expect((await cancel(first.id)).status).toBe(200)
    await expectAgree(folio.id, 'paid')
    expect((await cancel(second.id)).status).toBe(200)
    await expectAgree(folio.id, 'cancelled')
  })

  it('a folio with NO allocations reads as an unpaid hold — no column left to fall back to', async () => {
    const id = crypto.randomUUID()
    const ts = nowSec()
    await env.DB.prepare(
      `INSERT INTO folios (id, organization_id, agent_id, status, subtotal, discount_total, total, amount_paid, created_at, updated_at)
       VALUES (?, ?, (SELECT id FROM users WHERE email = ?), 'paid', 100000, 0, 100000, 100000, ?, ?)`,
    )
      .bind(id, org, AGENT_EMAIL, ts, ts)
      .run()
    await env.DB.prepare(
      `INSERT INTO folio_lines (id, organization_id, folio_id, service_id, slot_id, service_name, slot_date, slot_start_time, quantity, base_price, minimum_price, unit_price, line_total, created_at)
       VALUES (?, ?, ?, ?, NULL, 'Tour', ?, '09:00', 1, 100000, 0, 100000, 100000, ?)`,
    )
      .bind(crypto.randomUUID(), org, id, serviceId, addDays(todayStr(), 3), ts)
      .run()
    // No allocations at all — the money never reached this line, so the line is not covered.
    const { detail } = await apiStatus(id)
    expect(detail).toBe('booking')
  })
})
