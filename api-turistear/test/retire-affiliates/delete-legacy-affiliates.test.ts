import { describe, it, expect, beforeEach } from 'vitest'
import { env, SELF } from 'cloudflare:test'
// @ts-expect-error — vite's ?raw import; the test replays migration 0070 (delete-legacy-affiliates D9).
import migrationSql from '../../migrations/0070_delete_legacy_affiliates.sql?raw'
import { seedUser, seedTwoOrgs, seedFolioLedgerRows } from '../helpers/tenancy'
import { buildFakeJwt } from '../helpers/jwt'

// delete-legacy-affiliates US1 — specs/003-delete-legacy-affiliates/spec.md.
//
// Migration 0070 deletes every user stored with the retired role `affiliate` and everything tied
// to them, after handing back the seats their live lines held. The suite applies every migration
// to an empty D1 first, where 0070 finds nothing, so each case seeds the legacy shape and then
// replays the file as one batch (atomic on D1, as wrangler applies a migration file — research R3).

const API = 'http://api.local/api'
const AGENT_EMAIL = 'agent@empresa.com'
const LEGACY_EMAIL = 'gerente@hotelmaya.com'
const T0 = 1_784_800_000 // 2026-07-23, the prod sale's week

const TABLES = [
  'users',
  'services',
  'service_zones',
  'service_extras',
  'accommodation_unit_types',
  'slots',
  'slot_zones',
  'folios',
  'folio_lines',
  'folio_line_extras',
  'folio_payments',
  'folio_payment_allocations',
  'folio_events',
  'folio_access_tokens',
  'notifications',
  'folio_requests',
  'accommodation_reservations',
  'cash_drops',
  'payouts',
  'agent_expenses',
  'password_reset_tokens',
] as const
type Table = (typeof TABLES)[number]
type Row = Record<string, unknown>
type Dump = Record<Table, Row[]>

// FK-safe wipe, children first: the helpers' clearFullDb does not know zones or lodging.
const WIPE = [
  'folio_payment_allocations',
  'folio_line_extras',
  'folio_events',
  'folio_requests',
  'notifications',
  'folio_access_tokens',
  'accommodation_reservations',
  'folio_payments',
  'folio_lines',
  'folios',
  'cash_drops',
  'payouts',
  'agent_expenses',
  'slot_zones',
  'slots',
  'service_zones',
  'service_extras',
  'accommodation_unit_types',
  'schedules',
  'services',
  'invitations',
  'password_reset_tokens',
  'users',
  'organizations',
]

const uid = () => crypto.randomUUID()

const insert = async (table: string, row: Row): Promise<string> => {
  const cols = Object.keys(row)
  await env.DB.prepare(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
  )
    .bind(...cols.map((c) => row[c] ?? null))
    .run()
  return row.id as string
}

const dump = async (): Promise<Dump> => {
  const out = {} as Dump
  for (const t of TABLES) {
    out[t] = (await env.DB.prepare(`SELECT * FROM ${t} ORDER BY id`).all()).results as Row[]
  }
  return out
}

// The migration as wrangler sends it: comments stripped (they may carry semicolons), split into
// statements, run as ONE batch.
const runMigration = async () => {
  const statements = (migrationSql as string)
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
  expect(statements.length).toBeGreaterThan(0)
  await env.DB.batch(statements.map((s) => env.DB.prepare(s)))
}

interface World {
  orgA: string
  adminA: string
  agentA: string
  legacyId: string | null
  slotPlain: string
  slotZoned: string
  slotClamp: string
  slotOrgB: string
  zone1: string
  zone2: string
  agentPaymentId: string
  /** Every row the test seeded FOR the affiliate, by table — what 0070 must remove. */
  owned: Map<Table, Set<string>>
}

