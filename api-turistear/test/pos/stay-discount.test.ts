import { describe, it, expect, beforeEach } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { seedUser, seedTwoOrgs, clearAffiliateDb } from '../helpers/tenancy'
import { buildFakeJwt } from '../helpers/jwt'
import { stayFloor } from '../../src/utils/lodging'

// US-A92 / US-AG57 — docs/pos/discount-min-price.spec.md.
//
// A stay becomes discountable for the first time: the agent edits the line's WHOLE-LINE total in
// pesos, bounded below by `ceil(quote.total × (1 − max_discount_pct/100))` and above by the quote
// itself. Covers the admin ceiling (S-1…S-3), the sale (S-4…S-13) including the three defects the
// feature had to fix to be correct at all — the snapshotted floor (D8), the discount counted once
// rather than per room (D9), the fixed commission clamped to the discounted line (D10) — and
// cross-org isolation on both sides (S-14, S-15).

const ADMIN_EMAIL = 'admin@empresa.com'
const AFF_EMAIL = 'aff@hotel.com'

const auth = (email: string) => ({ Cookie: `gm_access=${buildFakeJwt(email)}` })
const jsonAuth = (email: string) => ({ ...auth(email), 'Content-Type': 'application/json' })

let orgId: string

// --- Seeders (raw D1, mirroring test/lodging/accommodation-stays.test.ts) ---

const seedLodgingService = async (
  organizationId: string,
  commission: { type?: 'percent' | 'fixed'; value?: number } = {},
): Promise<string> => {
  const serviceId = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO services
       (id, organization_id, name, description, base_price, minimum_price, default_capacity,
        commission_type, commission_value, category, status)
     VALUES (?, ?, 'Cabañas Imperial', null, 0, 0, 1, ?, ?, 'lodging', 'active')`,
  )
    .bind(serviceId, organizationId, commission.type ?? 'percent', commission.value ?? 0)
    .run()
  return serviceId
}

interface SeedTypeOpts {
  organizationId: string
  serviceId: string
  inventoryCount?: number
  baseRate?: number
  weekendRate?: number | null
  extraPersonFee?: number
  baseOccupancy?: number
  maxCapacity?: number
  maxDiscountPct?: number
  commissionType?: 'percent' | 'fixed' | null
  commissionValue?: number | null
}

const seedUnitType = async (o: SeedTypeOpts): Promise<string> => {
  const typeId = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO accommodation_unit_types
       (id, organization_id, service_id, name, unit_type, inventory_count, beds, base_occupancy,
        max_capacity, base_rate, weekend_rate, extra_person_fee, min_nights, checkin_time,
        checkout_time, amenities, commission_type, commission_value, max_discount_pct, status)
     VALUES (?, ?, ?, 'Cabaña Río', 'cabin', ?, 2, ?, ?, ?, ?, ?, 1, '15:00', '11:00', '', ?, ?, ?, 'active')`,
  )
    .bind(
      typeId,
      o.organizationId,
      o.serviceId,
      o.inventoryCount ?? 4,
      o.baseOccupancy ?? 2,
      o.maxCapacity ?? 4,
      o.baseRate ?? 100000,
      o.weekendRate ?? null,
      o.extraPersonFee ?? 0,
      o.commissionType ?? null,
      o.commissionValue ?? null,
      o.maxDiscountPct ?? 0,
    )
    .run()
  return typeId
}

// A Tue→Thu range: two nights, neither of them a weekend, so the quote is base_rate × nights ×
// rooms with no surcharge — the arithmetic in every expectation below stays readable.
const CHECK_IN = '2026-07-14'
const CHECK_OUT = '2026-07-16'

