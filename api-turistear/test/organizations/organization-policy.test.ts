import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { seedUser, seedTwoOrgs, clearTenancyDb } from '../helpers/tenancy'
import { buildFakeJwt } from '../helpers/jwt'

// US-A46 — org booking policy (minimum deposit %, hold days, same-day buffer).
// Spec: docs/bookings/bookings-down-payments.spec.md (Sc.15 admin policy + isolation).

const auth = (email: string) => ({ Cookie: `gm_access=${buildFakeJwt(email)}` })
const jsonAuth = (email: string) => ({ ...auth(email), 'Content-Type': 'application/json' })
const base = 'http://api.local/api/organizations'

const put = async (email: string, body: Record<string, unknown>) => {
  const res = await SELF.fetch(`${base}/me`, { method: 'PUT', headers: jsonAuth(email), body: JSON.stringify(body) })
  return { status: res.status, json: (await res.json()) as any }
}
const get = async (email: string) => {
  const res = await SELF.fetch(`${base}/me`, { headers: auth(email) })
  return { status: res.status, json: (await res.json()) as any }
}

beforeEach(async () => {
  await clearTenancyDb()
})
afterEach(() => vi.restoreAllMocks())

describe('US-A46 — org booking policy', () => {
  it('GET /me exposes the policy defaults', async () => {
    await seedUser({ email: 'admin@empresa.com', role: 'admin' })
    const { status, json } = await get('admin@empresa.com')
    expect(status).toBe(200)
    expect(json.organization).toMatchObject({
      booking_min_down_payment_pct: 0,
      // US-A47 — split policies: sales cutoff (default 0 = sellable until departure) +
      // booking grace (renamed same-day buffer; default 15 = cancel 15 min before departure).
      sales_cutoff_offset_minutes: 0,
      booking_grace_offset_minutes: 15,
      // US-AG07.1 — pre-departure buffer default 24h.
      booking_pre_departure_buffer_hours: 24,
    })
  })

  it('admin updates the policy; the read reflects it', async () => {
    await seedUser({ email: 'admin@empresa.com', role: 'admin' })
    const { status, json } = await put('admin@empresa.com', {
      booking_min_down_payment_pct: 50,
      // A positive cutoff (close sales 5 min before) and a NEGATIVE grace (cancel 10 min AFTER
      // departure — the "After" direction the UI translates to a negative integer).
      sales_cutoff_offset_minutes: 5,
      booking_grace_offset_minutes: -10,
      booking_pre_departure_buffer_hours: 12,
    })
    expect(status).toBe(200)
    expect(json.organization).toMatchObject({
      booking_min_down_payment_pct: 50,
      sales_cutoff_offset_minutes: 5,
      booking_grace_offset_minutes: -10,
      booking_pre_departure_buffer_hours: 12,
    })
    const after = await get('admin@empresa.com')
    expect(after.json.organization.booking_min_down_payment_pct).toBe(50)
  })

  it('rejects out-of-range values → 400', async () => {
    await seedUser({ email: 'admin@empresa.com', role: 'admin' })
    expect((await put('admin@empresa.com', { booking_min_down_payment_pct: 101 })).status).toBe(400)
    // Offsets are signed (±240). Negative is now VALID (a grace window); only out-of-bounds fails.
    expect((await put('admin@empresa.com', { booking_grace_offset_minutes: -30 })).status).toBe(200)
    expect((await put('admin@empresa.com', { sales_cutoff_offset_minutes: 999 })).status).toBe(400)
    expect((await put('admin@empresa.com', { booking_grace_offset_minutes: -999 })).status).toBe(400)
    // Pre-departure buffer: 0–168h valid, out of bounds → 400.
    expect((await put('admin@empresa.com', { booking_pre_departure_buffer_hours: 0 })).status).toBe(200)
    expect((await put('admin@empresa.com', { booking_pre_departure_buffer_hours: 169 })).status).toBe(400)
    expect((await put('admin@empresa.com', { booking_pre_departure_buffer_hours: -1 })).status).toBe(400)
  })

  // US-A77 (S1) — the apartado creation cutoff, and the coherence rule that gives it its point.
  it('the apartado creation cutoff round-trips, defaulting to 0 (no restriction)', async () => {
    await seedUser({ email: 'admin@empresa.com', role: 'admin' })
    expect((await get('admin@empresa.com')).json.organization.booking_creation_cutoff_hours).toBe(0)

    const { status } = await put('admin@empresa.com', { booking_creation_cutoff_hours: 48 })
    expect(status).toBe(200)
    expect((await get('admin@empresa.com')).json.organization.booking_creation_cutoff_hours).toBe(48)
  })

  // BUG-029 — this used to assert `cutoff >= buffer`, which was wrong at BOTH ends: it forbade the
  // only useful configurations ("no apartados inside 2 hours") and, at its own boundary, accepted an
  // apartado born with zero life. The rule now asks `bookingExpiryEpoch` what an apartado created at
  // the tightest legal moment would get, and requires it to be alive.
  it('BUG-029 — a same-day creation cutoff is legal, because stage ② is a legitimate birthplace', async () => {
    await seedUser({ email: 'admin@empresa.com', role: 'admin' })
    // Default deadline 24 h, default grace +15 min. A 2 h cutoff means the tightest apartado is
    // born 2 h out and released at salida−15min: one hour and forty-five minutes of life.
    // `apartado-stages.spec.md` S2 — "sales made close to departure are BORN here".
    expect((await put('admin@empresa.com', { booking_creation_cutoff_hours: 2 })).status).toBe(200)
  })

  it('BUG-029 — cutoff == buffer is REJECTED: that apartado is born already dead', async () => {
    await seedUser({ email: 'admin@empresa.com', role: 'admin' })
    // `nearDeparture` is `distance < buffer`, so at EXACTLY the buffer the far branch applies and
    // the expiry lands on the instant of sale. The old rule accepted this and rejected the case
    // above — precisely backwards.
    expect((await put('admin@empresa.com', { booking_creation_cutoff_hours: 24 })).status).toBe(400)
    // One hour of daylight is enough to be legal.
    expect((await put('admin@empresa.com', { booking_creation_cutoff_hours: 25 })).status).toBe(200)
  })

  it('BUG-029 — a cutoff inside the grace window is rejected', async () => {
    await seedUser({ email: 'admin@empresa.com', role: 'admin' })
    // Grace +120 min: the hold is released two hours before departure. A cutoff of 1 h would let an
    // apartado be created an hour AFTER its own release instant.
    expect(
      (await put('admin@empresa.com', {
        booking_grace_offset_minutes: 120,
        booking_creation_cutoff_hours: 1,
      })).status,
    ).toBe(400)
    expect(
      (await put('admin@empresa.com', {
        booking_grace_offset_minutes: 120,
        booking_creation_cutoff_hours: 3,
      })).status,
    ).toBe(200)
  })

  it('BUG-029 — a NEGATIVE grace is courtesy after departure, so any cutoff is coherent', async () => {
    await seedUser({ email: 'admin@empresa.com', role: 'admin' })
    // −30 = released 30 min AFTER departure. An apartado created at the 1 h boundary lives 1 h 30.
    expect(
      (await put('admin@empresa.com', {
        booking_grace_offset_minutes: -30,
        booking_creation_cutoff_hours: 1,
      })).status,
    ).toBe(200)
  })

  it('the check reads the STORED value of whichever field the request did not send', async () => {
    await seedUser({ email: 'admin@empresa.com', role: 'admin' })
    expect((await put('admin@empresa.com', { booking_creation_cutoff_hours: 2 })).status).toBe(200)
    // Raising the GRACE alone now makes the stored cutoff incoherent. Validating the body alone
    // would have let this through — which is the half of the original rule worth keeping.
    expect(
      (await put('admin@empresa.com', { booking_grace_offset_minutes: 180 })).status,
    ).toBe(400)
  })

  it('0 means no restriction, so there is no boundary to evaluate', async () => {
    await seedUser({ email: 'admin@empresa.com', role: 'admin' })
    // And nothing a settings rule can promise — `confirmSale`'s guard is what covers that case.
    expect((await put('admin@empresa.com', { booking_creation_cutoff_hours: 0 })).status).toBe(200)
  })

  it('0 means no restriction, so it is coherent with any deadline', async () => {
    await seedUser({ email: 'admin@empresa.com', role: 'admin' })
    await put('admin@empresa.com', { booking_pre_departure_buffer_hours: 168 })
    expect((await put('admin@empresa.com', { booking_creation_cutoff_hours: 0 })).status).toBe(200)
  })

  // BUG-028 — `booking_hold_days` configured the retired `created_at + N days` model. It has been
  // inert since the hold moved to time-distance-to-departure, so accepting it (with a min(1) that
  // rejected a 0 and then ignored the 5) was the API promising a policy it does not have.
  it('booking_hold_days is neither returned nor writable', async () => {
    await seedUser({ email: 'admin@empresa.com', role: 'admin' })
    expect((await get('admin@empresa.com')).json.organization).not.toHaveProperty(
      'booking_hold_days',
    )
    // Accepted at the HTTP layer (Zod strips unknown keys) but written nowhere — and a value the
    // old min(1) would have rejected no longer produces a 400 about a policy that does not exist.
    expect((await put('admin@empresa.com', { booking_hold_days: 0 })).status).toBe(200)
    expect((await get('admin@empresa.com')).json.organization).not.toHaveProperty(
      'booking_hold_days',
    )
  })

  it('an agent may not edit the policy → 403', async () => {
    const { organizationId } = await seedUser({ email: 'admin@empresa.com', role: 'admin' })
    await seedUser({ email: 'agent@empresa.com', role: 'agent', organizationId })
    expect((await put('agent@empresa.com', { booking_min_down_payment_pct: 5 })).status).toBe(403)
  })

  it('isolation — an admin only edits their own org', async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    await put(orgA.adminEmail, { booking_min_down_payment_pct: 40 })

    const a = await get(orgA.adminEmail)
    const b = await get(orgB.adminEmail)
    expect(a.json.organization.booking_min_down_payment_pct).toBe(40)
    expect(b.json.organization.booking_min_down_payment_pct).toBe(0) // untouched default
  })
})

