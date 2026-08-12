import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { seedUser, seedTwoOrgs, clearTenancyDb , materializeSeededFolio} from '../helpers/tenancy'
import { buildFakeJwt } from '../helpers/jwt'

// Total Folio Cancellation — US-A21 / US-A26.
// Spec: docs/cancellation/total-folio-cancellation.spec.md (Scenarios 1–11, incl. 6b).
//
// Cancelling a folio releases every line's spots and records who/when/why (+ the US-A26
// clawback flag), atomically. The scanner's CANCELLED gate and the agent cash-balance
// `cancelled` exclusion are reused (no new code) — asserted here as integration guarantees.
// The clawback's effect on the commission is owned by the cash suite (Scenario 20);
// Scenario 6b here asserts only that this handler persists the flag. Multitenancy (10–11)
// uses the shared `seedTwoOrgs` helper.

const ADMIN_EMAIL = 'admin@empresa.com'
const AGENT_EMAIL = 'agent@empresa.com'
const DATE = '2026-06-04'

const auth = (email: string) => ({ Cookie: `gm_access=${buildFakeJwt(email)}` })
const jsonAuth = (email: string) => ({ ...auth(email), 'Content-Type': 'application/json' })

// --- Local seeders (raw D1) ------------------------------------------------

const folioCreatedAt = (date: string) => Math.floor(Date.parse(`${date}T12:00:00Z`) / 1000)

const seedService = async (organizationId: string): Promise<string> => {
  const id = crypto.randomUUID()
  const ts = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO services
       (id, organization_id, name, description, base_price, minimum_price, default_capacity, status, created_at, updated_at)
     VALUES (?, ?, 'Canyon Tour', NULL, 150000, 100000, 12, 'active', ?, ?)`,
  )
    .bind(id, organizationId, ts, ts)
    .run()
  return id
}

const seedSlot = async (
  organizationId: string,
  serviceId: string,
  opts: { booked?: number; capacity?: number; date?: string } = {},
): Promise<string> => {
  const { booked = 0, capacity = 12, date = '2026-06-15' } = opts
  const id = crypto.randomUUID()
  const ts = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO slots
       (id, organization_id, service_id, schedule_id, date, start_time, capacity, booked, status, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, '06:00', ?, ?, 'active', ?, ?)`,
  )
    .bind(id, organizationId, serviceId, date, capacity, booked, ts, ts)
    .run()
  return id
}

interface SeedFolioOptions {
  organizationId: string
  agentId: string
  status?: 'paid' | 'booking' | 'cancelled'
  total?: number
  amountPaid?: number
  date?: string
}

const seedFolio = async ({
  organizationId,
  agentId,
  status = 'paid',
  total = 150000,
  amountPaid,
  date = DATE,
}: SeedFolioOptions): Promise<string> => {
  const id = crypto.randomUUID()
  const ts = folioCreatedAt(date)
  await env.DB.prepare(
    `INSERT INTO folios
       (id, organization_id, agent_id, customer_name, customer_email, customer_phone,
        status, subtotal, discount_total, total, amount_paid, created_at, updated_at)
     VALUES (?, ?, ?, 'John Diver', NULL, NULL, ?, ?, 0, ?, ?, ?, ?)`,
  )
    .bind(id, organizationId, agentId, status, total, total, amountPaid ?? total, ts, ts)
    .run()
  return id
}