// One org with an agent and (optionally) a legacy affiliate selling on the same departures, and a
// second org that must stay untouched. Booked counters are seeded as the product would hold them.
const seedWorld = async ({ withAffiliate }: { withAffiliate: boolean }): Promise<World> => {
  const { orgA, orgB } = await seedTwoOrgs()
  const A = orgA.organizationId
  const B = orgB.organizationId
  const adminA = orgA.adminUserId
  const agentA = (await seedUser({ email: AGENT_EMAIL, role: 'agent', organizationId: A })).userId
  const agentB = (await seedUser({ email: 'agent-b@empresa.com', role: 'agent', organizationId: B }))
    .userId

  const owned = new Map<Table, Set<string>>()
  const own = (table: Table, id: string) => {
    if (!owned.has(table)) owned.set(table, new Set())
    owned.get(table)!.add(id)
    return id
  }

  let legacyId: string | null = null
  if (withAffiliate) {
    legacyId = own(
      'users',
      await insert('users', {
        id: uid(),
        organization_id: A,
        name: 'Gerente Maya',
        email: LEGACY_EMAIL,
        password_hash: 'H',
        password_salt: 'S',
        role: 'affiliate',
        status: 'active',
        plan: 'free',
      }),
    )
  }
  const aff = withAffiliate ? 1 : 0

  // Catalog — a tour (plain, clamp and zoned departures, one extra) and a lodging.
  const service = (org: string, name: string) =>
    insert('services', {
      id: uid(),
      organization_id: org,
      name,
      base_price: 10000,
      minimum_price: 10000,
      default_capacity: 30,
    })
  const tour = await service(A, 'Tour Cenotes')
  const lodging = await service(A, 'Cabañas')
  const tourB = await service(B, 'Tour B')
  const extra = await insert('service_extras', {
    id: uid(),
    organization_id: A,
    service_id: tour,
    name: 'Snorkel',
    price: 5000,
  })
  const unitType = await insert('accommodation_unit_types', {
    id: uid(),
    organization_id: A,
    service_id: lodging,
    name: 'Cabaña doble',
    beds: 1,
    base_occupancy: 2,
    max_capacity: 2,
    base_rate: 80000,
  })
  const zone = (name: string) =>
    insert('service_zones', { id: uid(), organization_id: A, service_id: tour, name, capacity: 10 })
  const zone1 = await zone('Preferente')
  const zone2 = await zone('General')

  const slot = (org: string, svc: string, date: string, capacity: number, booked: number) =>
    insert('slots', {
      id: uid(),
      organization_id: org,
      service_id: svc,
      date,
      start_time: '09:00',
      capacity,
      booked,
      status: 'active',
      created_at: T0,
      updated_at: T0,
    })
  // Plain: the agent's 5 + the affiliate's live 2. Their cancelled line (4) and the line of their
  // cancelled sale (6) already gave their seats back.
  const slotPlain = await slot(A, tour, '2026-07-23', 30, 5 + 2 * aff)
  // Clamp: a counter edited by hand below the affiliate's 3 seats.
  const slotClamp = await slot(A, tour, '2026-07-24', 10, 1 * aff)
  // Zoned: zone 1 holds the agent's 1 + the affiliate's 3, zone 2 the agent's 2; the departure's
  // totals are the zone sums.
  const slotZoned = await slot(A, tour, '2026-07-25', 20, 1 + 3 * aff + 2)
  const slotZone = (zoneId: string, booked: number) =>
    insert('slot_zones', {
      id: uid(),
      organization_id: A,
      slot_id: slotZoned,
      zone_id: zoneId,
      capacity: 10,
      booked,
      status: 'active',
      created_at: T0,
      updated_at: T0,
    })
  await slotZone(zone1, 1 + 3 * aff)
  await slotZone(zone2, 2)
  const slotOrgB = await slot(B, tourB, '2026-07-23', 30, 1)

  interface LineSpec {
    slotId?: string
    zoneId?: string
    qty: number
    cancelled?: boolean
    stay?: boolean
  }
  // A sale as confirmSale leaves it: folio, lines, a payment + commission ledger row, an
  // allocation per line, a `created` event and a ticket link.
  const sell = async (opts: {
    org: string
    seller: string
    serviceId: string
    lines: LineSpec[]
    cancelled?: boolean
    mine: boolean
  }) => {
    const mark = (table: Table, id: string) => (opts.mine ? own(table, id) : id)
    const total = opts.lines.reduce((s, l) => s + l.qty * 10000, 0)
    const folioId = mark(
      'folios',
      await insert('folios', {
        id: uid(),
        organization_id: opts.org,
        agent_id: opts.seller,
        customer_name: 'Huésped',
        subtotal: total,
        discount_total: 0,
        total,
        amount_paid: total,
        commission_amount: total / 10,
        cancelled_at: opts.cancelled ? T0 + 60 : null,
        cancelled_by: opts.cancelled ? adminA : null,
        created_at: T0,
        updated_at: T0,
      }),
    )
    const lineIds: string[] = []
    for (const l of opts.lines) {
      lineIds.push(
        mark(
          'folio_lines',
          await insert('folio_lines', {
            id: uid(),
            organization_id: opts.org,
            folio_id: folioId,
            service_id: l.stay ? lodging : opts.serviceId,
            slot_id: l.stay ? null : l.slotId,
            zone_id: l.zoneId ?? null,
            service_name: l.stay ? 'Cabañas' : 'Tour',
            slot_date: l.stay ? null : '2026-07-23',
            slot_start_time: l.stay ? null : '09:00',
            quantity: l.qty,
            base_price: 10000,
            minimum_price: 10000,
            unit_price: 10000,
            line_total: l.qty * 10000,
            line_type: l.stay ? 'stay' : 'slot',
            unit_type_id: l.stay ? unitType : null,
            check_in: l.stay ? '2026-07-23' : null,
            check_out: l.stay ? '2026-07-25' : null,
            guests: l.stay ? 2 : null,
            nights: l.stay ? 2 : null,
            cancelled_at: l.cancelled ? T0 + 30 : null,
            cancelled_by: l.cancelled ? adminA : null,
            created_at: T0,
          }),
        ),
      )
      if (l.stay) {
        mark(
          'accommodation_reservations',
          await insert('accommodation_reservations', {
            id: uid(),
            organization_id: opts.org,
            service_id: lodging,
            unit_type_id: unitType,
            folio_id: folioId,
            check_in: '2026-07-23',
            check_out: '2026-07-25',
            guests: 2,
            quantity: 1,
          }),
        )
      }
    }
    const payment = (entryType: string, amount: number) =>
      insert('folio_payments', {
        id: uid(),
        organization_id: opts.org,
        folio_id: folioId,
        entry_type: entryType,
        amount,
        method: 'cash',
        verification: 'not_required',
        collected_by: opts.seller,
        created_at: T0,
      })
    const paymentId = mark('folio_payments', await payment('payment', total))
    mark('folio_payments', await payment('commission', total / 10))
    for (const [i, lineId] of lineIds.entries()) {
      mark(
        'folio_payment_allocations',
        await insert('folio_payment_allocations', {
          id: uid(),
          organization_id: opts.org,
          payment_id: paymentId,
          folio_line_id: lineId,
          amount: opts.lines[i].qty * 10000,
        }),
      )
    }
    mark(
      'folio_events',
      await insert('folio_events', {
        id: uid(),
        organization_id: opts.org,
        folio_id: folioId,
        event_type: 'created',
        actor_id: opts.seller,
        created_at: T0,
      }),
    )
    mark(
      'folio_access_tokens',
      await insert('folio_access_tokens', {
        id: uid(),
        organization_id: opts.org,
        folio_id: folioId,
        token: uid(),
        expires_at: T0 + 86_400 * 30,
      }),
    )
    return { folioId, lineIds, paymentId }
  }

  // The agent: 5 seats plain, 1 + 2 zoned; a confirmed drop.
  const agentSale = await sell({
    org: A,
    seller: agentA,
    serviceId: tour,
    mine: false,
    lines: [
      { slotId: slotPlain, qty: 5 },
      { slotId: slotZoned, zoneId: zone1, qty: 1 },
      { slotId: slotZoned, zoneId: zone2, qty: 2 },
    ],
  })
  await insert('cash_drops', {
    id: uid(),
    organization_id: A,
    agent_id: agentA,
    amount: 50000,
    balance_before: 80000,
    status: 'confirmed',
    reviewed_by: adminA,
  })
  // Org B: one sale of its own.
  await sell({ org: B, seller: agentB, serviceId: tourB, mine: false, lines: [{ slotId: slotOrgB, qty: 1 }] })

  if (legacyId) {
    // Sale 1 — a live plain line with an extra; the admin verified a payment, a notification
    // went out, a request was resolved: other people's rows, but on the affiliate's sale.
    const s1 = await sell({ org: A, seller: legacyId, serviceId: tour, mine: true, lines: [{ slotId: slotPlain, qty: 2 }] })
    own(
      'folio_line_extras',
      await insert('folio_line_extras', {
        id: uid(),
        organization_id: A,
        folio_id: s1.folioId,
        folio_line_id: s1.lineIds[0],
        extra_id: extra,
        name: 'Snorkel',
        price: 5000,
        quantity: 1,
      }),
    )
    own(
      'folio_events',
      await insert('folio_events', {
        id: uid(),
        organization_id: A,
        folio_id: s1.folioId,
        event_type: 'payment',
        actor_id: adminA,
        created_at: T0 + 10,
      }),
    )
    own(
      'notifications',
      await insert('notifications', {
        id: uid(),
        organization_id: A,
        folio_id: s1.folioId,
        event: 'tickets',
        channel: 'whatsapp',
        sent_by: adminA,
      }),
    )
    own(
      'folio_requests',
      await insert('folio_requests', {
        id: uid(),
        organization_id: A,
        folio_id: s1.folioId,
        kind: 'cancellation',
        status: 'rejected',
        resolved_by: adminA,
      }),
    )
    // Sale 2 — a live zoned line, and a line already cancelled (its 4 seats already handed back).
    await sell({
      org: A,
      seller: legacyId,
      serviceId: tour,
      mine: true,
      lines: [
        { slotId: slotZoned, zoneId: zone1, qty: 3 },
        { slotId: slotPlain, qty: 4, cancelled: true },
      ],
    })
    // Sale 3 — a cancelled sale whose line was never stamped (the pre-line-cancellation shape).
    await sell({ org: A, seller: legacyId, serviceId: tour, mine: true, cancelled: true, lines: [{ slotId: slotPlain, qty: 6 }] })
    // Sale 4 — 3 seats on the hand-edited departure.
    await sell({ org: A, seller: legacyId, serviceId: tour, mine: true, lines: [{ slotId: slotClamp, qty: 3 }] })
    // Sale 5 — a lodging stay.
    await sell({ org: A, seller: legacyId, serviceId: tour, mine: true, lines: [{ stay: true, qty: 1 }] })

    own(
      'cash_drops',
      await insert('cash_drops', {
        id: uid(),
        organization_id: A,
        agent_id: legacyId,
        amount: 30000,
        balance_before: 36000,
        status: 'confirmed',
        reviewed_by: adminA,
      }),
    )
    own(
      'payouts',
      await insert('payouts', { id: uid(), organization_id: A, agent_id: legacyId, amount: 100, created_by: adminA }),
    )
    own(
      'agent_expenses',
      await insert('agent_expenses', {
        id: uid(),
        organization_id: A,
        agent_id: legacyId,
        description: 'Gasolina',
        amount: 2000,
      }),
    )
    own(
      'password_reset_tokens',
      await insert('password_reset_tokens', {
        id: uid(),
        user_id: legacyId,
        token: uid(),
        expires_at: T0 + 3600,
      }),
    )
  }

  return {
    orgA: A,
    adminA,
    agentA,
    legacyId,
    slotPlain,
    slotZoned,
    slotClamp,
    slotOrgB,
    zone1,
    zone2,
    agentPaymentId: agentSale.paymentId,
    owned,
  }
}

