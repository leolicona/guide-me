import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { seedUser, seedAffiliateCompany, seedAffiliateCommission } from '../helpers/tenancy'
import { buildFakeJwt } from '../helpers/jwt'

// US-AF10–AF13 / US-OP01–OP02 / US-A68 — temporary PIN access for affiliate operators.
// docs/affiliate-operators/spec.md. The suite clock is frozen (apply-migrations.ts); a slot 3 days
// out is always sellable.

const MGR_EMAIL = 'gerente@hotel.com'
const CORRECT_PIN = '1234'
const base = 'http://api.local'

const auth = (email: string) => ({ Cookie: `gm_access=${buildFakeJwt(email)}` })
const jsonAuth = (email: string) => ({ ...auth(email), 'Content-Type': 'application/json' })

// The PIN is hashed through the agnostic-auth service on a DERIVED secret (utils/pin.ts —
// derivePinSecret), so the mock stays transform-agnostic: /auth/hash echoes the derived secret back
// as the stored hash, and /auth/verify-password succeeds iff the attempted secret equals it. This
// mirrors a real hash/verify without the test knowing the PIN→secret derivation.
const mockAuth = () => {
  vi.spyOn(env.AGNOSTIC_AUTH_API, 'fetch').mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const pathname = new URL(url).pathname
      const body = init?.body ? JSON.parse(init.body as string) : {}
      if (pathname === '/auth/hash') {
        return new Response(
          JSON.stringify({ success: true, data: { hash: body.password, salt: 'S' } }),
          { status: 200 },
        )
      }
      if (pathname === '/auth/verify-password') {
        const ok = body.attemptedPassword === body.storedHash
        return new Response(
          JSON.stringify(
            ok
              ? { success: true, data: { jwt: 'j', refreshToken: 'r' } }
              : { success: false, error: { code: 'INVALID_CREDENTIALS' } },
          ),
          { status: ok ? 200 : 401 },
        )
      }
      return new Response('{"success":false}', { status: 404 })
    },
  )
}

const clearAll = async () => {
  for (const t of [
    'folio_line_extras', 'folio_lines', 'folio_access_tokens', 'cancellation_requests',
    'accommodation_reservations', 'folios', 'affiliate_operators', 'affiliate_commissions',
    'affiliate_invitations', 'slots', 'schedules', 'service_extras', 'services',
    'invitations', 'password_reset_tokens', 'users', 'affiliate_companies', 'organizations',
  ]) {
    await env.DB.exec(`DELETE FROM ${t}`)
  }
}

const todayStr = (): string => new Date().toISOString().slice(0, 10)
const addDays = (d: string, n: number): string =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)

const seedService = async (organizationId: string): Promise<string> => {
  const id = crypto.randomUUID()
  const ts = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO services (id, organization_id, name, description, base_price, minimum_price, default_capacity, commission_type, commission_value, status, created_at, updated_at)
     VALUES (?, ?, 'Tour', NULL, 150000, 100000, 12, 'percent', 1000, 'active', ?, ?)`,
  ).bind(id, organizationId, ts, ts).run()
  return id
}

const seedSlot = async (organizationId: string, serviceId: string): Promise<string> => {
  const id = crypto.randomUUID()
  const ts = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO slots (id, organization_id, service_id, schedule_id, date, start_time, capacity, booked, status, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, '06:00', 12, 0, 'active', ?, ?)`,
  ).bind(id, organizationId, serviceId, addDays(todayStr(), 3), ts, ts).run()
  return id
}

// A full affiliate hotel: org + company + manager(affiliate) + a curated sellable service/slot.
const seedHotel = async (opts: { managerEmail?: string; orgId?: string } = {}) => {
  const managerEmail = opts.managerEmail ?? MGR_EMAIL
  const admin = await seedUser({ email: `admin-${crypto.randomUUID()}@x.com`, role: 'admin', organizationId: opts.orgId })
  const orgId = admin.organizationId
  const { companyId } = await seedAffiliateCompany({ organizationId: orgId })
  const mgr = await seedUser({ email: managerEmail, role: 'affiliate', organizationId: orgId, affiliateCompanyId: companyId })
  const serviceId = await seedService(orgId)
  await seedAffiliateCommission({ organizationId: orgId, affiliateCompanyId: companyId, serviceId })
  const slotId = await seedSlot(orgId, serviceId)
  return { orgId, companyId, managerId: mgr.userId, managerEmail, serviceId, slotId }
}

const opCookie = (res: Response): string | null => {
  const set = res.headers.getSetCookie?.() ?? []
  const c = set.find((s) => s.startsWith('gm_op='))
  return c ? c.split(';')[0] : null
}

const createOperator = async (email: string, name = 'Juan', phone = '5512340001') => {
  const res = await SELF.fetch(`${base}/api/affiliate/operators`, {
    method: 'POST',
    headers: jsonAuth(email),
    body: JSON.stringify({ name, phone }),
  })
  return { status: res.status, json: (await res.json().catch(() => ({}))) as any }
}