const seedFolioLine = async (opts: {
  organizationId: string
  folioId: string
  serviceId: string
  slotId: string
  quantity: number
}): Promise<string> => {
  const id = crypto.randomUUID()
  const ts = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO folio_lines
       (id, organization_id, folio_id, service_id, slot_id, service_name, slot_date,
        slot_start_time, quantity, base_price, minimum_price, unit_price, line_total,
        qr_token, redeemed_count, created_at)
     VALUES (?, ?, ?, ?, ?, 'Canyon Tour', '2026-06-15', '06:00', ?, 150000, 100000, 150000, ?, NULL, 0, ?)`,
  )
    .bind(id, opts.organizationId, opts.folioId, opts.serviceId, opts.slotId, opts.quantity, 150000 * opts.quantity, ts)
    .run()
  // TECH_DEBT #25 — the product reads the LINE's coverage, so each seeded line gets the ledger
  // facts the shim columns only declared. Per-line and idempotent: safe after every insert.
  await materializeSeededFolio(opts.folioId)
  return id
}

const getSlotBooked = async (slotId: string) => {
  const r = await env.DB.prepare(`SELECT booked FROM slots WHERE id = ?`)
    .bind(slotId)
    .first<{ booked: number }>()
  return r?.booked ?? null
}

const getFolioRow = (id: string) =>
  env.DB.prepare(
    `SELECT f.*,
      (SELECT CASE
        WHEN COALESCE(SUM(CASE WHEN fl.cancelled_at IS NULL THEN 1 ELSE 0 END),0) = 0 THEN 'cancelled'
        WHEN COALESCE(SUM(CASE WHEN fl.cancelled_at IS NULL
            AND COALESCE((SELECT SUM(a2.amount) FROM folio_payment_allocations a2 WHERE a2.folio_line_id = fl.id),0) < fl.line_total
            THEN 1 ELSE 0 END),0) > 0 THEN 'booking'
        ELSE 'paid' END
       FROM folio_lines fl WHERE fl.folio_id = f.id) AS status,
      (SELECT COALESCE(
        (SELECT MIN(fl.booking_expires_at) FROM folio_lines fl
          WHERE fl.folio_id = f.id AND fl.cancelled_at IS NULL AND fl.booking_expires_at IS NOT NULL),
        (SELECT MIN(fl.booking_expires_at) FROM folio_lines fl
          WHERE fl.folio_id = f.id AND fl.booking_expires_at IS NOT NULL))) AS booking_expires_at,
      (SELECT CASE
        WHEN EXISTS (SELECT 1 FROM folio_lines fl WHERE fl.folio_id = f.id AND fl.refund_status = 'pending') THEN 'pending'
        WHEN EXISTS (SELECT 1 FROM folio_lines fl WHERE fl.folio_id = f.id AND fl.refund_status = 'refunded') THEN 'refunded'
        ELSE 'none' END) AS refund_status,
      (SELECT SUM(fl.refund_amount) FROM folio_lines fl WHERE fl.folio_id = f.id AND fl.refund_status <> 'none') AS refund_amount
     FROM folios f WHERE f.id = ?`,
  )
    .bind(id)
    .first<{
      status: string
      organization_id: string
      cancelled_at: number | null
      cancelled_by: string | null
      cancellation_reason: string | null
      cancellation_clawback: number
    }>()

const clearFoliosDb = async () => {
  await env.DB.exec('DELETE FROM folio_access_tokens')
  await env.DB.exec('DELETE FROM folio_line_extras')
  await env.DB.exec('DELETE FROM folio_requests')
  await env.DB.exec('DELETE FROM folio_lines')
  await env.DB.exec('DELETE FROM folio_access_tokens')
  await env.DB.exec('DELETE FROM folio_payments')
  await env.DB.exec('DELETE FROM notifications')
  await env.DB.exec('DELETE FROM folio_events')
  await env.DB.exec('DELETE FROM folios')
  // FK-safe: slot_zones and folio_lines both reference service_zones, which references services.
  await env.DB.exec('DELETE FROM slot_zones')
  await env.DB.exec('DELETE FROM service_zones')
  await env.DB.exec('DELETE FROM slots')
  await env.DB.exec('DELETE FROM schedules')
  await env.DB.exec('DELETE FROM service_extras')
  await env.DB.exec('DELETE FROM services')
}

beforeEach(async () => {
  await clearFoliosDb()
  await clearTenancyDb()
})
afterEach(() => vi.restoreAllMocks())

const FOLIOS = 'http://api.local/api/folios'
const POS = 'http://api.local/api/pos'
const TICKETS = 'http://api.local/api/tickets'

// --- API helpers -----------------------------------------------------------

const listFolios = async (email: string, query = '') => {
  const res = await SELF.fetch(`${FOLIOS}${query ? `?${query}` : ''}`, { headers: auth(email) })
  return { status: res.status, json: (await res.json()) as any }
}
const getFolio = async (email: string, id: string) => {
  const res = await SELF.fetch(`${FOLIOS}/${id}`, { headers: auth(email) })
  return { status: res.status, json: (await res.json()) as any }
}
const cancelFolio = async (email: string, id: string, body: Record<string, unknown> = {}) => {
  const res = await SELF.fetch(`${FOLIOS}/${id}/cancel`, {
    method: 'POST',
    headers: jsonAuth(email),
    body: JSON.stringify(body),
  })
  return { status: res.status, json: (await res.json()) as any }
}

// Seed an org with both an admin (the canceller) and an agent (the folio owner).
const seedOrgWithStaff = async () => {
  const { organizationId, userId: adminId } = await seedUser({ email: ADMIN_EMAIL, role: 'admin' })
  const { userId: agentId } = await seedUser({ email: AGENT_EMAIL, role: 'agent', organizationId })
  return { organizationId, adminId, agentId }
}

// ---------------------------------------------------------------------------
// US-A21 — cancel, release spots, record it
// ---------------------------------------------------------------------------
describe('Total Folio Cancellation', () => {
  it('Scenario 1 — cancelling releases every line\'s spots', async () => {
    const { organizationId, adminId, agentId } = await seedOrgWithStaff()
    const serviceId = await seedService(organizationId)
    const s1 = await seedSlot(organizationId, serviceId, { booked: 3, date: '2026-06-15' })
    const s2 = await seedSlot(organizationId, serviceId, { booked: 2, date: '2026-06-16' })
    const folioId = await seedFolio({ organizationId, agentId })
    await seedFolioLine({ organizationId, folioId, serviceId, slotId: s1, quantity: 3 })
    await seedFolioLine({ organizationId, folioId, serviceId, slotId: s2, quantity: 2 })

    const { status, json } = await cancelFolio(ADMIN_EMAIL, folioId)
    expect(status).toBe(200)
    expect(json.folio.status).toBe('cancelled')
    expect(await getSlotBooked(s1)).toBe(0)
    expect(await getSlotBooked(s2)).toBe(0)
    expect(adminId).toBeTruthy()
  })

  it('Scenario 2 — cancellation is recorded (with and without a reason)', async () => {
    const { organizationId, adminId, agentId } = await seedOrgWithStaff()
    const serviceId = await seedService(organizationId)
    const slotId = await seedSlot(organizationId, serviceId, { booked: 1 })
    const folioId = await seedFolio({ organizationId, agentId })
    await seedFolioLine({ organizationId, folioId, serviceId, slotId, quantity: 1 })

    const { status, json } = await cancelFolio(ADMIN_EMAIL, folioId, { reason: 'Customer no-show' })
    expect(status).toBe(200)
    expect(json.folio.cancellation_reason).toBe('Customer no-show')
    expect(json.folio.cancelled_by).toBe(adminId)
    expect(typeof json.folio.cancelled_at).toBe('number')

    const row = await getFolioRow(folioId)
    expect(row?.cancelled_by).toBe(adminId)
    expect(row?.cancellation_reason).toBe('Customer no-show')

    // No-reason path on a second, independent folio → reason null.
    const folio2 = await seedFolio({ organizationId, agentId })
    await seedFolioLine({ organizationId, folioId: folio2, serviceId, slotId, quantity: 1 })
    const r2 = await cancelFolio(ADMIN_EMAIL, folio2)
    expect(r2.status).toBe(200)
    expect(r2.json.folio.cancellation_reason).toBeNull()
  })

  it('Scenario 3 — a booking folio can be cancelled', async () => {
    const { organizationId, agentId } = await seedOrgWithStaff()
    const serviceId = await seedService(organizationId)
    const slotId = await seedSlot(organizationId, serviceId, { booked: 2 })
    const folioId = await seedFolio({ organizationId, agentId, status: 'booking', amountPaid: 50000 })
    await seedFolioLine({ organizationId, folioId, serviceId, slotId, quantity: 2 })

    const { status, json } = await cancelFolio(ADMIN_EMAIL, folioId)
    expect(status).toBe(200)
    expect(json.folio.status).toBe('cancelled')
    expect(await getSlotBooked(slotId)).toBe(0)
  })

  // US-AG07.3 / D5 — the admin list + detail must carry the apartado-recovery fields so the
  // org-wide /folios surface can decorate booking rows (urgency, pending balance, WhatsApp).
  it('exposes apartado fields on the admin list + detail', async () => {
    const { organizationId, agentId } = await seedOrgWithStaff()
    const serviceId = await seedService(organizationId)
    const slotId = await seedSlot(organizationId, serviceId, { booked: 2 })
    const folioId = await seedFolio({
      organizationId,
      agentId,
      status: 'booking',
      total: 150000,
      amountPaid: 50000,
    })
    await seedFolioLine({ organizationId, folioId, serviceId, slotId, quantity: 2 })

    const expiresAt = Math.floor(Date.now() / 1000) + 3600
    await env.DB.prepare(
      `UPDATE folios
         SET customer_phone = '5551234567',
             reminder_status = 'sent', reminder_sent_at = ?, reminder_sent_by = ?
       WHERE id = ?`,
    )
      .bind(expiresAt, agentId, folioId)
      .run()
    // TECH_DEBT #25 — the hold's clock belongs to the LINE; the folio's is derived from it.
    await env.DB.prepare(`UPDATE folio_lines SET booking_expires_at = ? WHERE folio_id = ?`)
      .bind(expiresAt, folioId)
      .run()

    const list = await listFolios(ADMIN_EMAIL, 'status=booking')
    expect(list.status).toBe(200)
    const row = list.json.folios.find((r: any) => r.id === folioId)
    expect(row.pending_balance).toBe(100000)
    expect(row.booking_expires_at).toBe(expiresAt)
    expect(row.customer_phone).toBe('5551234567')
    expect(row.reminder_status).toBe('sent')
    expect(row.reminder_sent_by).toBe(agentId)

    const detail = await getFolio(ADMIN_EMAIL, folioId)
    expect(detail.status).toBe(200)
    expect(detail.json.folio.pending_balance).toBe(100000)
    expect(detail.json.folio.booking_expires_at).toBe(expiresAt)
    expect(detail.json.folio.reminder_status).toBe('sent')
  })

  it('Scenario 4 — double cancellation → 409; spots and audit unchanged', async () => {
    const { organizationId, agentId } = await seedOrgWithStaff()
    const serviceId = await seedService(organizationId)
    const slotId = await seedSlot(organizationId, serviceId, { booked: 3 })
    const folioId = await seedFolio({ organizationId, agentId })
    await seedFolioLine({ organizationId, folioId, serviceId, slotId, quantity: 3 })

    const first = await cancelFolio(ADMIN_EMAIL, folioId, { reason: 'first' })
    expect(first.status).toBe(200)
    expect(await getSlotBooked(slotId)).toBe(0)
    const after1 = await getFolioRow(folioId)

    const second = await cancelFolio(ADMIN_EMAIL, folioId, { reason: 'second' })
    expect(second.status).toBe(409)
    expect(second.json.error?.code ?? second.json.code).toBe('CONFLICT')

    // booked not released twice; original audit preserved.
    expect(await getSlotBooked(slotId)).toBe(0)
    const after2 = await getFolioRow(folioId)
    expect(after2?.cancellation_reason).toBe('first')
    expect(after2?.cancelled_at).toBe(after1?.cancelled_at)
  })

  it('Scenario 5 — multi-slot cancellation applies as one atomic unit', async () => {
    const { organizationId, agentId } = await seedOrgWithStaff()
    const serviceId = await seedService(organizationId)
    const s1 = await seedSlot(organizationId, serviceId, { booked: 1, date: '2026-06-15' })
    const s2 = await seedSlot(organizationId, serviceId, { booked: 4, date: '2026-06-16' })
    const s3 = await seedSlot(organizationId, serviceId, { booked: 2, date: '2026-06-17' })
    const folioId = await seedFolio({ organizationId, agentId })
    await seedFolioLine({ organizationId, folioId, serviceId, slotId: s1, quantity: 1 })
    await seedFolioLine({ organizationId, folioId, serviceId, slotId: s2, quantity: 4 })
    await seedFolioLine({ organizationId, folioId, serviceId, slotId: s3, quantity: 2 })

    const { status } = await cancelFolio(ADMIN_EMAIL, folioId)
    expect(status).toBe(200)
    // All three slots released together; folio flipped.
    expect(await getSlotBooked(s1)).toBe(0)
    expect(await getSlotBooked(s2)).toBe(0)
    expect(await getSlotBooked(s3)).toBe(0)
    expect((await getFolioRow(folioId))?.status).toBe('cancelled')
  })

  it('Scenario 6 — cancelled folio is excluded from collected-cash derivation', async () => {
    const { organizationId, agentId } = await seedOrgWithStaff()
    const folioId = await seedFolio({ organizationId, agentId, total: 300000, amountPaid: 300000 })
    await materializeSeededFolio(folioId)

    // The cash derivation (shared by the agent balance / cash-drops feature) sums
    // amount_paid over NON-cancelled folios. Assert at that predicate level so the test
    // is decoupled from any specific cash endpoint. TECH_DEBT #25 — that predicate is
    // `cancelled_at IS NULL` now; the `status` column it used to read is gone.
    const collected = async () =>
      Number(
        (
          await env.DB.prepare(
            `SELECT coalesce(sum(amount_paid), 0) AS c FROM folios
               WHERE organization_id = ? AND agent_id = ? AND cancelled_at IS NULL`,
          )
            .bind(organizationId, agentId)
            .first<{ c: number }>()
        )?.c ?? 0,
      )

    expect(await collected()).toBe(300000)

    const { status } = await cancelFolio(ADMIN_EMAIL, folioId)
    expect(status).toBe(200)

    expect(await collected()).toBe(0)
  })

  // US-A26 SUPERSEDED (Cancellation Policy Engine, D10). This used to assert that the admin's
  // `clawback` body flag was persisted as they chose it. The flag is withdrawn: the clawback is
  // derived from the org's ladder, so the only thing left to assert here is that sending it fails
  // loudly rather than being silently dropped. The derived value is covered in
  // test/cancellation/cancellation-policy-handlers.test.ts ("the clawback flag is derived").
  it('Scenario 6b — the withdrawn clawback flag is rejected, not ignored (US-A26 superseded)', async () => {
    const { organizationId, agentId } = await seedOrgWithStaff()
    const serviceId = await seedService(organizationId)
    // The departure must be ≥120h AWAY for the derivation to have teeth: that is the tier where the
    // ladder retains nothing, so the D8 cap forces the seller to keep nothing and the clawback is
    // true. Computed from now rather than hardcoded — the file's default slot date (2026-06-15) is
    // already in the past, which silently turns any folio using it into a no-show.
    const farOut = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10)
    const slotId = await seedSlot(organizationId, serviceId, { booked: 2, date: farOut })

    const folioId = await seedFolio({ organizationId, agentId })
    await seedFolioLine({ organizationId, folioId, serviceId, slotId, quantity: 1 })

    expect((await cancelFolio(ADMIN_EMAIL, folioId, { clawback: true })).status).toBe(400)
    expect((await cancelFolio(ADMIN_EMAIL, folioId, { clawback: false })).status).toBe(400)
    // Rejected means untouched — not "cancelled with the flag dropped".
    expect((await getFolioRow(folioId))?.status).toBe('paid')

    // Give the sale a commission so the derivation has something to decide about — the shared seeder
    // books none, and "nothing was clawed back" is not evidence the rule works. BOTH the line and
    // the folio: `folios.commission_amount` is the authoritative figure the engine reconciles to
    // (it is what the cash engine and the commission report read), so a line-only fixture describes
    // a sale that booked no commission at all.
    //
    // The departure moves on the LINE, not the slot: the engine reads each line's snapshotted
    // `slot_date`/`slot_start_time` (a folio must price by the departure it was sold for, even if
    // the slot is later rescheduled), and this file's seeder hardcodes 2026-06-15 there.
    await env.DB.prepare(
      `UPDATE folio_lines SET commission_type = 'percent', commission_value = 1000, slot_date = ?
        WHERE folio_id = ?`,
    )
      .bind(farOut, folioId)
      .run()
    await env.DB.prepare(`UPDATE folios SET commission_amount = 15000 WHERE id = ?`)
      .bind(folioId)
      .run()

    // Without the flag the cancellation succeeds and the clawback is derived: 10+ days out the
    // ladder refunds in full, so nothing is retained, so by the D8 cap the seller keeps nothing.
    const ok = await cancelFolio(ADMIN_EMAIL, folioId, { reason: 'goodwill' })
    expect(ok.status).toBe(200)
    // The derived flag is bookkeeping (commission report / cash engine), not API surface — it
    // stopped being serialized when the manual control was retired, so it is asserted on the row.
    expect((await getFolioRow(folioId))?.cancellation_clawback).toBe(1)
  })

  it('Scenario 7 — a cancelled folio\'s QR ticket is rejected by the scanner', async () => {
    const { organizationId } = await seedOrgWithStaff()
    const serviceId = await seedService(organizationId)
    const slotId = await seedSlot(organizationId, serviceId)
    // Mint a real ticket via POS confirm (agent).
    const confirm = await SELF.fetch(`${POS}/folios`, {
      method: 'POST',
      headers: jsonAuth(AGENT_EMAIL),
      body: JSON.stringify({ customer_name: 'Cliente Test', customer_phone: '5512345678', customer_email: 'cliente@example.com', lines: [{ slot_id: slotId, quantity: 2, unit_price: 150000 }] }),
    })
    const body = (await confirm.json()) as any
    const folioId = body.folio.id as string
    const token = body.folio.lines[0].qr_token as string
    const lineId = body.folio.lines[0].id as string

    await cancelFolio(ADMIN_EMAIL, folioId)

    const scan = await SELF.fetch(`${TICKETS}/scan`, {
      method: 'POST',
      headers: jsonAuth(AGENT_EMAIL),
      body: JSON.stringify({ token }),
    })
    const scanJson = (await scan.json()) as any
    expect(scan.status).toBe(200)
    expect(scanJson.result).toBe('invalid')
    expect(scanJson.reason).toBe('CANCELLED')

    const r = await env.DB.prepare(`SELECT redeemed_count FROM folio_lines WHERE id = ?`)
      .bind(lineId)
      .first<{ redeemed_count: number }>()
    expect(r?.redeemed_count).toBe(0)
  })

  it('Scenario 8 — admin lists and reads folios', async () => {
    const { organizationId, agentId } = await seedOrgWithStaff()
    const serviceId = await seedService(organizationId)
    const slotId = await seedSlot(organizationId, serviceId, { booked: 2 })
    const paidId = await seedFolio({ organizationId, agentId, total: 200000, date: DATE })
    await seedFolioLine({ organizationId, folioId: paidId, serviceId, slotId, quantity: 2 })
    const cancelledId = await seedFolio({ organizationId, agentId, status: 'cancelled', date: '2026-06-03' })
    await materializeSeededFolio(cancelledId)

    const { status, json } = await listFolios(ADMIN_EMAIL)
    expect(status).toBe(200)
    expect(json.folios).toHaveLength(2)
    // newest-first (DATE 06-04 before 06-03)
    expect(json.folios[0].id).toBe(paidId)
    expect(json.folios[0].agent.name).toBe('Test User')
    expect(json.folios[0].status).toBe('paid')

    const detail = await getFolio(ADMIN_EMAIL, paidId)
    expect(detail.status).toBe(200)
    expect(detail.json.folio.lines).toHaveLength(1)
    expect(detail.json.folio.lines[0].quantity).toBe(2)
    expect(detail.json.folio.customer_name).toBe('John Diver')

    // status filter
    const onlyCancelled = await listFolios(ADMIN_EMAIL, 'status=cancelled')
    expect(onlyCancelled.json.folios).toHaveLength(1)
    expect(onlyCancelled.json.folios[0].id).toBe(cancelledId)
  })

  it('Scenario 9 — non-admin → 403 on every folio route', async () => {
    const { organizationId, agentId } = await seedOrgWithStaff()
    const folioId = await seedFolio({ organizationId, agentId })
    await materializeSeededFolio(folioId)

    const list = await listFolios(AGENT_EMAIL)
    const detail = await getFolio(AGENT_EMAIL, folioId)
    const cancel = await cancelFolio(AGENT_EMAIL, folioId)
    expect(list.status).toBe(403)
    expect(detail.status).toBe(403)
    expect(cancel.status).toBe(403)
    // unchanged
    expect((await getFolioRow(folioId))?.status).toBe('paid')
  })

  // -------------------------------------------------------------------------
  // Multitenancy isolation (required — seedTwoOrgs)
  // -------------------------------------------------------------------------
  it('Scenario 10 — B3: a cross-org folio is unreachable (404), untouched', async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    const serviceB = await seedService(orgB.organizationId)
    const slotB = await seedSlot(orgB.organizationId, serviceB, { booked: 2 })
    const folioB = await seedFolio({
      organizationId: orgB.organizationId,
      agentId: orgB.adminUserId,
    })
    await seedFolioLine({
      organizationId: orgB.organizationId,
      folioId: folioB,
      serviceId: serviceB,
      slotId: slotB,
      quantity: 2,
    })

    const detail = await getFolio(orgA.adminEmail, folioB)
    const cancel = await cancelFolio(orgA.adminEmail, folioB)
    expect(detail.status).toBe(404)
    expect(cancel.status).toBe(404)

    // org_b folio untouched.
    expect((await getFolioRow(folioB))?.status).toBe('paid')
    expect(await getSlotBooked(slotB)).toBe(2)
  })

  it('Scenario 11 — B4/B1: list org-scoped; injected org/actor ignored', async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    const serviceA = await seedService(orgA.organizationId)
    const slotA = await seedSlot(orgA.organizationId, serviceA, { booked: 1 })
    const folioA = await seedFolio({
      organizationId: orgA.organizationId,
      agentId: orgA.adminUserId,
    })
    await seedFolioLine({
      organizationId: orgA.organizationId,
      folioId: folioA,
      serviceId: serviceA,
      slotId: slotA,
      quantity: 1,
    })
    await materializeSeededFolio(
      await seedFolio({ organizationId: orgB.organizationId, agentId: orgB.adminUserId }),
    )

    // B4 — list returns only org_a.
    const list = await listFolios(orgA.adminEmail)
    expect(list.json.folios).toHaveLength(1)
    expect(list.json.folios[0].id).toBe(folioA)

    // B1 — injected organizationId / cancelled_by are ignored.
    const { status } = await cancelFolio(orgA.adminEmail, folioA, {
      reason: 'ok',
      organizationId: orgB.organizationId,
      cancelled_by: orgB.adminUserId,
    })
    expect(status).toBe(200)
    const row = await getFolioRow(folioA)
    expect(row?.organization_id).toBe(orgA.organizationId)
    expect(row?.cancelled_by).toBe(orgA.adminUserId)
  })
})

// ---------------------------------------------------------------------------
// BUG — zoned seats were never released by the MANUAL cancellation path.
//
// For a zoned service (US-A64) `slot_zones.booked` is authoritative and `slots.booked` is
// DERIVED from it by `reconcileSlotTotals`. `applyCancellation` decremented `slots.booked`
// directly and never touched the zone row, so:
//   - the zone counter stayed inflated → those seats were unsellable FOREVER, and
//   - the slot total looked correct only until the next reconcile overwrote it from the
//     (still inflated) zone sums.
// Every other release site already branched on `zone_id` (cancelBooking, rejectPayment,
// sweepExpiredBookings); this one did not.
// ---------------------------------------------------------------------------
describe('Zoned cancellation releases zone seats (regression)', () => {
  const seedZonedService = async (organizationId: string): Promise<string> => {
    const id = await seedService(organizationId)
    await env.DB.prepare(`UPDATE services SET zones_enabled = 1 WHERE id = ?`).bind(id).run()
    return id
  }

  const seedZone = async (organizationId: string, serviceId: string, name: string, capacity: number) => {
    const id = crypto.randomUUID()
    const t = Math.floor(Date.now() / 1000)
    await env.DB.prepare(
      `INSERT INTO service_zones (id, organization_id, service_id, name, capacity, sort_order, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, 'active', ?, ?)`,
    )
      .bind(id, organizationId, serviceId, name, capacity, t, t)
      .run()
    return id
  }

  const seedSlotZone = async (
    organizationId: string,
    slotId: string,
    zoneId: string,
    capacity: number,
    booked: number,
  ) => {
    const t = Math.floor(Date.now() / 1000)
    await env.DB.prepare(
      `INSERT INTO slot_zones (id, organization_id, slot_id, zone_id, capacity, booked, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    )
      .bind(crypto.randomUUID(), organizationId, slotId, zoneId, capacity, booked, t, t)
      .run()
  }

  const tagLineToZone = (folioId: string, zoneId: string) =>
    env.DB.prepare(`UPDATE folio_lines SET zone_id = ?, zone_name = 'Zona' WHERE folio_id = ?`)
      .bind(zoneId, folioId)
      .run()

  const getZoneBooked = async (slotId: string, zoneId: string) => {
    const r = await env.DB.prepare(
      `SELECT booked FROM slot_zones WHERE slot_id = ? AND zone_id = ?`,
    )
      .bind(slotId, zoneId)
      .first<{ booked: number }>()
    return r?.booked ?? null
  }

  it('releases the ZONE counter, not just the slot total', async () => {
    const { organizationId, agentId } = await seedOrgWithStaff()
    const serviceId = await seedZonedService(organizationId)
    // Two zones, 20 + 30 seats. Three seats sold in "Bajo": slot totals derive to 50/3.
    const slotId = await seedSlot(organizationId, serviceId, { booked: 3, capacity: 50 })
    const bajo = await seedZone(organizationId, serviceId, 'Bajo', 20)
    const alto = await seedZone(organizationId, serviceId, 'Alto', 30)
    await seedSlotZone(organizationId, slotId, bajo, 20, 3)
    await seedSlotZone(organizationId, slotId, alto, 30, 0)

    const folioId = await seedFolio({ organizationId, agentId })
    await seedFolioLine({ organizationId, folioId, serviceId, slotId, quantity: 3 })
    await tagLineToZone(folioId, bajo)

    const { status } = await cancelFolio(ADMIN_EMAIL, folioId)
    expect(status).toBe(200)

    // The zone the seats were sold from is released — this is what was broken.
    expect(await getZoneBooked(slotId, bajo)).toBe(0)
    // The untouched zone is left alone.
    expect(await getZoneBooked(slotId, alto)).toBe(0)
    // And the slot total is re-derived from the zone sums (not decremented independently).
    expect(await getSlotBooked(slotId)).toBe(0)
  })

  it('the released zone seats survive a later reconcile (they are really re-sellable)', async () => {
    const { organizationId, agentId } = await seedOrgWithStaff()
    const serviceId = await seedZonedService(organizationId)
    const slotId = await seedSlot(organizationId, serviceId, { booked: 5, capacity: 20 })
    const bajo = await seedZone(organizationId, serviceId, 'Bajo', 20)
    await seedSlotZone(organizationId, slotId, bajo, 20, 5)

    const folioId = await seedFolio({ organizationId, agentId })
    await seedFolioLine({ organizationId, folioId, serviceId, slotId, quantity: 5 })
    await tagLineToZone(folioId, bajo)

    await cancelFolio(ADMIN_EMAIL, folioId)

    // Re-derive the slot from the zone sums, exactly as any later zone write would. Before the
    // fix `slots.booked` snapped back to 5 here — the seats were lost for good.
    await env.DB.prepare(
      `UPDATE slots SET booked = (SELECT COALESCE(SUM(booked), 0) FROM slot_zones
                                   WHERE slot_id = ? AND status = 'active')
        WHERE id = ?`,
    )
      .bind(slotId, slotId)
      .run()
    expect(await getSlotBooked(slotId)).toBe(0)
  })

  it('an UNZONED line still releases the slot total (no regression)', async () => {
    const { organizationId, agentId } = await seedOrgWithStaff()
    const serviceId = await seedService(organizationId)
    const slotId = await seedSlot(organizationId, serviceId, { booked: 4 })
    const folioId = await seedFolio({ organizationId, agentId })
    await seedFolioLine({ organizationId, folioId, serviceId, slotId, quantity: 4 })

    expect((await cancelFolio(ADMIN_EMAIL, folioId)).status).toBe(200)
    expect(await getSlotBooked(slotId)).toBe(0)
  })

  it('a MIXED folio releases the zoned line and the unzoned line correctly', async () => {
    const { organizationId, agentId } = await seedOrgWithStaff()
    const zonedService = await seedZonedService(organizationId)
    const plainService = await seedService(organizationId)
    const zonedSlot = await seedSlot(organizationId, zonedService, { booked: 2, capacity: 10, date: '2026-06-15' })
    const plainSlot = await seedSlot(organizationId, plainService, { booked: 6, date: '2026-06-16' })
    const bajo = await seedZone(organizationId, zonedService, 'Bajo', 10)
    await seedSlotZone(organizationId, zonedSlot, bajo, 10, 2)

    const folioId = await seedFolio({ organizationId, agentId })
    await seedFolioLine({ organizationId, folioId, serviceId: zonedService, slotId: zonedSlot, quantity: 2 })
    await env.DB.prepare(
      `UPDATE folio_lines SET zone_id = ?, zone_name = 'Bajo' WHERE folio_id = ? AND slot_id = ?`,
    )
      .bind(bajo, folioId, zonedSlot)
      .run()
    await seedFolioLine({ organizationId, folioId, serviceId: plainService, slotId: plainSlot, quantity: 6 })

    expect((await cancelFolio(ADMIN_EMAIL, folioId)).status).toBe(200)
    expect(await getZoneBooked(zonedSlot, bajo)).toBe(0)
    expect(await getSlotBooked(zonedSlot)).toBe(0)
    expect(await getSlotBooked(plainSlot)).toBe(0)
  })

  it('the zone counter is clamped at zero, never negative', async () => {
    const { organizationId, agentId } = await seedOrgWithStaff()
    const serviceId = await seedZonedService(organizationId)
    // A hand-edited zone holding FEWER seats than the folio claims.
    const slotId = await seedSlot(organizationId, serviceId, { booked: 1, capacity: 10 })
    const bajo = await seedZone(organizationId, serviceId, 'Bajo', 10)
    await seedSlotZone(organizationId, slotId, bajo, 10, 1)

    const folioId = await seedFolio({ organizationId, agentId })
    await seedFolioLine({ organizationId, folioId, serviceId, slotId, quantity: 3 })
    await tagLineToZone(folioId, bajo)

    expect((await cancelFolio(ADMIN_EMAIL, folioId)).status).toBe(200)
    expect(await getZoneBooked(slotId, bajo)).toBe(0)
  })
})