describe('US-A66 — organization time zone', () => {
  it('the production default is America/Mexico_City', async () => {
    // Insert an org relying on the column DEFAULT (seedUser seeds UTC, so create the org directly),
    // then attach an admin who reuses it.
    const orgId = crypto.randomUUID()
    await env.DB.prepare('INSERT INTO organizations (id, name) VALUES (?, ?)')
      .bind(orgId, 'Empresa Default')
      .run()
    await seedUser({ email: 'admin@default.com', role: 'admin', organizationId: orgId })

    const { status, json } = await get('admin@default.com')
    expect(status).toBe(200)
    expect(json.organization.timezone).toBe('America/Mexico_City')
  })

  it('admin sets a valid zone; the read reflects it', async () => {
    await seedUser({ email: 'admin@empresa.com', role: 'admin' })
    const { status, json } = await put('admin@empresa.com', { timezone: 'America/Cancun' })
    expect(status).toBe(200)
    expect(json.organization.timezone).toBe('America/Cancun')
    expect((await get('admin@empresa.com')).json.organization.timezone).toBe('America/Cancun')
  })

  it('rejects a zone outside the curated allow-list → 400', async () => {
    await seedUser({ email: 'admin@empresa.com', role: 'admin' })
    // A real IANA zone, but not one we offer — the Zod enum must reject it.
    expect((await put('admin@empresa.com', { timezone: 'Europe/Paris' })).status).toBe(400)
    expect((await put('admin@empresa.com', { timezone: 'UTC' })).status).toBe(400)
  })

  it('isolation — one admin\'s zone change never touches another org', async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    await put(orgA.adminEmail, { timezone: 'America/Tijuana' })
    expect((await get(orgA.adminEmail)).json.organization.timezone).toBe('America/Tijuana')
    // orgB was seeded via seedUser (UTC) and must be untouched by orgA's edit.
    expect((await get(orgB.adminEmail)).json.organization.timezone).toBe('UTC')
  })
})