const byId = (rows: Row[]) => new Map(rows.map((r) => [r.id as string, r]))
const without = (row: Row | undefined, ...keys: string[]) => {
  const copy = { ...row }
  for (const k of keys) delete copy[k]
  return copy
}

beforeEach(async () => {
  for (const t of WIPE) await env.DB.exec(`DELETE FROM ${t}`)
})

describe('delete-legacy-affiliates US1 — no affiliate is left, and nothing of theirs', () => {
  it('deletes the affiliate and every row of theirs, and nothing else (FR-001, FR-003)', async () => {
    const w = await seedWorld({ withAffiliate: true })
    const before = await dump()

    await runMigration()
    const after = await dump()

    expect(
      (await env.DB.prepare(`SELECT count(*) n FROM users WHERE role = 'affiliate'`).first())?.n,
    ).toBe(0)
    for (const t of TABLES) {
      if (t === 'slots' || t === 'slot_zones') continue // seats: next case
      const mine = w.owned.get(t) ?? new Set()
      expect(after[t], t).toEqual(before[t].filter((r) => !mine.has(r.id as string)))
    }
    // Every table the affiliate had rows in lost them all.
    for (const [t, ids] of w.owned) {
      expect(after[t].some((r) => ids.has(r.id as string)), t).toBe(false)
    }
    expect((await env.DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual([])
  })

  it('hands back exactly the seats of the live lines, zone first, never below zero (FR-002)', async () => {
    const w = await seedWorld({ withAffiliate: true })
    const before = await dump()

    await runMigration()
    const after = await dump()

    const slots = byId(after.slots)
    const slotsBefore = byId(before.slots)
    // Plain: 7 → 5. The cancelled line (4) and the cancelled sale (6) are not released again.
    expect(slots.get(w.slotPlain)?.booked).toBe(5)
    // Clamp: 1 − 3 stops at 0.
    expect(slots.get(w.slotClamp)?.booked).toBe(0)
    // Zoned: zone 1 4 → 1, zone 2 untouched; the departure re-derived from its zones.
    const zones = new Map(after.slot_zones.map((z) => [z.zone_id as string, z]))
    expect(zones.get(w.zone1)?.booked).toBe(1)
    expect(zones.get(w.zone2)?.booked).toBe(2)
    expect(slots.get(w.slotZoned)).toMatchObject({ booked: 3, capacity: 20 })
    // Nothing else about a departure changes; org B's departure and zone 2 do not change at all.
    for (const id of [w.slotPlain, w.slotClamp, w.slotZoned]) {
      expect(without(slots.get(id), 'booked', 'updated_at')).toEqual(
        without(slotsBefore.get(id), 'booked', 'updated_at'),
      )
    }
    expect(slots.get(w.slotOrgB)).toEqual(slotsBefore.get(w.slotOrgB))
    expect(zones.get(w.zone2)).toEqual(before.slot_zones.find((z) => z.zone_id === w.zone2))
  })

  it('fails and changes nothing when another user’s row names the affiliate (D4)', async () => {
    const w = await seedWorld({ withAffiliate: true })
    // The affiliate collected the agent's payment: deleting it would delete the agent's money.
    await env.DB.prepare('UPDATE folio_payments SET collected_by = ? WHERE id = ?')
      .bind(w.legacyId, w.agentPaymentId)
      .run()
    const before = await dump()

    await expect(runMigration()).rejects.toThrow(/FOREIGN KEY/)

    expect(await dump()).toEqual(before)
  })

  it('changes nothing on a database without affiliates (US1 scenario 5)', async () => {
    await seedWorld({ withAffiliate: false })
    const before = await dump()

    await runMigration()

    expect(await dump()).toEqual(before)
  })
})

describe('delete-legacy-affiliates US2 — the product knows two roles, with no exception', () => {
  it('answers their session as a user that no longer exists, and their login as invalid', async () => {
    await seedWorld({ withAffiliate: true })
    await runMigration()

    const me = await SELF.fetch(`${API}/me`, {
      headers: { Cookie: `gm_access=${buildFakeJwt(LEGACY_EMAIL)}` },
    })
    expect(me.status).toBe(401)
    expect(((await me.json()) as any).error.code).toBe('UNAUTHORIZED')

    const login = await SELF.fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: LEGACY_EMAIL, password: 'cualquiera' }),
    })
    expect(login.status).toBe(401)
    expect(((await login.json()) as any).error.code).toBe('INVALID_CREDENTIALS')
  })

  it('refuses a suspended account and clears its session; lets an active one in (D5)', async () => {
    const admin = await seedUser({ email: 'admin@empresa.com', role: 'admin' })
    await seedUser({ email: AGENT_EMAIL, role: 'agent', organizationId: admin.organizationId })
    await seedUser({
      email: 'suspendido@empresa.com',
      role: 'agent',
      status: 'suspended',
      organizationId: admin.organizationId,
    })

    for (const email of ['admin@empresa.com', AGENT_EMAIL]) {
      const res = await SELF.fetch(`${API}/me`, { headers: { Cookie: `gm_access=${buildFakeJwt(email)}` } })
      expect(res.status, email).toBe(200)
    }
    const res = await SELF.fetch(`${API}/me`, {
      headers: { Cookie: `gm_access=${buildFakeJwt('suspendido@empresa.com')}` },
    })
    expect(res.status).toBe(403)
    expect(((await res.json()) as any).error.code).toBe('ACCOUNT_SUSPENDED')
    const cookies = res.headers.get('Set-Cookie') ?? ''
    expect(cookies).toMatch(/gm_access=;/)
    expect(cookies).toMatch(/gm_refresh=;/)
  })

  it('labels every seller of the commission CSV as Administrador or Agente (D6)', async () => {
    const admin = await seedUser({ email: 'admin@empresa.com', role: 'admin', name: 'Ana Admin' })
    const org = admin.organizationId
    const agent = await seedUser({ email: AGENT_EMAIL, role: 'agent', name: 'Beto Agente', organizationId: org })
    for (const seller of [admin.userId, agent.userId]) {
      const folioId = await insert('folios', {
        id: uid(),
        organization_id: org,
        agent_id: seller,
        customer_name: 'Huésped',
        subtotal: 36000,
        discount_total: 0,
        total: 36000,
        amount_paid: 36000,
        commission_amount: 0,
        created_at: T0,
        updated_at: T0,
      })
      await seedFolioLedgerRows({ folioId, organizationId: org, agentId: seller, amountPaid: 36000, createdAt: T0 })
    }

    const res = await SELF.fetch(`${API}/reports/commissions/export?from=2026-07-01&to=2026-07-31`, {
      headers: { Cookie: `gm_access=${buildFakeJwt('admin@empresa.com')}` },
    })
    expect(res.status).toBe(200)
    // Header first, TOTALS last; the seller rows between.
    const rows = (await res.text()).split('\r\n').filter(Boolean).slice(1, -1)
    expect(rows.map((r) => r.split(',').slice(0, 2).join(',')).sort()).toEqual([
      'Ana Admin,Administrador',
      'Beto Agente,Agente',
    ])
  })
})
