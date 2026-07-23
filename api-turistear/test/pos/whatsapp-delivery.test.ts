import { describe, it, expect } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { seedUser } from '../helpers/tenancy'
import { buildFakeJwt } from '../helpers/jwt'

// WhatsApp ticket delivery — Phases 2/3 backend (docs/whatsapp-qr-delivery/spec.md). The seller/
// admin mark-sent endpoints (D4/D13) + the bot-proof "Visto" beacon (D6), plus cross-org isolation.

const auth = (email: string) => ({ Cookie: `gm_access=${buildFakeJwt(email)}` })
const jsonAuth = (email: string) => ({ ...auth(email), 'Content-Type': 'application/json' })
const nowSec = () => Math.floor(Date.now() / 1000)

// Real-time-based future date (mirrors the portal test) so the slot is sellable under the suite's
// frozen "now" (2026-06-14) and the portal token expiry lands well past it.
const SLOT_DATE = new Date(Date.now() + 21 * 86400 * 1000).toISOString().slice(0, 10)

const seedService = async (orgId: string, name = 'Tour del Cañón') => {
  const id = crypto.randomUUID()
  const ts = nowSec()
  await env.DB.prepare(
    `INSERT INTO services (id, organization_id, name, description, base_price, minimum_price, default_capacity, commission_value, status, created_at, updated_at)
     VALUES (?, ?, ?, 'Punto de encuentro: muelle 3', 150000, 100000, 12, 0, 'active', ?, ?)`,
  )
    .bind(id, orgId, name, ts, ts)
    .run()
  return id
}

const seedSlot = async (orgId: string, svcId: string) => {
  const id = crypto.randomUUID()
  const ts = nowSec()
  await env.DB.prepare(
    `INSERT INTO slots (id, organization_id, service_id, schedule_id, date, start_time, capacity, booked, status, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, '10:00', 12, 0, 'active', ?, ?)`,
  )
    .bind(id, orgId, svcId, SLOT_DATE, ts, ts)
    .run()
  return id
}

const confirmSale = async (email: string, slotId: string) => {
  const res = await SELF.fetch('http://api.local/api/pos/folios', {
    method: 'POST',
    headers: jsonAuth(email),
    body: JSON.stringify({
      customer_name: 'Cliente Test',
      customer_phone: '5512345678',
      lines: [{ slot_id: slotId, quantity: 1, unit_price: 150000 }],
    }),
  })
  return { status: res.status, json: (await res.json()) as any }
}

const getPosFolio = async (email: string, id: string) => {
  const res = await SELF.fetch(`http://api.local/api/pos/folios/${id}`, { headers: auth(email) })
  return { status: res.status, json: (await res.json()) as any }
}

const post = (email: string, path: string) =>
  SELF.fetch(`http://api.local${path}`, { method: 'POST', headers: jsonAuth(email) })

// Seed an org with an admin + agent and one sellable slot; return everything a test needs.
const seedOrgWithSlot = async (adminEmail: string, agentEmail: string) => {
  const { organizationId } = await seedUser({ email: adminEmail, role: 'admin' })
  await seedUser({ email: agentEmail, role: 'agent', organizationId })
  const serviceId = await seedService(organizationId)
  const slotId = await seedSlot(organizationId, serviceId)
  return { organizationId, slotId }
}

// Each test seeds its own org + users (unique emails), so no shared cleanup is needed — and
// clearTenancyDb can't run once folios reference users anyway.
describe('whatsapp-qr-delivery — delivery tracking + Visto beacon', () => {
  it('a paid sale exposes portal_link and starts un-sent (Pendiente)', async () => {
    const { slotId } = await seedOrgWithSlot('a1@org.com', 'a2@org.com')
    const { status, json } = await confirmSale('a2@org.com', slotId)
    expect(status, JSON.stringify(json)).toBe(201)
    expect(json.folio.portal_link).toMatch(/\/portal\/.+/)
    expect(json.folio.tickets_sent_at).toBeNull()
    expect(json.folio.tickets_viewed_at).toBeNull()
  })

  it('the seller marks the tickets sent (idempotent last-write-wins)', async () => {
    const { slotId } = await seedOrgWithSlot('b1@org.com', 'b2@org.com')
    const { json } = await confirmSale('b2@org.com', slotId)
    const id = json.folio.id

    const res = await post('b2@org.com', `/api/pos/folios/${id}/ticket-delivery`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.tickets_sent_at).toBeGreaterThan(0)

    // GET reflects it (Enviado).
    const after = await getPosFolio('b2@org.com', id)
    expect(after.json.folio.tickets_sent_at).toBeGreaterThan(0)

    // Re-send is accepted (no claim, last-write-wins) — still 200.
    expect((await post('b2@org.com', `/api/pos/folios/${id}/ticket-delivery`)).status).toBe(200)
  })

  it('another agent in the SAME org cannot mark a folio they did not sell (404)', async () => {
    const { organizationId, slotId } = await seedOrgWithSlot('c1@org.com', 'c2@org.com')
    await seedUser({ email: 'c3@org.com', role: 'agent', organizationId })
    const { json } = await confirmSale('c2@org.com', slotId)

    const res = await post('c3@org.com', `/api/pos/folios/${json.folio.id}/ticket-delivery`)
    expect(res.status).toBe(404)
  })

  it('the admin marks it via the oversight endpoint', async () => {
    const { slotId } = await seedOrgWithSlot('d1@org.com', 'd2@org.com')
    const { json } = await confirmSale('d2@org.com', slotId)
    const res = await post('d1@org.com', `/api/folios/${json.folio.id}/ticket-delivery`)
    expect(res.status).toBe(200)
    expect(((await res.json()) as any).tickets_sent_at).toBeGreaterThan(0)
  })

  it('cross-org: an admin from another org cannot mark this org’s folio (404)', async () => {
    const orgA = await seedOrgWithSlot('e1@org.com', 'e2@org.com')
    await seedUser({ email: 'f1@other.com', role: 'admin' }) // a DIFFERENT org
    const { json } = await confirmSale('e2@org.com', orgA.slotId)

    // The admin ticket-delivery is org-scoped: a foreign admin's UPDATE matches nothing → 404.
    const res = await post('f1@other.com', `/api/folios/${json.folio.id}/ticket-delivery`)
    expect(res.status).toBe(404)

    // And the folio stays un-sent.
    const after = await getPosFolio('e2@org.com', json.folio.id)
    expect(after.json.folio.tickets_sent_at).toBeNull()
  })

  it('the portal "seen" beacon stamps tickets_viewed_at (first view); a bad token is a 204 no-op', async () => {
    const { slotId } = await seedOrgWithSlot('g1@org.com', 'g2@org.com')
    const { json } = await confirmSale('g2@org.com', slotId)
    const id = json.folio.id
    const token = String(json.folio.portal_link).split('/portal/')[1]
    expect(token).toBeTruthy()

    // A bad token → 204, and nothing is stamped.
    const bad = await SELF.fetch('http://api.local/portal/not-a-real-token/seen', { method: 'POST' })
    expect(bad.status).toBe(204)

    // The real beacon → 204, and the folio flips to Visto.
    const seen = await SELF.fetch(`http://api.local/portal/${token}/seen`, { method: 'POST' })
    expect(seen.status).toBe(204)

    const after = await getPosFolio('g2@org.com', id)
    expect(after.json.folio.tickets_viewed_at).toBeGreaterThan(0)
  })
})