// ---------------------------------------------------------------------------
// US-A69/A70/A72/A73 — the cancellation policy ladder.
// Spec: docs/cancellation/cancellation-policy-engine.spec.md
//
// The endpoint is the only writer of the ladder, so it is also the only place a malformed
// document can be rejected. Everything downstream (the engine, the snapshot, the sweep) assumes a
// stored policy is evaluable — these tests are what makes that assumption safe.
// ---------------------------------------------------------------------------
describe('US-A69 — cancellation policy ladder', () => {
  const LADDER = {
    version: 1,
    tiers: [
      { min_hours: 120, refund_pct: 100, agent_commission_pct: 0 },
      { min_hours: 0, refund_pct: 50, agent_commission_pct: 100, affiliate_commission_pct: 50 },
      { min_hours: null, refund_pct: 0, agent_commission_pct: 100 },
    ],
  }

  it('defaults to NO policy — which is what keeps every org on the pre-feature path (D1)', async () => {
    await seedUser({ email: 'admin@empresa.com', role: 'admin' })
    const { json } = await get('admin@empresa.com')
    expect(json.organization.cancellation_policy).toBeNull()
    expect(json.organization.agent_cancellation_enabled).toBe(false)
  })

  it('stores a ladder and reads it back as an object', async () => {
    await seedUser({ email: 'admin@empresa.com', role: 'admin' })
    const { status, json } = await put('admin@empresa.com', { cancellation_policy: LADDER })
    expect(status).toBe(200)
    expect(json.organization.cancellation_policy).toMatchObject({ version: 1 })
    expect(json.organization.cancellation_policy.tiers).toHaveLength(3)
    // Round-trips through the column, not just the response.
    const reread = (await get('admin@empresa.com')).json.organization.cancellation_policy
    expect(reread.tiers[1]).toMatchObject({ refund_pct: 50, affiliate_commission_pct: 50 })
  })

  // D20 — an admin (or an older client build) may still send the retired deposit floor. The endpoint
  // must accept the document and drop the key rather than 400, so a stale tab cannot lock someone
  // out of editing their own ladder.
  it('accepts a legacy ladder carrying the retired deposit floor, and stores it without', async () => {
    await seedUser({ email: 'admin@empresa.com', role: 'admin' })
    const legacy = { ...LADDER, booking_deposit_retained_pct: 100 }
    const { status, json } = await put('admin@empresa.com', { cancellation_policy: legacy })
    expect(status).toBe(200)
    expect(json.organization.cancellation_policy).not.toHaveProperty(
      'booking_deposit_retained_pct',
    )
    const reread = (await get('admin@empresa.com')).json.organization.cancellation_policy
    expect(reread).not.toHaveProperty('booking_deposit_retained_pct')
    expect(reread.tiers).toHaveLength(3)
  })

  it('null CLEARS the policy — the rollback (D1)', async () => {
    await seedUser({ email: 'admin@empresa.com', role: 'admin' })
    await put('admin@empresa.com', { cancellation_policy: LADDER })
    const { status, json } = await put('admin@empresa.com', { cancellation_policy: null })
    expect(status).toBe(200)
    expect(json.organization.cancellation_policy).toBeNull()
  })

  it('leaves the ladder alone when the field is absent from a partial update', async () => {
    await seedUser({ email: 'admin@empresa.com', role: 'admin' })
    await put('admin@empresa.com', { cancellation_policy: LADDER })
    await put('admin@empresa.com', { booking_min_down_payment_pct: 30 })
    expect((await get('admin@empresa.com')).json.organization.cancellation_policy).not.toBeNull()
  })

  it('rejects a malformed ladder → 400, and stores nothing', async () => {
    await seedUser({ email: 'admin@empresa.com', role: 'admin' })
    const bad = [
      // no terminal tier — a departure that has passed would match nothing
      { ...LADDER, tiers: [{ min_hours: 120, refund_pct: 100, agent_commission_pct: 0 }] },
      // two terminal tiers — ambiguous
      {
        ...LADDER,
        tiers: [
          { min_hours: null, refund_pct: 100, agent_commission_pct: 0 },
          { min_hours: null, refund_pct: 0, agent_commission_pct: 100 },
        ],
      },
      // ascending thresholds — the second tier is unreachable
      {
        ...LADDER,
        tiers: [
          { min_hours: 24, refund_pct: 50, agent_commission_pct: 0 },
          { min_hours: 120, refund_pct: 100, agent_commission_pct: 0 },
          { min_hours: null, refund_pct: 0, agent_commission_pct: 100 },
        ],
      },
      // out-of-range percentages
      { ...LADDER, tiers: [{ min_hours: null, refund_pct: 101, agent_commission_pct: 0 }] },
      // wrong version
      { ...LADDER, version: 2 },
    ]
    for (const policy of bad) {
      expect((await put('admin@empresa.com', { cancellation_policy: policy })).status).toBe(400)
    }
    expect((await get('admin@empresa.com')).json.organization.cancellation_policy).toBeNull()
  })

  // BUG-028 — US-A73 is specified, NOT built: no endpoint reads the flag and every cancel route is
  // still admin-only. The switch used to round-trip through PATCH, which told an admin they had
  // enabled something. It is now refused (Zod strips it), and the read field stays for US-AG44.
  it('US-A73 — the agent-cancellation switch is NOT writable while the endpoint does not exist', async () => {
    await seedUser({ email: 'admin@empresa.com', role: 'admin' })
    expect((await put('admin@empresa.com', { agent_cancellation_enabled: true })).status).toBe(200)
    expect((await get('admin@empresa.com')).json.organization.agent_cancellation_enabled).toBe(false)
  })

  it('isolation — one org\'s ladder is invisible to another', async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    await put(orgA.adminEmail, { cancellation_policy: LADDER })
    expect((await get(orgA.adminEmail)).json.organization.cancellation_policy).not.toBeNull()
    expect((await get(orgB.adminEmail)).json.organization.cancellation_policy).toBeNull()
  })
})
