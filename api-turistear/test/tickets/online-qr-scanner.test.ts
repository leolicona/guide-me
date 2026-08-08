import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { seedUser, seedTwoOrgs, clearTenancyDb } from '../helpers/tenancy'
import { buildFakeJwt } from '../helpers/jwt'
import {
  deriveOrgKey,
  signTicket,
  type TicketPayload,
} from '../../src/utils/qr'

// Online QR Scanner — US-AG15, US-AG17 (US-AG19 is a frontend-only offline guard).
// Spec: docs/scanner/online-qr-scanner.spec.md (Scenarios 1–12).
//
// Tokens are minted the real way — by confirming a sale through POST /api/pos/folios and
// reading `qr_token` off the response — except the NOT_FOUND edge, which signs a payload
// with `signTicket` against a folio line that does not exist.

const AGENT_EMAIL = 'agent@empresa.com'
const ADMIN_EMAIL = 'admin@empresa.com'

const auth = (email: string) => ({ Cookie: `gm_access=${buildFakeJwt(email)}` })
const jsonAuth = (email: string) => ({
  ...auth(email),
  'Content-Type': 'application/json',
})

// --- Local seeders (raw D1) ------------------------------------------------

const seedService = async (organizationId: string): Promise<string> => {
  const serviceId = crypto.randomUUID()
  const ts = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO services
       (id, organization_id, name, description, base_price, minimum_price, default_capacity, status, created_at, updated_at)
     VALUES (?, ?, 'Canyon Tour', NULL, 150000, 100000, 12, 'active', ?, ?)`,
  )
    .bind(serviceId, organizationId, ts, ts)
    .run()
  return serviceId
}

const seedSlot = async (
  organizationId: string,
  serviceId: string,
  date = '2026-06-15',
): Promise<string> => {
  const slotId = crypto.randomUUID()
  const ts = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO slots
       (id, organization_id, service_id, schedule_id, date, start_time, capacity, booked, status, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, '06:00', 12, 0, 'active', ?, ?)`,
  )
    .bind(slotId, organizationId, serviceId, date, ts, ts)
    .run()
  return slotId
}

const getRedeemedCount = async (lineId: string) => {
  const r = await env.DB.prepare(
    `SELECT redeemed_count FROM folio_lines WHERE id = ?`,
  )
    .bind(lineId)
    .first<{ redeemed_count: number }>()
  return r?.redeemed_count ?? null
}

// folio_line_extras → folio_lines → folios → slots → schedules → service_extras → services
const clearPosDb = async () => {
  await env.DB.exec('DELETE FROM folio_access_tokens')
  await env.DB.exec('DELETE FROM folio_line_extras')
  await env.DB.exec('DELETE FROM folio_requests')
  await env.DB.exec('DELETE FROM folio_lines')
  await env.DB.exec('DELETE FROM folio_access_tokens')
  await env.DB.exec('DELETE FROM folio_payments')
  await env.DB.exec('DELETE FROM notifications')
  await env.DB.exec('DELETE FROM folio_events')
  await env.DB.exec('DELETE FROM folios')
  await env.DB.exec('DELETE FROM slot_zones')
  await env.DB.exec('DELETE FROM slots')
  await env.DB.exec('DELETE FROM schedules')
  await env.DB.exec('DELETE FROM service_extras')
  await env.DB.exec('DELETE FROM service_zones')
  await env.DB.exec('DELETE FROM services')
}

beforeEach(async () => {
  await clearPosDb()
  await clearTenancyDb()
})
afterEach(() => vi.restoreAllMocks())

const POS = 'http://api.local/api/pos'
const TICKETS = 'http://api.local/api/tickets'

// Confirm a one-line sale and return its first folio line (with the minted qr_token).
const mintTicket = async (
  email: string,
  organizationId: string,
  opts: { quantity?: number; date?: string } = {},
) => {
  const { quantity = 1, date = '2026-06-15' } = opts
  const serviceId = await seedService(organizationId)
  const slotId = await seedSlot(organizationId, serviceId, date)
  const res = await SELF.fetch(`${POS}/folios`, {
    method: 'POST',
    headers: jsonAuth(email),
    body: JSON.stringify({
      customer_name: 'Cliente Test',
      customer_phone: '5512345678',
      customer_email: 'cliente@example.com',
      lines: [{ slot_id: slotId, quantity, unit_price: 150000 }],
    }),
  })
  const body = (await res.json()) as any
  const line = body.folio.lines[0]
  return { folioId: body.folio.id as string, lineId: line.id as string, token: line.qr_token as string }
}

