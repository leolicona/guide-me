import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import {
  seedUser,
  seedTwoOrgs,
  seedAffiliateCompany,
  seedAffiliateCommission,
  clearAffiliateDb,
} from '../helpers/tenancy'
import { buildFakeJwt } from '../helpers/jwt'

// US-A58 — guarded hard-delete of a service (docs/catalog/service-catalog.spec.md rev.
// 2026-06-23). Blocked (409 SERVICE_HAS_FOLIOS) when any folio line references the service;
// otherwise removes the service + its slots / schedules / extras / affiliate_commissions.

const ADMIN_EMAIL = 'admin@empresa.com'
const AGENT_EMAIL = 'agent@empresa.com'

const auth = (email: string) => ({ Cookie: `gm_access=${buildFakeJwt(email)}` })

const ts = () => Math.floor(Date.now() / 1000)

const seedService = async (organizationId: string, name = 'City Tour'): Promise<string> => {
  const id = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO services
       (id, organization_id, name, description, base_price, minimum_price, default_capacity, commission_type, commission_value, status, created_at, updated_at)
     VALUES (?, ?, ?, NULL, 150000, 100000, 12, 'percent', 0, 'active', ?, ?)`,
  )
    .bind(id, organizationId, name, ts(), ts())
    .run()
  return id
}

const seedSlot = async (organizationId: string, serviceId: string): Promise<string> => {
  const id = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO slots (id, organization_id, service_id, schedule_id, date, start_time, capacity, booked, status, created_at, updated_at)
     VALUES (?, ?, ?, NULL, '2026-06-15', '10:00', 12, 0, 'active', ?, ?)`,
  )
    .bind(id, organizationId, serviceId, ts(), ts())
    .run()
  return id
}

const seedSchedule = async (organizationId: string, serviceId: string): Promise<string> => {
  const id = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO schedules (id, organization_id, service_id, recurrence, weekdays, start_time, capacity, start_date, end_date, status, created_at, updated_at)
     VALUES (?, ?, ?, 'weekly', '1,3,5', '10:00', 12, '2026-06-01', '2026-12-31', 'active', ?, ?)`,
  )
    .bind(id, organizationId, serviceId, ts(), ts())
    .run()
  return id
}

const seedExtra = async (organizationId: string, serviceId: string): Promise<string> => {
  const id = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO service_extras (id, organization_id, service_id, name, price, status, created_at, updated_at)
     VALUES (?, ?, ?, 'Photo', 25000, 'active', ?, ?)`,
  )
    .bind(id, organizationId, serviceId, ts(), ts())
    .run()
  return id
}

// A folio + one line referencing the service (the history that must block a delete).
const seedFolioLine = async (organizationId: string, agentId: string, serviceId: string, slotId: string) => {
  const folioId = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO folios (id, organization_id, agent_id, status, payment_method, subtotal, discount_total, total, amount_paid, commission_amount, created_at, updated_at)
     VALUES (?, ?, ?, 'paid', 'cash', 150000, 0, 150000, 150000, 0, ?, ?)`,
  )
    .bind(folioId, organizationId, agentId, ts(), ts())
    .run()
  await env.DB.prepare(
    `INSERT INTO folio_lines
       (id, organization_id, folio_id, service_id, slot_id, service_name, slot_date, slot_start_time, quantity, base_price, minimum_price, unit_price, line_total, commission_type, commission_value, created_at)
     VALUES (?, ?, ?, ?, ?, 'City Tour', '2026-06-15', '10:00', 1, 150000, 100000, 150000, 150000, 'percent', 0, ?)`,
  )
    .bind(crypto.randomUUID(), organizationId, folioId, serviceId, slotId, ts())
    .run()
}

const countWhereService = async (table: string, serviceId: string): Promise<number> => {
  const r = await env.DB.prepare(`SELECT count(*) as n FROM ${table} WHERE service_id = ?`)
    .bind(serviceId)
    .first<{ n: number }>()
  return r!.n
}

const api = (id: string) => `http://api.local/api/services/${id}`

beforeEach(clearAffiliateDb)
afterEach(() => vi.restoreAllMocks())

describe('US-A58 — hard-delete a service', () => {
  it('deletes an unused service and cascades slots / schedules / extras / affiliate_commissions', async () => {
    const { organizationId } = await seedUser({ email: ADMIN_EMAIL, role: 'admin' })
    const serviceId = await seedService(organizationId)
    await seedSlot(organizationId, serviceId)
    await seedSchedule(organizationId, serviceId)
    await seedExtra(organizationId, serviceId)
    const { companyId } = await seedAffiliateCompany({ organizationId })
    await seedAffiliateCommission({ organizationId, affiliateCompanyId: companyId, serviceId })

    const res = await SELF.fetch(api(serviceId), { method: 'DELETE', headers: auth(ADMIN_EMAIL) })
    expect(res.status).toBe(200)

    // The service and every dependent row are gone.
    const svc = await env.DB.prepare('SELECT count(*) as n FROM services WHERE id = ?')
      .bind(serviceId)
      .first<{ n: number }>()
    expect(svc!.n).toBe(0)
    expect(await countWhereService('slots', serviceId)).toBe(0)
    expect(await countWhereService('schedules', serviceId)).toBe(0)
    expect(await countWhereService('service_extras', serviceId)).toBe(0)
    expect(await countWhereService('affiliate_commissions', serviceId)).toBe(0)
  })

  it('is rejected with 409 SERVICE_HAS_FOLIOS when a folio references the service', async () => {
    const { organizationId, userId } = await seedUser({ email: ADMIN_EMAIL, role: 'admin' })
    const serviceId = await seedService(organizationId)
    const slotId = await seedSlot(organizationId, serviceId)
    await seedFolioLine(organizationId, userId, serviceId, slotId)

    const res = await SELF.fetch(api(serviceId), { method: 'DELETE', headers: auth(ADMIN_EMAIL) })
    expect(res.status).toBe(409)
    expect(JSON.stringify(await res.json())).toContain('SERVICE_HAS_FOLIOS')

    // Nothing was removed — the service (and its slot) are intact.
    const svc = await env.DB.prepare('SELECT count(*) as n FROM services WHERE id = ?')
      .bind(serviceId)
      .first<{ n: number }>()
    expect(svc!.n).toBe(1)
    expect(await countWhereService('slots', serviceId)).toBe(1)
  })

  it('an agent is forbidden (403)', async () => {
    const { organizationId } = await seedUser({ email: ADMIN_EMAIL, role: 'admin' })
    await seedUser({ email: AGENT_EMAIL, role: 'agent', organizationId })
    const serviceId = await seedService(organizationId)

    const res = await SELF.fetch(api(serviceId), { method: 'DELETE', headers: auth(AGENT_EMAIL) })
    expect(res.status).toBe(403)
  })

  it('B3 — deleting another org\'s service → 404 and leaves it intact', async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    const serviceId = await seedService(orgB.organizationId)

    const res = await SELF.fetch(api(serviceId), { method: 'DELETE', headers: auth(orgA.adminEmail) })
    expect(res.status).toBe(404)
    const svc = await env.DB.prepare('SELECT count(*) as n FROM services WHERE id = ?')
      .bind(serviceId)
      .first<{ n: number }>()
    expect(svc!.n).toBe(1)
  })
})
