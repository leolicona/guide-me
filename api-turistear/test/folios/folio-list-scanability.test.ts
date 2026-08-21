import { describe, it, expect, beforeEach } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { materializeSeededFolio, seedUser, seedTwoOrgs, clearTenancyDb } from '../helpers/tenancy'
import { buildFakeJwt } from '../helpers/jwt'

// US-A82 / US-AG49 — the folio list identifies a sale without opening it.
// Spec: docs/oversight/folio-list-scanability.spec.md — Scenarios S-1, S-7, S-8, S-9, the payload
// facts S-2…S-5 render from, and the two Scope-boundary assertions (SB-*).
//
// What is asserted here is deliberately narrow: this feature adds NO state and NO rule — it widens
// a read. So the tests prove the widening is correct and scoped: the right lines, in the right
// order, with the right portal link, and none of it crossing an organization boundary.
//
// The card's own derivations (which rail, which verb, which checkmark) are pure frontend functions
// and are proven in app-turistear/src/features/folios/folioCardState.test.ts — a business rule is
// proven where it is enforced, and none of these is enforced here (docs/TESTING.md).

const ADMIN_EMAIL = 'admin@empresa.com'
const auth = (email: string) => ({ Cookie: `gm_access=${buildFakeJwt(email)}` })
const FOLIOS = 'http://api.local/api/folios'

const nowSec = () => Math.floor(Date.now() / 1000)

interface ListedFolio {
  id: string
  customer_name: string | null
  customer_phone: string | null
  sale_mode: string
  portal_link: string | null
  payment_verification: string | null
  refund_status: string | null
  refund_amount: number | null
  lines: Array<{
    service_name: string
    line_type: string
    slot_date: string | null
    slot_start_time: string | null
    check_in: string | null
    check_out: string | null
    guests: number | null
    quantity: number
  }>
}

const seedService = async (organizationId: string, name: string): Promise<string> => {
  const id = crypto.randomUUID()
  const ts = nowSec()
  await env.DB.prepare(
    `INSERT INTO services
       (id, organization_id, name, description, base_price, minimum_price, default_capacity,
        status, created_at, updated_at)
     VALUES (?, ?, ?, NULL, 150000, 100000, 12, 'active', ?, ?)`,
  )
    .bind(id, organizationId, name, ts, ts)
    .run()
  return id
}

