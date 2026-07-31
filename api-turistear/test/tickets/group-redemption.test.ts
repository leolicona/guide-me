import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { seedUser, seedTwoOrgs, clearTenancyDb } from '../helpers/tenancy'
import { buildFakeJwt } from '../helpers/jwt'

// Group Redemption — US-AG48 (one scan boards the whole party) + US-A81 (the admin picks the
// mode). Spec: docs/scanner/group-redemption.spec.md (S-1..S-10). `per_pass` stays byte-identical
// to pre-feature behaviour — that scope boundary is held by online-qr-scanner.test.ts unedited.

const AGENT_EMAIL = 'agent@empresa.com'
const ADMIN_EMAIL = 'admin@empresa.com'
const PHONE = '+52 55 1234 5678'
const auth = (email: string) => ({ Cookie: `gm_access=${buildFakeJwt(email)}` })
const jsonAuth = (email: string) => ({ ...auth(email), 'Content-Type': 'application/json' })

const todayStr = (): string => new Date().toISOString().slice(0, 10)
const addDays = (d: string, n: number): string =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)

const seedService = async (organizationId: string): Promise<string> => {
  const id = crypto.randomUUID()
  const ts = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO services (id, organization_id, name, description, base_price, minimum_price, default_capacity, commission_type, commission_value, status, created_at, updated_at)
     VALUES (?, ?, 'Lancha', NULL, 150000, 100000, 12, 'percent', 0, 'active', ?, ?)`,
  )
    .bind(id, organizationId, ts, ts)
    .run()
  return id
}

const seedSlot = async (organizationId: string, serviceId: string): Promise<string> => {
  const id = crypto.randomUUID()
  const ts = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO slots (id, organization_id, service_id, schedule_id, date, start_time, capacity, booked, status, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, '10:00', 20, 0, 'active', ?, ?)`,
  )
    .bind(id, organizationId, serviceId, addDays(todayStr(), 3), ts, ts)
    .run()
  return id
}

const setMode = (organizationId: string, mode: 'per_pass' | 'all_passes') =>
  env.DB.prepare(`UPDATE organizations SET qr_redemption_mode = ? WHERE id = ?`)
    .bind(mode, organizationId)
    .run()

const sellPaid = async (
  email: string,
  slotId: string,
  quantity: number,
): Promise<{ folioId: string; token: string }> => {
  const res = await SELF.fetch('http://api.local/api/pos/folios', {
    method: 'POST',
    headers: jsonAuth(email),
    body: JSON.stringify({
      customer_name: 'Cliente Test',
      customer_phone: PHONE,
      lines: [{ slot_id: slotId, quantity, unit_price: 150000 }],
    }),
  })
  const json = (await res.json()) as any
  expect(res.status, JSON.stringify(json)).toBe(201)
  return { folioId: json.folio.id, token: json.folio.lines[0].qr_token as string }
}

const scan = async (email: string, token: string) => {
  const res = await SELF.fetch('http://api.local/api/tickets/scan', {
    method: 'POST',
    headers: jsonAuth(email),
    body: JSON.stringify({ token }),
  })
  return (await res.json()) as any
}

const getRedeemed = async (folioId: string) =>
  (await env.DB.prepare(`SELECT redeemed_count FROM folio_lines WHERE folio_id = ?`)
    .bind(folioId)
    .first<{ redeemed_count: number }>())!.redeemed_count

const clearPosDb = async () => {
  await env.DB.exec('DELETE FROM folio_line_extras')
  await env.DB.exec('DELETE FROM folio_lines')
  await env.DB.exec('DELETE FROM folio_access_tokens')
  await env.DB.exec('DELETE FROM folio_payments')
  await env.DB.exec('DELETE FROM folios')
  await env.DB.exec('DELETE FROM slots')
  await env.DB.exec('DELETE FROM services')
}

beforeEach(async () => {
  await clearPosDb()
  await clearTenancyDb()
})
afterEach(() => vi.restoreAllMocks())