const scan = async (email: string, token: string) => {
  const res = await SELF.fetch(`${TICKETS}/scan`, {
    method: 'POST',
    headers: jsonAuth(email),
    body: JSON.stringify({ token }),
  })
  return { status: res.status, json: (await res.json()) as any }
}

// ---------------------------------------------------------------------------
// US-AG15 / US-AG17 — scan, redeem, result
// ---------------------------------------------------------------------------
describe('Online QR Scanner', () => {
  it('Scenario 1 — valid scan redeems one pass', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const { lineId, token } = await mintTicket(AGENT_EMAIL, organizationId, { quantity: 5 })

    const { status, json } = await scan(AGENT_EMAIL, token)
    expect(status).toBe(200)
    expect(json.result).toBe('valid')
    expect(json.ticket).toMatchObject({
      service_name: 'Canyon Tour',
      slot_date: '2026-06-15',
      slot_start_time: '06:00',
      passes_total: 5,
      redeemed_count: 1,
      pass_number: 1,
    })
    expect(await getRedeemedCount(lineId)).toBe(1)
  })

  it('Scenario 2 — repeated scans advance the progress', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const { lineId, token } = await mintTicket(AGENT_EMAIL, organizationId, { quantity: 5 })

    for (const expected of [1, 2, 3, 4]) {
      const { json } = await scan(AGENT_EMAIL, token)
      expect(json.result).toBe('valid')
      expect(json.ticket.pass_number).toBe(expected)
    }
    expect(await getRedeemedCount(lineId)).toBe(4)
  })

  it('Scenario 3 — scanning past the last pass → all consumed', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const { lineId, token } = await mintTicket(AGENT_EMAIL, organizationId, { quantity: 2 })

    await scan(AGENT_EMAIL, token)
    await scan(AGENT_EMAIL, token)
    const { json } = await scan(AGENT_EMAIL, token)

    expect(json.result).toBe('invalid')
    expect(json.reason).toBe('ALREADY_CONSUMED')
    expect(json.ticket).toMatchObject({ passes_total: 2, redeemed_count: 2 })
    expect(await getRedeemedCount(lineId)).toBe(2)
  })

  it('Scenario 4 — expired ticket', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    // US-A47 — a past slot can no longer be SOLD, so mint a valid ticket (slot 2026-06-15, expiry
    // = slotDate + 48h = 2026-06-17) then jump the frozen clock past it to test EXPIRED rejection.
    const { lineId, token } = await mintTicket(AGENT_EMAIL, organizationId, { date: '2026-06-15' })

    vi.setSystemTime(new Date('2026-06-18T12:00:00Z'))
    const { json } = await scan(AGENT_EMAIL, token)
    vi.setSystemTime(new Date('2026-06-14T12:00:00Z')) // restore the anchor for later tests
    expect(json.result).toBe('invalid')
    expect(json.reason).toBe('EXPIRED')
    expect(await getRedeemedCount(lineId)).toBe(0)
  })

  it('Scenario 5 — forged / tampered token → fake', async () => {
    await seedUser({ email: AGENT_EMAIL, role: 'agent' })

    for (const bad of ['not-a-token', 'a.b', 'eyJhbGciOiJqdW5rIn0.deadbeef']) {
      const { json } = await scan(AGENT_EMAIL, bad)
      expect(json.result).toBe('invalid')
      expect(json.reason).toBe('INVALID_SIGNATURE')
      expect(json.ticket).toBeNull()
    }
  })

  it('Scenario 6 — cross-org ticket reads as fake (no leak)', async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    const agentA = 'agent-a@empresa.com'
    const agentB = 'agent-b@empresa.com'
    await seedUser({ email: agentA, role: 'agent', organizationId: orgA.organizationId })
    await seedUser({ email: agentB, role: 'agent', organizationId: orgB.organizationId })

    const { lineId, token } = await mintTicket(agentB, orgB.organizationId, { quantity: 3 })

    const { json } = await scan(agentA, token)
    expect(json.result).toBe('invalid')
    expect(json.reason).toBe('INVALID_SIGNATURE')
    expect(await getRedeemedCount(lineId)).toBe(0) // org_b untouched
  })

  it('Scenario 7 — cancelled folio refuses admission', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const { folioId, lineId, token } = await mintTicket(AGENT_EMAIL, organizationId)
    await env.DB.prepare(`UPDATE folios SET status = 'cancelled' WHERE id = ?`)
      .bind(folioId)
      .run()

    const { json } = await scan(AGENT_EMAIL, token)
    expect(json.result).toBe('invalid')
    expect(json.reason).toBe('CANCELLED')
    expect(await getRedeemedCount(lineId)).toBe(0)
  })

  it('Scenario 8 — valid signature, missing line → not found', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const key = await deriveOrgKey(env.QR_SECRET, organizationId)
    const now = Math.floor(Date.now() / 1000)
    const payload: TicketPayload = {
      v: 1,
      folio_id: crypto.randomUUID(),
      folio_line_id: crypto.randomUUID(), // does not exist
      organization_id: organizationId,
      service_id: crypto.randomUUID(),
      slot_id: crypto.randomUUID(),
      client_identity: 'Ghost',
      passes_total: 1,
      issued_at: now,
      expires_at: now + 3600,
    }
    const token = await signTicket(payload, key)

    const { json } = await scan(AGENT_EMAIL, token)
    expect(json.result).toBe('invalid')
    expect(json.reason).toBe('NOT_FOUND')
    expect(json.ticket).toMatchObject({ client_identity: 'Ghost' })
  })

  it('Scenario 9 — last-pass race: only one redemption wins', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const { lineId, token } = await mintTicket(AGENT_EMAIL, organizationId, { quantity: 1 })

    const first = await scan(AGENT_EMAIL, token)
    const second = await scan(AGENT_EMAIL, token)

    expect(first.json.result).toBe('valid')
    expect(first.json.ticket.pass_number).toBe(1)
    expect(second.json.result).toBe('invalid')
    expect(second.json.reason).toBe('ALREADY_CONSUMED')
    expect(await getRedeemedCount(lineId)).toBe(1)
  })

  it('Scenario 10 — missing / empty token → 400', async () => {
    await seedUser({ email: AGENT_EMAIL, role: 'agent' })

    const empty = await SELF.fetch(`${TICKETS}/scan`, {
      method: 'POST',
      headers: jsonAuth(AGENT_EMAIL),
      body: JSON.stringify({ token: '' }),
    })
    expect(empty.status).toBe(400)
    expect(((await empty.json()) as any).error.code).toBe('VALIDATION_ERROR')

    const missing = await SELF.fetch(`${TICKETS}/scan`, {
      method: 'POST',
      headers: jsonAuth(AGENT_EMAIL),
      body: JSON.stringify({}),
    })
    expect(missing.status).toBe(400)
  })

  // US-A32 — granting access by scanning is a daily activity for BOTH roles; the admin
  // validates at the gate like an agent (a forged token still resolves to an invalid result,
  // not an authorization error).
  it('Scenario 11 — admin may scan (US-A32)', async () => {
    await seedUser({ email: ADMIN_EMAIL, role: 'admin' })
    const { status, json } = await scan(ADMIN_EMAIL, 'whatever')
    expect(status).toBe(200)
    expect(json.result).toBe('invalid')
    expect(json.reason).toBe('INVALID_SIGNATURE')
  })

  it('Scenario 12 — B3/B4: an org_a agent cannot mutate an org_b ticket', async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    const agentA = 'agent-a@empresa.com'
    const agentB = 'agent-b@empresa.com'
    await seedUser({ email: agentA, role: 'agent', organizationId: orgA.organizationId })
    await seedUser({ email: agentB, role: 'agent', organizationId: orgB.organizationId })

    const { lineId, token } = await mintTicket(agentB, orgB.organizationId, { quantity: 2 })

    // org_a scanning org_b's token: rejected by the per-org key, count never moves.
    const foreign = await scan(agentA, token)
    expect(foreign.json.result).toBe('invalid')
    expect(await getRedeemedCount(lineId)).toBe(0)

    // org_b's own agent redeems normally — the ticket itself is valid.
    const own = await scan(agentB, token)
    expect(own.json.result).toBe('valid')
    expect(await getRedeemedCount(lineId)).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// US-A64 — the scan result carries the zone (display-only; payload unchanged)
// ---------------------------------------------------------------------------
describe('US-A64 — zone on the scan result', () => {
  // Sell one zoned line and return its minted token.
  const mintZonedTicket = async (email: string, organizationId: string) => {
    const ts = Math.floor(Date.now() / 1000)
    const serviceId = crypto.randomUUID()
    await env.DB.prepare(
      `INSERT INTO services
         (id, organization_id, name, description, base_price, minimum_price, default_capacity,
          zones_enabled, status, created_at, updated_at)
       VALUES (?, ?, 'Turibus', NULL, 150000, 100000, 50, 1, 'active', ?, ?)`,
    )
      .bind(serviceId, organizationId, ts, ts)
      .run()
    const slotId = crypto.randomUUID()
    await env.DB.prepare(
      `INSERT INTO slots (id, organization_id, service_id, schedule_id, date, start_time, capacity, booked, status, created_at, updated_at)
       VALUES (?, ?, ?, NULL, '2026-06-15', '06:00', 50, 0, 'active', ?, ?)`,
    )
      .bind(slotId, organizationId, serviceId, ts, ts)
      .run()
    const zoneId = crypto.randomUUID()
    await env.DB.prepare(
      `INSERT INTO service_zones (id, organization_id, service_id, name, capacity, sort_order, status, created_at, updated_at)
       VALUES (?, ?, ?, 'Piso alto', 20, 0, 'active', ?, ?)`,
    )
      .bind(zoneId, organizationId, serviceId, ts, ts)
      .run()
    await env.DB.prepare(
      `INSERT INTO slot_zones (id, organization_id, slot_id, zone_id, capacity, booked, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 20, 0, 'active', ?, ?)`,
    )
      .bind(crypto.randomUUID(), organizationId, slotId, zoneId, ts, ts)
      .run()

    const res = await SELF.fetch(`${POS}/folios`, {
      method: 'POST',
      headers: jsonAuth(email),
      body: JSON.stringify({
        customer_name: 'Cliente Test',
        customer_phone: '5512345678',
        customer_email: 'cliente@example.com',
        lines: [{ slot_id: slotId, zone_id: zoneId, quantity: 1, unit_price: 150000 }],
      }),
    })
    const body = (await res.json()) as any
    expect(res.status, JSON.stringify(body)).toBe(201)
    return body.folio.lines[0].qr_token as string
  }

  it('Scenario 25 — a zoned ticket scans valid and shows its zone', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const token = await mintZonedTicket(AGENT_EMAIL, organizationId)

    const { status, json } = await scan(AGENT_EMAIL, token)
    expect(status).toBe(200)
    expect(json.result).toBe('valid')
    expect(json.ticket).toMatchObject({
      service_name: 'Turibus',
      zone_name: 'Piso alto',
      pass_number: 1,
    })
  })

  it('Scenario 26 — a pre-feature (unzoned) ticket still verifies, with no zone', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const { token } = await mintTicket(AGENT_EMAIL, organizationId)

    const { json } = await scan(AGENT_EMAIL, token)
    expect(json.result).toBe('valid')
    expect(json.ticket.zone_name).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// US-AG52 (D16) — a rescheduled ticket's PREDECESSOR must stop admitting
// ---------------------------------------------------------------------------
//
// Found while writing the e2e for the paid reschedule, and it was live: the reschedule re-signs
// the line's ticket, but nothing compared the SCANNED token against the line's current one. The
// old ticket's signature is genuine, its line still resolves, its folio is still paid, and its
// `expires_at` came from the OLD departure — so on a move to a later date it was still in the
// future and the scan returned `valid`, consuming a pass.
//
// The damage is not theoretical: the customer we told "tu boleto anterior deja de funcionar" could
// arrive on the ORIGINAL date, be admitted to a departure whose seat we had already returned to
// the pool, and burn a pass belonging to the new one — leaving the correct date reading
// ALREADY_CONSUMED at the dock.

describe('US-AG52 — the ticket a reschedule replaced', () => {
  const rescheduleTo = async (email: string, folioId: string, lineId: string, slotId: string) => {
    const res = await SELF.fetch(`${POS}/folios/${folioId}/reschedule`, {
      method: 'POST',
      headers: jsonAuth(email),
      body: JSON.stringify({ moves: [{ folio_line_id: lineId, to_slot_id: slotId }] }),
    })
    const body = (await res.json()) as any
    expect(res.status, JSON.stringify(body)).toBe(200)
    return body.folio.lines[0].qr_token as string
  }

  it('the OLD token is refused as SUPERSEDED, and burns no pass', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const serviceId = await seedService(organizationId)
    const from = await seedSlot(organizationId, serviceId, '2026-06-15')
    // A LATER departure: the old token's own expiry is still ahead, so only this check can catch it.
    const to = await seedSlot(organizationId, serviceId, '2026-06-25')

    const res = await SELF.fetch(`${POS}/folios`, {
      method: 'POST',
      headers: jsonAuth(AGENT_EMAIL),
      body: JSON.stringify({
        customer_name: 'Cliente Test',
        customer_phone: '5512345678',
        lines: [{ slot_id: from, quantity: 2, unit_price: 150000 }],
      }),
    })
    const folio = ((await res.json()) as any).folio
    const oldToken = folio.lines[0].qr_token as string

    const newToken = await rescheduleTo(AGENT_EMAIL, folio.id, folio.lines[0].id, to)
    expect(newToken).not.toBe(oldToken)

    const { status, json } = await scan(AGENT_EMAIL, oldToken)
    expect(status).toBe(200)
    expect(json.result).toBe('invalid')
    expect(json.reason).toBe('SUPERSEDED')
    // The staffer can still see WHOSE ticket it is and for what — that is what makes the result
    // actionable ("pídele el más reciente") instead of merely a refusal.
    expect(json.ticket).toMatchObject({ service_name: 'Canyon Tour', passes_total: 2 })

    // No pass consumed: the folio must be exactly as scannable as before the bad scan.
    const line = await env.DB.prepare(`SELECT redeemed_count FROM folio_lines WHERE id = ?`)
      .bind(folio.lines[0].id)
      .first<{ redeemed_count: number }>()
    expect(line!.redeemed_count).toBe(0)
  })

  it('the NEW token admits normally — the replacement is what works', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const serviceId = await seedService(organizationId)
    const from = await seedSlot(organizationId, serviceId, '2026-06-15')
    const to = await seedSlot(organizationId, serviceId, '2026-06-25')

    const res = await SELF.fetch(`${POS}/folios`, {
      method: 'POST',
      headers: jsonAuth(AGENT_EMAIL),
      body: JSON.stringify({
        customer_name: 'Cliente Test',
        customer_phone: '5512345678',
        lines: [{ slot_id: from, quantity: 2, unit_price: 150000 }],
      }),
    })
    const folio = ((await res.json()) as any).folio
    const newToken = await rescheduleTo(AGENT_EMAIL, folio.id, folio.lines[0].id, to)

    const { json } = await scan(AGENT_EMAIL, newToken)
    expect(json.result).toBe('valid')
    // And it reads the NEW departure, because the scanner takes the schedule from the line's live
    // row rather than the signed payload.
    expect(json.ticket).toMatchObject({ slot_date: '2026-06-25', pass_number: 1 })
  })

  it('a line with no ticket at all is left alone — pre-feature rows keep their validity', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const { token, lineId } = await mintTicket(AGENT_EMAIL, organizationId)
    // The column is what a pre-feature row lacks; the signed ticket in the customer's hand is not.
    await env.DB.prepare(`UPDATE folio_lines SET qr_token = NULL WHERE id = ?`).bind(lineId).run()

    const { json } = await scan(AGENT_EMAIL, token)
    // The guard must key on "this line has a DIFFERENT current ticket", never on "no match found".
    expect(json.result).toBe('valid')
  })
})