const seedFolio = async (opts: {
  organizationId: string
  agentId: string
  status?: 'paid' | 'booking' | 'cancelled'
  customerName?: string | null
  customerPhone?: string | null
  saleMode?: 'standard' | 'express'
  paymentVerification?: 'not_required' | 'pending' | 'verified'
  refundStatus?: 'none' | 'pending' | 'refunded'
  refundAmount?: number
  total?: number
  amountPaid?: number
  createdAt?: number
}): Promise<string> => {
  const id = crypto.randomUUID()
  const ts = opts.createdAt ?? nowSec()
  const total = opts.total ?? 240000
  await env.DB.prepare(
    `INSERT INTO folios
       (id, organization_id, agent_id, customer_name, customer_email, customer_phone,
        status, subtotal, discount_total, total, amount_paid, created_at, updated_at,
        sale_mode, payment_verification, refund_status, refund_amount)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      opts.organizationId,
      opts.agentId,
      opts.customerName === undefined ? 'María González' : opts.customerName,
      opts.customerPhone ?? '5215512345678',
      opts.status ?? 'paid',
      total,
      total,
      opts.amountPaid ?? total,
      ts,
      ts,
      opts.saleMode ?? 'standard',
      opts.paymentVerification ?? 'not_required',
      opts.refundStatus ?? 'none',
      opts.refundAmount ?? 0,
    )
    .run()
  return id
}

const seedLine = async (opts: {
  organizationId: string
  folioId: string
  serviceId: string
  serviceName: string
  slotDate?: string | null
  slotStartTime?: string | null
  quantity?: number
  createdAt: number
}): Promise<void> => {
  await env.DB.prepare(
    `INSERT INTO folio_lines
       (id, organization_id, folio_id, service_id, slot_id, service_name, slot_date,
        slot_start_time, quantity, base_price, minimum_price, unit_price, line_total,
        qr_token, redeemed_count, created_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, 150000, 100000, 150000, 150000, NULL, 0, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      opts.organizationId,
      opts.folioId,
      opts.serviceId,
      opts.serviceName,
      opts.slotDate ?? null,
      opts.slotStartTime ?? null,
      opts.quantity ?? 2,
      opts.createdAt,
    )
    .run()
  await materializeSeededFolio(opts.folioId)
}

const seedPortalToken = async (opts: {
  organizationId: string
  folioId: string
  token: string
  createdAt: number
}): Promise<void> => {
  await env.DB.prepare(
    `INSERT INTO folio_access_tokens
       (id, organization_id, folio_id, token, expires_at, last_accessed_at, created_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      opts.organizationId,
      opts.folioId,
      opts.token,
      nowSec() + 86400,
      opts.createdAt,
    )
    .run()
}

const clearFoliosDb = async () => {
  await env.DB.exec('DELETE FROM folio_access_tokens')
  await env.DB.exec('DELETE FROM folio_lines')
  await env.DB.exec('DELETE FROM folio_payments')
  await env.DB.exec('DELETE FROM notifications')
  await env.DB.exec('DELETE FROM folio_events')
  await env.DB.exec('DELETE FROM folios')
  await env.DB.exec('DELETE FROM services')
}

beforeEach(async () => {
  await clearFoliosDb()
  await clearTenancyDb()
})

const list = async (query = '', email = ADMIN_EMAIL): Promise<ListedFolio[]> => {
  const res = await SELF.fetch(`${FOLIOS}${query ? `?${query}` : ''}`, { headers: auth(email) })
  expect(res.status).toBe(200)
  const body = await res.json<{ folios: ListedFolio[] }>()
  return body.folios
}

describe('US-A82 — identify a sale from the list', () => {
  it('S-1 — the list names what was sold, first line first', async () => {
    const { userId, organizationId } = await seedUser({ email: ADMIN_EMAIL })
    const folioId = await seedFolio({ organizationId, agentId: userId })
    const tour = await seedService(organizationId, 'Tour Isla Mujeres')
    const snorkel = await seedService(organizationId, 'Snorkel')
    const base = nowSec()

    // Seeded out of order on purpose: the response must be ordered by created_at, not by
    // insertion or id, because "the first line" is what titles the card.
    await seedLine({
      organizationId,
      folioId,
      serviceId: snorkel,
      serviceName: 'Snorkel',
      slotDate: '2026-08-11',
      slotStartTime: '14:00',
      createdAt: base + 10,
    })
    await seedLine({
      organizationId,
      folioId,
      serviceId: tour,
      serviceName: 'Tour Isla Mujeres',
      slotDate: '2026-08-10',
      slotStartTime: '09:00',
      createdAt: base,
    })

    const [row] = await list()

    expect(row.lines).toHaveLength(2)
    expect(row.lines[0].service_name).toBe('Tour Isla Mujeres')
    expect(row.lines[0].slot_date).toBe('2026-08-10')
    expect(row.lines[0].slot_start_time).toBe('09:00')
    expect(row.lines[0].line_type).toBe('slot')
    expect(row.lines[1].service_name).toBe('Snorkel')
  })

  it('S-1b — a folio with no lines returns an empty array, never a missing key', async () => {
    const { userId, organizationId } = await seedUser({ email: ADMIN_EMAIL })
    await seedFolio({ organizationId, agentId: userId })

    const [row] = await list()

    // The card falls back to "Venta sin detalle" on this; it must not have to guard `undefined`.
    expect(row.lines).toEqual([])
  })

  it('S-2 — an Express folio carries the phone the card identifies it by', async () => {
    const { userId, organizationId } = await seedUser({ email: ADMIN_EMAIL })
    await seedFolio({
      organizationId,
      agentId: userId,
      saleMode: 'express',
      customerName: null,
      customerPhone: '5215512345678',
    })

    const [row] = await list()

    // D17 leaves the name null by design; the row must carry both the phone the fallback reads
    // (`Cliente ••5678`) and the mode — no surface may infer Express from a null name.
    expect(row.customer_name).toBeNull()
    expect(row.customer_phone).toBe('5215512345678')
    expect(row.sale_mode).toBe('express')
  })

  it('S-3 — an unverified transfer is distinguishable from a cleared sale', async () => {
    const { userId, organizationId } = await seedUser({ email: ADMIN_EMAIL })
    await seedFolio({
      organizationId,
      agentId: userId,
      status: 'paid',
      paymentVerification: 'pending',
    })

    const [row] = await list()

    // The fact the amber rail + "por verificar" wording is derived from. Before this, the card
    // read 🟢 Pagado for money the organization does not hold.
    expect(row.payment_verification).toBe('pending')
  })

  it('S-4b — the portal link the ticket send needs travels with the row', async () => {
    const { userId, organizationId } = await seedUser({ email: ADMIN_EMAIL })
    const folioId = await seedFolio({ organizationId, agentId: userId })
    const base = nowSec()

    await seedPortalToken({ organizationId, folioId, token: 'older-token', createdAt: base })
    await seedPortalToken({ organizationId, folioId, token: 'newest-token', createdAt: base + 60 })

    const [row] = await list()

    // The NEWEST token, matching readFolio — a reissued link must not send the customer to a
    // superseded one.
    expect(row.portal_link).toContain('/portal/newest-token')
  })

  it('S-5 — a cancelled folio still owing money carries the debt', async () => {
    const { userId, organizationId } = await seedUser({ email: ADMIN_EMAIL })
    await materializeSeededFolio(
      await seedFolio({
        organizationId,
        agentId: userId,
        status: 'cancelled',
        refundStatus: 'pending',
        refundAmount: 240000,
      }),
    )

    const [row] = await list()

    expect(row.refund_status).toBe('pending')
    expect(row.refund_amount).toBe(240000)
  })

  it('SB-1 — the widening is additive: every pre-existing field survives', async () => {
    const { userId, organizationId } = await seedUser({ email: ADMIN_EMAIL })
    await seedFolio({ organizationId, agentId: userId, total: 240000, amountPaid: 240000 })

    const [row] = await list()
    const keys = Object.keys(row)

    // The scope boundary of this feature, asserted rather than asserted-about: no field was
    // removed or renamed to make room for the three new ones.
    for (const field of [
      'id',
      'agent',
      'customer_name',
      'customer_phone',
      'status',
      'total',
      'amount_paid',
      'pending_balance',
      'created_at',
      'cancelled_at',
      'booking_expires_at',
      'reminder_status',
      'payment_method',
      'payment_verification',
      'deliverable',
      'tickets_sent_at',
      'tickets_viewed_at',
      'operator_name',
      'refund_status',
      'refund_amount',
    ]) {
      expect(keys).toContain(field)
    }
    expect(keys).toContain('lines')
    expect(keys).toContain('portal_link')
    expect(keys).toContain('sale_mode')
  })

  it('SB-2 — an existing filter still filters, now that the query fans out', async () => {
    const { userId, organizationId } = await seedUser({ email: ADMIN_EMAIL })
    const paid = await seedFolio({ organizationId, agentId: userId, status: 'paid' })
    const cancelled = await seedFolio({ organizationId, agentId: userId, status: 'cancelled' })
    const service = await seedService(organizationId, 'Tour Isla Mujeres')
    const base = nowSec()
    await seedLine({ organizationId, folioId: paid, serviceId: service, serviceName: 'Tour Isla Mujeres', createdAt: base })
    await seedLine({ organizationId, folioId: cancelled, serviceId: service, serviceName: 'Snorkel', createdAt: base })

    const rows = await list('status=paid')

    // The decorations re-apply the caller's filters through a join. A filter that leaked would
    // decorate the paid folio with the cancelled one's lines.
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(paid)
    expect(rows[0].lines.map((l) => l.service_name)).toEqual(['Tour Isla Mujeres'])
  })
})

describe('Attribution — decorations belong to the row they decorate', () => {
  // This is the test with teeth for the new code. Cross-org leakage through the decorations is
  // structurally impossible (the response iterates the caller's own rows and looks each up by id,
  // so a foreign line could sit unused in the map and never be seen) — which means the isolation
  // scenarios below prove the response CONTRACT, not the grouping. Mis-grouping is the failure this
  // feature could actually ship: two folios in one organization wearing each other's purchase.
  it('S-7 — two folios in the same org never wear each other’s lines or link', async () => {
    const { userId, organizationId } = await seedUser({ email: ADMIN_EMAIL })
    const base = nowSec()
    // Distinct created_at so the newest-first order is deterministic.
    const older = await seedFolio({ organizationId, agentId: userId, createdAt: base - 60 })
    const newer = await seedFolio({ organizationId, agentId: userId, createdAt: base })
    const tour = await seedService(organizationId, 'Tour Isla Mujeres')
    const stay = await seedService(organizationId, 'Casa Azul')

    await seedLine({
      organizationId,
      folioId: older,
      serviceId: tour,
      serviceName: 'Tour Isla Mujeres',
      createdAt: base,
    })
    await seedLine({
      organizationId,
      folioId: newer,
      serviceId: stay,
      serviceName: 'Casa Azul',
      createdAt: base,
    })
    await seedPortalToken({ organizationId, folioId: older, token: 'token-older', createdAt: base })
    await seedPortalToken({ organizationId, folioId: newer, token: 'token-newer', createdAt: base })

    const rows = await list()
    const byId = new Map(rows.map((r) => [r.id, r]))

    expect(byId.get(older)!.lines.map((l) => l.service_name)).toEqual(['Tour Isla Mujeres'])
    expect(byId.get(newer)!.lines.map((l) => l.service_name)).toEqual(['Casa Azul'])
    expect(byId.get(older)!.portal_link).toContain('token-older')
    expect(byId.get(newer)!.portal_link).toContain('token-newer')
  })
})

describe('Multitenancy isolation', () => {
  it("S-8 — another org's lines are invisible", async () => {
    const { orgA, orgB } = await seedTwoOrgs()

    const folioA = await seedFolio({ organizationId: orgA.organizationId, agentId: orgA.adminUserId })
    const folioB = await seedFolio({ organizationId: orgB.organizationId, agentId: orgB.adminUserId })
    const serviceA = await seedService(orgA.organizationId, 'Tour Isla Mujeres')
    const serviceB = await seedService(orgB.organizationId, 'Tour Secreto de Org B')
    const base = nowSec()

    await seedLine({
      organizationId: orgA.organizationId,
      folioId: folioA,
      serviceId: serviceA,
      serviceName: 'Tour Isla Mujeres',
      createdAt: base,
    })
    await seedLine({
      organizationId: orgB.organizationId,
      folioId: folioB,
      serviceId: serviceB,
      serviceName: 'Tour Secreto de Org B',
      createdAt: base,
    })

    const res = await SELF.fetch(FOLIOS, { headers: auth(orgA.adminEmail) })
    expect(res.status).toBe(200)
    const raw = await res.text()

    const { folios } = JSON.parse(raw) as { folios: ListedFolio[] }
    expect(folios).toHaveLength(1)
    expect(folios[0].id).toBe(folioA)
    expect(folios[0].lines.map((l) => l.service_name)).toEqual(['Tour Isla Mujeres'])
    // Asserted against the whole serialized body, not just the parsed rows: a leak anywhere in the
    // response — decoration map, error detail, anything — fails here.
    expect(raw).not.toContain('Tour Secreto de Org B')
  })

  it("S-9 — another org's portal token is never issued", async () => {
    const { orgA, orgB } = await seedTwoOrgs()

    const folioA = await seedFolio({ organizationId: orgA.organizationId, agentId: orgA.adminUserId })
    const folioB = await seedFolio({ organizationId: orgB.organizationId, agentId: orgB.adminUserId })
    const base = nowSec()

    await seedPortalToken({
      organizationId: orgA.organizationId,
      folioId: folioA,
      token: 'org-a-token',
      createdAt: base,
    })
    await seedPortalToken({
      organizationId: orgB.organizationId,
      folioId: folioB,
      token: 'org-b-token',
      createdAt: base,
    })

    const res = await SELF.fetch(FOLIOS, { headers: auth(orgA.adminEmail) })
    const raw = await res.text()

    expect(raw).toContain('org-a-token')
    // A portal link is a bearer credential — the tourist's receipt, itinerary and Refund PIN sit
    // behind it. Leaking one across organizations is worse than leaking a service name.
    expect(raw).not.toContain('org-b-token')
  })
})