describe('US-AG48 — one scan boards the whole party', () => {
  it('S-1 — a four-pass ticket clears in one scan', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    await setMode(organizationId, 'all_passes')
    const serviceId = await seedService(organizationId)
    const slotId = await seedSlot(organizationId, serviceId)
    const { folioId, token } = await sellPaid(AGENT_EMAIL, slotId, 4)

    const result = await scan(AGENT_EMAIL, token)
    expect(result.result, JSON.stringify(result)).toBe('valid')
    expect(result.ticket.redeemed_count).toBe(4)
    expect(result.ticket.redeemed_now).toBe(4)
    // D6 — a pass ordinal is meaningless when the party redeems as one.
    expect(result.ticket.pass_number).toBeUndefined()
    expect(await getRedeemed(folioId)).toBe(4)
  })

  it('S-2 — a rescan is refused', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    await setMode(organizationId, 'all_passes')
    const serviceId = await seedService(organizationId)
    const slotId = await seedSlot(organizationId, serviceId)
    const { folioId, token } = await sellPaid(AGENT_EMAIL, slotId, 4)

    await scan(AGENT_EMAIL, token)
    const again = await scan(AGENT_EMAIL, token)
    expect(again.result).toBe('invalid')
    expect(again.reason).toBe('ALREADY_CONSUMED')
    expect(await getRedeemed(folioId)).toBe(4)
  })

  it('S-3 — a partially redeemed ticket completes in one scan', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const serviceId = await seedService(organizationId)
    const slotId = await seedSlot(organizationId, serviceId)
    const { folioId, token } = await sellPaid(AGENT_EMAIL, slotId, 5)

    // Two passes redeemed earlier under per_pass (the default).
    await scan(AGENT_EMAIL, token)
    await scan(AGENT_EMAIL, token)
    expect(await getRedeemed(folioId)).toBe(2)

    // The org switches mode; the next scan takes everything left.
    await setMode(organizationId, 'all_passes')
    const result = await scan(AGENT_EMAIL, token)
    expect(result.result).toBe('valid')
    expect(result.ticket.redeemed_count).toBe(5)
    expect(result.ticket.redeemed_now).toBe(3)
    expect(await getRedeemed(folioId)).toBe(5)
  })

  it('S-4 — per_pass is untouched: four scans, ordinals 1..4, then ALREADY_CONSUMED', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const serviceId = await seedService(organizationId)
    const slotId = await seedSlot(organizationId, serviceId)
    const { token } = await sellPaid(AGENT_EMAIL, slotId, 4)

    for (let pass = 1; pass <= 4; pass++) {
      const result = await scan(AGENT_EMAIL, token)
      expect(result.result).toBe('valid')
      expect(result.ticket.pass_number).toBe(pass)
    }
    const fifth = await scan(AGENT_EMAIL, token)
    expect(fifth.result).toBe('invalid')
    expect(fifth.reason).toBe('ALREADY_CONSUMED')
  })

  it('S-5 — the mode is read live from the scanning org, never snapshotted onto the ticket', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const serviceId = await seedService(organizationId)
    const slotId = await seedSlot(organizationId, serviceId)
    // Ticket ISSUED while the org was per_pass.
    const { folioId, token } = await sellPaid(AGENT_EMAIL, slotId, 3)

    await setMode(organizationId, 'all_passes')
    const result = await scan(AGENT_EMAIL, token)
    expect(result.ticket.redeemed_count).toBe(3)
    expect(await getRedeemed(folioId)).toBe(3)
  })
})

describe('US-A81 — the admin picks the mode', () => {
  it('S-7 — an admin flips the mode through the settings endpoint', async () => {
    const { organizationId } = await seedUser({ email: ADMIN_EMAIL, role: 'admin' })

    const res = await SELF.fetch('http://api.local/api/organizations/me', {
      method: 'PUT',
      headers: jsonAuth(ADMIN_EMAIL),
      body: JSON.stringify({ qr_redemption_mode: 'all_passes' }),
    })
    const json = (await res.json()) as any
    expect(res.status, JSON.stringify(json)).toBe(200)
    expect(json.organization.qr_redemption_mode).toBe('all_passes')

    const row = await env.DB.prepare(
      `SELECT qr_redemption_mode FROM organizations WHERE id = ?`,
    )
      .bind(organizationId)
      .first<any>()
    expect(row.qr_redemption_mode).toBe('all_passes')

    // Garbage is refused by the enum.
    const bad = await SELF.fetch('http://api.local/api/organizations/me', {
      method: 'PUT',
      headers: jsonAuth(ADMIN_EMAIL),
      body: JSON.stringify({ qr_redemption_mode: 'sometimes' }),
    })
    expect(bad.status).toBe(400)
  })

  it('S-8 — a non-admin cannot write the setting', async () => {
    await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const res = await SELF.fetch('http://api.local/api/organizations/me', {
      method: 'PUT',
      headers: jsonAuth(AGENT_EMAIL),
      body: JSON.stringify({ qr_redemption_mode: 'all_passes' }),
    })
    expect(res.status).toBe(403)
  })
})

describe('Multitenancy isolation', () => {
  it("S-9 — org A's all_passes has no effect on org B's scans", async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    await setMode(orgA.organizationId, 'all_passes')
    await seedUser({
      email: AGENT_EMAIL,
      role: 'agent',
      organizationId: orgB.organizationId,
    })
    const serviceId = await seedService(orgB.organizationId)
    const slotId = await seedSlot(orgB.organizationId, serviceId)
    const { folioId, token } = await sellPaid(AGENT_EMAIL, slotId, 4)

    const result = await scan(AGENT_EMAIL, token)
    expect(result.result).toBe('valid')
    // Org B is per_pass — exactly ONE pass redeemed despite org A's setting.
    expect(result.ticket.pass_number).toBe(1)
    expect(await getRedeemed(folioId)).toBe(1)
  })
})