// Resolve the access token from an operator's access_url (…/o/<token>).
const tokenOf = (accessUrl: string): string => accessUrl.split('/o/')[1]

beforeEach(async () => {
  await clearAll()
  mockAuth()
})
afterEach(() => vi.restoreAllMocks())

describe('US-AF10 — manager registers operators', () => {
  it('creates an operator with name + phone (no PIN yet, active, access link issued)', async () => {
    const { managerEmail } = await seedHotel()
    const { status, json } = await createOperator(managerEmail)
    expect(status).toBe(201)
    expect(json.operator.name).toBe('Juan')
    expect(json.operator.status).toBe('active')
    expect(json.operator.pin_set).toBe(false)
    expect(json.operator.access_url).toContain('/o/')
  })

  it('rejects a second ACTIVE operator with the same phone → 409', async () => {
    const { managerEmail } = await seedHotel()
    await createOperator(managerEmail, 'Juan', '5512340001')
    const { status } = await createOperator(managerEmail, 'Pedro', '55 1234 0001')
    expect(status).toBe(409)
  })

  it('lists the company operators', async () => {
    const { managerEmail } = await seedHotel()
    await createOperator(managerEmail, 'Juan', '5512340001')
    await createOperator(managerEmail, 'Ana', '5512340002')
    const res = await SELF.fetch(`${base}/api/affiliate/operators`, { headers: auth(managerEmail) })
    const json = (await res.json()) as any
    expect(json.operators).toHaveLength(2)
  })
})

describe('US-OP01/OP02 — PIN setup, unlock, lockout', () => {
  it('first-run set-pin mints a shift session; /api/me resolves the manager + operator', async () => {
    const { managerEmail, managerId } = await seedHotel()
    const { json } = await createOperator(managerEmail)
    const token = tokenOf(json.operator.access_url)

    const setRes = await SELF.fetch(`${base}/api/operator/access/${token}/set-pin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: CORRECT_PIN, confirm: CORRECT_PIN }),
    })
    expect(setRes.status).toBe(201)
    const cookie = opCookie(setRes)
    expect(cookie).toBeTruthy()

    const me = await SELF.fetch(`${base}/api/me`, { headers: { Cookie: cookie! } })
    const meJson = (await me.json()) as any
    expect(meJson.user.userId).toBe(managerId) // borrows the manager identity
    expect(meJson.user.role).toBe('affiliate')
    expect(meJson.operator.name).toBe('Juan')
  })

  it('set-pin twice → 409', async () => {
    const { managerEmail } = await seedHotel()
    const { json } = await createOperator(managerEmail)
    const token = tokenOf(json.operator.access_url)
    const body = JSON.stringify({ pin: CORRECT_PIN, confirm: CORRECT_PIN })
    await SELF.fetch(`${base}/api/operator/access/${token}/set-pin`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
    const again = await SELF.fetch(`${base}/api/operator/access/${token}/set-pin`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
    expect(again.status).toBe(409)
  })

  it('daily login: correct PIN mints a session; 5 wrong PINs lock (423)', async () => {
    const { managerEmail } = await seedHotel()
    const { json } = await createOperator(managerEmail)
    const token = tokenOf(json.operator.access_url)
    await SELF.fetch(`${base}/api/operator/access/${token}/set-pin`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: CORRECT_PIN, confirm: CORRECT_PIN }),
    })

    const login = (pin: string) =>
      SELF.fetch(`${base}/api/operator/access/${token}/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }),
      })

    const good = await login(CORRECT_PIN)
    expect(good.status).toBe(200)
    expect(opCookie(good)).toBeTruthy()

    for (let i = 0; i < 4; i++) expect((await login('0000')).status).toBe(401)
    const fifth = await login('0000')
    expect(fifth.status).toBe(423) // locked
    // Even the correct PIN is now refused until a manager resets.
    expect((await login(CORRECT_PIN)).status).toBe(423)
  })
})