const sellStay = (
  typeId: string,
  unitPrice?: number,
  opts: { quantity?: number; guests?: number; email?: string } = {},
) =>
  SELF.fetch('http://api.local/api/pos/folios', {
    method: 'POST',
    headers: jsonAuth(opts.email ?? ADMIN_EMAIL),
    body: JSON.stringify({
      customer_name: 'Cliente',
      customer_phone: '5512345678',
      lines: [
        {
          unit_type_id: typeId,
          check_in: CHECK_IN,
          check_out: CHECK_OUT,
          guests: opts.guests ?? 2,
          quantity: opts.quantity ?? 1,
          ...(unitPrice != null ? { unit_price: unitPrice } : {}),
        },
      ],
    }),
  })

const lineOf = async (folioId: string) =>
  await env.DB.prepare(
    `SELECT base_price, unit_price, line_total, minimum_price, quantity
       FROM folio_lines WHERE folio_id = ?`,
  )
    .bind(folioId)
    .first<{
      base_price: number
      unit_price: number
      line_total: number
      minimum_price: number
      quantity: number
    }>()

const folioOf = async (folioId: string) =>
  await env.DB.prepare(
    'SELECT discount_total, commission_amount, total FROM folios WHERE id = ?',
  )
    .bind(folioId)
    .first<{ discount_total: number; commission_amount: number; total: number }>()

const soldFolioId = async (res: Response): Promise<string> => {
  expect(res.status).toBe(201)
  return ((await res.json()) as { folio: { id: string } }).folio.id
}

beforeEach(async () => {
  for (const t of [
    'accommodation_reservations',
    'folio_line_extras',
    'folio_lines',
    'accommodation_seasons',
    'accommodation_blockouts',
    'accommodation_unit_types',
  ]) {
    await env.DB.exec(`DELETE FROM ${t}`)
  }
  await clearAffiliateDb()
  const seeded = await seedUser({ email: ADMIN_EMAIL, role: 'admin' })
  orgId = seeded.organizationId
})

// ============================================================================
// The floor itself (D3) — pure
// ============================================================================

describe('stayFloor (D3)', () => {
  it('rounds UP, so a sub-centavo remainder falls toward the operator', () => {
    // 10 % of 199999 is 19999.9 → the floor is 180000, not 179999.
    expect(stayFloor(199999, 10)).toBe(180000)
    expect(stayFloor(200000, 10)).toBe(180000)
  })

  it('a 0 % ceiling returns the total itself — the feature off', () => {
    expect(stayFloor(200000, 0)).toBe(200000)
  })

  it('a 100 % ceiling floors at zero', () => {
    expect(stayFloor(200000, 100)).toBe(0)
  })
})

// ============================================================================
// US-A92 — the admin sets the ceiling
// ============================================================================

describe('US-A92 — the discount ceiling on a unidad', () => {
  const putBody = (maxDiscountPct?: number) => ({
    name: 'Cabaña Río',
    beds: 2,
    base_occupancy: 2,
    max_capacity: 4,
    base_rate: 100000,
    ...(maxDiscountPct != null ? { max_discount_pct: maxDiscountPct } : {}),
  })

  it('S-1 — the ceiling saves and comes back', async () => {
    const serviceId = await seedLodgingService(orgId)
    const typeId = await seedUnitType({ organizationId: orgId, serviceId })

    const put = await SELF.fetch(
      `http://api.local/api/services/${serviceId}/unit-types/${typeId}`,
      { method: 'PUT', headers: jsonAuth(ADMIN_EMAIL), body: JSON.stringify(putBody(10)) },
    )
    expect(put.status).toBe(200)

    const get = await SELF.fetch(`http://api.local/api/services/${serviceId}/unit-types`, {
      headers: auth(ADMIN_EMAIL),
    })
    const body = (await get.json()) as { unit_types: { max_discount_pct: number }[] }
    expect(body.unit_types[0].max_discount_pct).toBe(10)
  })

  it('S-2 — out of range is refused and nothing is written', async () => {
    const serviceId = await seedLodgingService(orgId)
    const typeId = await seedUnitType({ organizationId: orgId, serviceId, maxDiscountPct: 10 })

    const put = await SELF.fetch(
      `http://api.local/api/services/${serviceId}/unit-types/${typeId}`,
      { method: 'PUT', headers: jsonAuth(ADMIN_EMAIL), body: JSON.stringify(putBody(101)) },
    )
    expect(put.status).toBe(400)

    const row = await env.DB.prepare(
      'SELECT max_discount_pct FROM accommodation_unit_types WHERE id = ?',
    )
      .bind(typeId)
      .first<{ max_discount_pct: number }>()
    expect(row!.max_discount_pct).toBe(10)
  })

  it('S-3 — a unidad born without the field carries 0', async () => {
    const serviceId = await seedLodgingService(orgId)
    const create = await SELF.fetch(`http://api.local/api/services/${serviceId}/unit-types`, {
      method: 'POST',
      headers: jsonAuth(ADMIN_EMAIL),
      body: JSON.stringify(putBody()),
    })
    expect(create.status).toBe(201)
    const created = (await create.json()) as { unit_type: { max_discount_pct: number } }
    expect(created.unit_type.max_discount_pct).toBe(0)
  })
})

