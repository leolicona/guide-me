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
      booking_hold_days: 7,
      // US-A47 — split policies: sales cutoff (default 0 = sellable until departure) +
      // booking grace (renamed same-day buffer; default 15 = cancel 15 min before departure).
      sales_cutoff_offset_minutes: 0,
      booking_grace_offset_minutes: 15,
    })
  })

  it('admin updates the policy; the read reflects it', async () => {
    await seedUser({ email: 'admin@empresa.com', role: 'admin' })
    const { status, json } = await put('admin@empresa.com', {
      booking_min_down_payment_pct: 50,
      booking_hold_days: 3,
      // A positive cutoff (close sales 5 min before) and a NEGATIVE grace (cancel 10 min AFTER
      // departure — the "After" direction the UI translates to a negative integer).
      sales_cutoff_offset_minutes: 5,
      booking_grace_offset_minutes: -10,
    })
    expect(status).toBe(200)
    expect(json.organization).toMatchObject({
      booking_min_down_payment_pct: 50,
      booking_hold_days: 3,
      sales_cutoff_offset_minutes: 5,
      booking_grace_offset_minutes: -10,
    })
    const after = await get('admin@empresa.com')
    expect(after.json.organization.booking_min_down_payment_pct).toBe(50)
  })

  it('rejects out-of-range values → 400', async () => {
    await seedUser({ email: 'admin@empresa.com', role: 'admin' })
    expect((await put('admin@empresa.com', { booking_min_down_payment_pct: 101 })).status).toBe(400)
    expect((await put('admin@empresa.com', { booking_hold_days: 0 })).status).toBe(400)
    // Offsets are signed (±240). Negative is now VALID (a grace window); only out-of-bounds fails.
    expect((await put('admin@empresa.com', { booking_grace_offset_minutes: -30 })).status).toBe(200)
    expect((await put('admin@empresa.com', { sales_cutoff_offset_minutes: 999 })).status).toBe(400)
    expect((await put('admin@empresa.com', { booking_grace_offset_minutes: -999 })).status).toBe(400)
  })

  it('an agent may not edit the policy → 403', async () => {
    const { organizationId } = await seedUser({ email: 'admin@empresa.com', role: 'admin' })
    await seedUser({ email: 'agent@empresa.com', role: 'agent', organizationId })
    expect((await put('agent@empresa.com', { booking_hold_days: 5 })).status).toBe(403)
  })

  it('isolation — an admin only edits their own org', async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    await put(orgA.adminEmail, { booking_hold_days: 2 })

    const a = await get(orgA.adminEmail)
    const b = await get(orgB.adminEmail)
    expect(a.json.organization.booking_hold_days).toBe(2)
    expect(b.json.organization.booking_hold_days).toBe(7) // untouched default
  })
})