describe('US-AF13 — operator sells; sale is attributed', () => {
  const sellAs = async (cookie: string, slotId: string) =>
    SELF.fetch(`${base}/api/pos/folios`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customer_name: 'Cliente', customer_phone: '5512349999', payment_method: 'cash',
        lines: [{ slot_id: slotId, quantity: 1, unit_price: 150000 }],
      }),
    })

  it('a folio sold in a shift carries the operator name; the manager filters by operator', async () => {
    const { managerEmail, slotId } = await seedHotel()
    const { json } = await createOperator(managerEmail)
    const token = tokenOf(json.operator.access_url)
    const setRes = await SELF.fetch(`${base}/api/operator/access/${token}/set-pin`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: CORRECT_PIN, confirm: CORRECT_PIN }),
    })
    const cookie = opCookie(setRes)!

    const sold = await sellAs(cookie, slotId)
    expect(sold.status).toBe(201)
    const soldJson = (await sold.json()) as any
    expect(soldJson.folio.operator_name).toBe('Juan')

    // Manager's history shows the operator label + filters by it (agent_id = manager).
    const hist = await SELF.fetch(`${base}/api/pos/folios`, { headers: auth(managerEmail) })
    const histJson = (await hist.json()) as any
    expect(histJson.folios[0].operator_name).toBe('Juan')

    const filtered = await SELF.fetch(`${base}/api/pos/folios?operator=${soldJson.folio.id}`, { headers: auth(managerEmail) })
    // Wrong id (a folio id, not an operator id) yields nothing — proves the filter is applied.
    expect(((await filtered.json()) as any).folios).toHaveLength(0)
  })

  it('a folio the manager sells directly has no operator_name', async () => {
    const { managerEmail, slotId } = await seedHotel()
    const sold = await sellAs(`gm_access=${buildFakeJwt(managerEmail)}`, slotId)
    expect(sold.status).toBe(201)
    expect(((await sold.json()) as any).folio.operator_name).toBeNull()
  })

  it('an operator session is FORBIDDEN from the operators-management panel (D6)', async () => {
    const { managerEmail } = await seedHotel()
    const { json } = await createOperator(managerEmail)
    const token = tokenOf(json.operator.access_url)
    const setRes = await SELF.fetch(`${base}/api/operator/access/${token}/set-pin`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: CORRECT_PIN, confirm: CORRECT_PIN }),
    })
    const cookie = opCookie(setRes)!
    const list = await SELF.fetch(`${base}/api/affiliate/operators`, { headers: { Cookie: cookie } })
    expect(list.status).toBe(403)
    const create = await SELF.fetch(`${base}/api/affiliate/operators`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Otro', phone: '5599990000' }),
    })
    expect(create.status).toBe(403)
  })
})

describe('US-AF12 — remove & reset', () => {
  it('remove kills the link + shift but preserves past folio attribution', async () => {
    const { managerEmail, slotId } = await seedHotel()
    const { json } = await createOperator(managerEmail)
    const opId = json.operator.id
    const token = tokenOf(json.operator.access_url)
    const setRes = await SELF.fetch(`${base}/api/operator/access/${token}/set-pin`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: CORRECT_PIN, confirm: CORRECT_PIN }),
    })
    const cookie = opCookie(setRes)!

    // Sell one folio, then remove the operator.
    const sold = await SELF.fetch(`${base}/api/pos/folios`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ customer_name: 'C', customer_phone: '5512349999', payment_method: 'cash', lines: [{ slot_id: slotId, quantity: 1, unit_price: 150000 }] }),
    })
    const folioId = ((await sold.json()) as any).folio.id

    const rm = await SELF.fetch(`${base}/api/affiliate/operators/${opId}/remove`, { method: 'POST', headers: auth(managerEmail) })
    expect(rm.status).toBe(200)

    // The shift session is dead (operator no longer active).
    const meAfter = await SELF.fetch(`${base}/api/me`, { headers: { Cookie: cookie } })
    expect(meAfter.status).toBe(401)
    // The saved link is void.
    expect((await SELF.fetch(`${base}/api/operator/access/${token}`)).status).toBe(404)
    // Past folio keeps "Vendido por: Juan".
    const folio = await SELF.fetch(`${base}/api/pos/folios/${folioId}`, { headers: auth(managerEmail) })
    expect(((await folio.json()) as any).folio.operator_name).toBe('Juan')
  })

  it('reset-pin rotates the token (old link 404) and clears the PIN', async () => {
    const { managerEmail } = await seedHotel()
    const { json } = await createOperator(managerEmail)
    const opId = json.operator.id
    const oldToken = tokenOf(json.operator.access_url)
    await SELF.fetch(`${base}/api/operator/access/${oldToken}/set-pin`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: CORRECT_PIN, confirm: CORRECT_PIN }),
    })

    const reset = await SELF.fetch(`${base}/api/affiliate/operators/${opId}/reset-pin`, { method: 'POST', headers: auth(managerEmail) })
    expect(reset.status).toBe(200)
    const resetJson = (await reset.json()) as any
    expect(resetJson.operator.pin_set).toBe(false)
    const newToken = tokenOf(resetJson.operator.access_url)
    expect(newToken).not.toBe(oldToken)
    // Old link dead; new link resolves as first-run.
    expect((await SELF.fetch(`${base}/api/operator/access/${oldToken}`)).status).toBe(404)
    const resolved = await SELF.fetch(`${base}/api/operator/access/${newToken}`)
    expect(resolved.status).toBe(200)
    expect(((await resolved.json()) as any).operator.pin_set).toBe(false)
  })
})

describe('cross-org isolation (B3)', () => {
  it('a manager cannot reset another company’s operator → 404', async () => {
    const hotelA = await seedHotel({ managerEmail: 'mgr-a@hotel.com' })
    const hotelB = await seedHotel({ managerEmail: 'mgr-b@hotel.com' })
    const { json } = await createOperator(hotelA.managerEmail)
    const opId = json.operator.id
    // Hotel B's manager tries to reset hotel A's operator.
    const res = await SELF.fetch(`${base}/api/affiliate/operators/${opId}/reset-pin`, {
      method: 'POST', headers: auth(hotelB.managerEmail),
    })
    expect(res.status).toBe(404)
  })
})