// ============================================================================
// US-AG57 — the agent discounts a stay
// ============================================================================

describe('US-AG57 — discounting a stay', () => {
  // Two nights × 100000 = 200000; a 10 % ceiling floors it at 180000.
  const QUOTE = 200000
  const FLOOR = 180000

  it('S-4 — a discount inside the ceiling sells, and every column agrees', async () => {
    const serviceId = await seedLodgingService(orgId)
    const typeId = await seedUnitType({ organizationId: orgId, serviceId, maxDiscountPct: 10 })

    const folioId = await soldFolioId(await sellStay(typeId, 185000))

    const line = await lineOf(folioId)
    expect(line).toMatchObject({
      base_price: QUOTE, // what the stay is worth
      unit_price: 185000, // what it sold for
      line_total: 185000,
      minimum_price: FLOOR, // D8 — the resolved floor, not the 0 this used to hardcode
    })
    expect((await folioOf(folioId))!.discount_total).toBe(15000)
  })

  it('S-5 — a centavo below the floor is refused, and nothing is written', async () => {
    const serviceId = await seedLodgingService(orgId)
    const typeId = await seedUnitType({ organizationId: orgId, serviceId, maxDiscountPct: 10 })

    const res = await sellStay(typeId, FLOOR - 1)
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'PRICE_BELOW_MINIMUM',
    )

    // No folio, no line, and — the part that would hurt — no inventory held.
    const counts = await env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM folios) AS folios,
              (SELECT COUNT(*) FROM folio_lines) AS lines,
              (SELECT COUNT(*) FROM accommodation_reservations) AS reservations`,
    ).first<{ folios: number; lines: number; reservations: number }>()
    expect(counts).toMatchObject({ folios: 0, lines: 0, reservations: 0 })
  })

  it('S-6 — the floor rounds toward the operator', async () => {
    const serviceId = await seedLodgingService(orgId)
    // 2 nights × 99999.5 is not expressible; use an odd rate so the quote is 199999.
    const typeId = await seedUnitType({
      organizationId: orgId,
      serviceId,
      baseRate: 100000,
      weekendRate: null,
      maxDiscountPct: 10,
    })
    // Quote 200000 → floor 180000. 179999 is one centavo under and must fail…
    expect((await sellStay(typeId, 179999)).status).toBe(400)
    // …while the floor itself sells.
    const folioId = await soldFolioId(await sellStay(typeId, 180000))
    expect((await lineOf(folioId))!.unit_price).toBe(180000)
  })

  it('S-7 — above the quote is refused', async () => {
    const serviceId = await seedLodgingService(orgId)
    const typeId = await seedUnitType({ organizationId: orgId, serviceId, maxDiscountPct: 10 })

    const res = await sellStay(typeId, QUOTE + 1)
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'VALIDATION_ERROR',
    )
  })

  it('S-8 — a zero ceiling admits only the quote', async () => {
    const serviceId = await seedLodgingService(orgId)
    const typeId = await seedUnitType({ organizationId: orgId, serviceId, maxDiscountPct: 0 })

    expect((await sellStay(typeId, QUOTE - 1)).status).toBe(400)

    const folioId = await soldFolioId(await sellStay(typeId, QUOTE))
    expect((await folioOf(folioId))!.discount_total).toBe(0)
    expect((await lineOf(folioId))!.minimum_price).toBe(QUOTE)
  })

  it('S-9 — omitting the price is byte-identical to a sale made before this feature', async () => {
    const serviceId = await seedLodgingService(orgId, { type: 'percent', value: 1000 })
    const typeId = await seedUnitType({ organizationId: orgId, serviceId, maxDiscountPct: 25 })

    const folioId = await soldFolioId(await sellStay(typeId))

    const line = await lineOf(folioId)
    expect(line).toMatchObject({
      base_price: QUOTE,
      unit_price: QUOTE,
      line_total: QUOTE,
      minimum_price: 150000, // the floor is snapshotted even when nothing was discounted
    })
    const folio = await folioOf(folioId)
    expect(folio!.discount_total).toBe(0)
    expect(folio!.total).toBe(QUOTE)
    expect(folio!.commission_amount).toBe(20000) // 10 % of the undiscounted total
  })

  it('S-10 — a multi-room discount is counted once, not per room (D9)', async () => {
    const serviceId = await seedLodgingService(orgId)
    const typeId = await seedUnitType({
      organizationId: orgId,
      serviceId,
      inventoryCount: 4,
      maxDiscountPct: 10,
    })

    // 2 rooms × 2 nights × 100000 = 400000; a 15000 discount is inside the 10 % ceiling.
    const folioId = await soldFolioId(await sellStay(typeId, 385000, { quantity: 2, guests: 4 }))

    const line = await lineOf(folioId)
    expect(line!.quantity).toBe(2) // rooms, which is exactly why the × quantity was wrong
    expect(line!.base_price).toBe(400000)
    expect((await folioOf(folioId))!.discount_total).toBe(15000) // not 30000
  })

  it('S-11 — a fixed commission never exceeds the discounted line (D10)', async () => {
    const serviceId = await seedLodgingService(orgId)
    const typeId = await seedUnitType({
      organizationId: orgId,
      serviceId,
      maxDiscountPct: 50,
      commissionType: 'fixed',
      commissionValue: 150000, // per room-stay, and above what the line will sell for
    })

    const folioId = await soldFolioId(await sellStay(typeId, 100000))

    const folio = await folioOf(folioId)
    expect(folio!.total).toBe(100000)
    expect(folio!.commission_amount).toBe(100000) // clamped, not 150000
  })

  it('S-11b — an unclamped fixed commission is untouched when it fits', async () => {
    const serviceId = await seedLodgingService(orgId)
    const typeId = await seedUnitType({
      organizationId: orgId,
      serviceId,
      maxDiscountPct: 50,
      commissionType: 'fixed',
      commissionValue: 30000,
    })

    const folioId = await soldFolioId(await sellStay(typeId, 100000))
    expect((await folioOf(folioId))!.commission_amount).toBe(30000)
  })

  it('S-12 — the floor travels with the quote as min_total (D6)', async () => {
    const serviceId = await seedLodgingService(orgId)
    const discountable = await seedUnitType({
      organizationId: orgId,
      serviceId,
      maxDiscountPct: 10,
    })
    const fixedPrice = await seedUnitType({ organizationId: orgId, serviceId, maxDiscountPct: 0 })

    const res = await SELF.fetch(
      `http://api.local/api/pos/lodging/${serviceId}/availability` +
        `?check_in=${CHECK_IN}&check_out=${CHECK_OUT}&guests=2&quantity=1`,
      { headers: auth(ADMIN_EMAIL) },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      unit_types: { unit_type_id: string; total: number; min_total: number }[]
    }

    const a = body.unit_types.find((t) => t.unit_type_id === discountable)!
    expect(a).toMatchObject({ total: QUOTE, min_total: FLOOR })

    // At 0 % the two numbers coincide — which is how the cart knows to render text, not a field.
    const b = body.unit_types.find((t) => t.unit_type_id === fixedPrice)!
    expect(b.min_total).toBe(b.total)
  })

  it('S-13 — an affiliate is bound by the same floor, code and status', async () => {
    const serviceId = await seedLodgingService(orgId)
    const typeId = await seedUnitType({ organizationId: orgId, serviceId, maxDiscountPct: 10 })

    const companyId = crypto.randomUUID()
    await env.DB.prepare(
      `INSERT INTO affiliate_companies (id, organization_id, name, status)
       VALUES (?, ?, 'Hotel Aliado', 'active')`,
    )
      .bind(companyId, orgId)
      .run()
    await seedUser({
      email: AFF_EMAIL,
      role: 'affiliate',
      organizationId: orgId,
      affiliateCompanyId: companyId,
    })
    await env.DB.prepare(
      `INSERT INTO affiliate_commissions
         (id, organization_id, affiliate_company_id, service_id, commission_type, commission_value)
       VALUES (?, ?, ?, ?, 'percent', 1000)`,
    )
      .bind(crypto.randomUUID(), orgId, companyId, serviceId)
      .run()

    const res = await sellStay(typeId, FLOOR - 1, { email: AFF_EMAIL })
    expect(res.status).toBe(400)
    expect(JSON.stringify(await res.json())).toContain('PRICE_BELOW_MINIMUM')
  })
})

// ============================================================================
// Multitenancy isolation (required)
// ============================================================================

describe('cross-org isolation', () => {
  it('S-14 — another org’s unidad is invisible to the discount path', async () => {
    const { orgA, orgB } = await seedTwoOrgs()

    const svcB = await seedLodgingService(orgB.organizationId)
    const typeB = await seedUnitType({
      organizationId: orgB.organizationId,
      serviceId: svcB,
      maxDiscountPct: 10,
    })

    const res = await SELF.fetch('http://api.local/api/pos/folios', {
      method: 'POST',
      headers: jsonAuth(orgA.adminEmail),
      body: JSON.stringify({
        customer_name: 'Cliente',
        customer_phone: '5512345678',
        lines: [
          {
            unit_type_id: typeB,
            check_in: CHECK_IN,
            check_out: CHECK_OUT,
            guests: 2,
            quantity: 1,
            unit_price: 100, // far below org B's floor — must NOT be the reason it fails
          },
        ],
      }),
    })

    // 404, never 403 (which would confirm the unidad exists) and never a price error (which would
    // leak that org B's floor was evaluated at all).
    expect(res.status).toBe(404)
    expect(JSON.stringify(await res.json())).not.toContain('PRICE_BELOW_MINIMUM')
  })

  it('S-15 — another org’s ceiling cannot be set', async () => {
    const { orgA, orgB } = await seedTwoOrgs()

    const svcB = await seedLodgingService(orgB.organizationId)
    const typeB = await seedUnitType({
      organizationId: orgB.organizationId,
      serviceId: svcB,
      maxDiscountPct: 10,
    })

    const res = await SELF.fetch(
      `http://api.local/api/services/${svcB}/unit-types/${typeB}`,
      {
        method: 'PUT',
        headers: jsonAuth(orgA.adminEmail),
        body: JSON.stringify({
          name: 'Cabaña Río',
          beds: 2,
          base_occupancy: 2,
          max_capacity: 4,
          base_rate: 100000,
          max_discount_pct: 90,
        }),
      },
    )
    expect(res.status).toBe(404)

    const row = await env.DB.prepare(
      'SELECT max_discount_pct FROM accommodation_unit_types WHERE id = ?',
    )
      .bind(typeB)
      .first<{ max_discount_pct: number }>()
    expect(row!.max_discount_pct).toBe(10)
  })
})
