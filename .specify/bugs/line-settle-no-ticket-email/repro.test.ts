// Reproduction for .specify/bugs/line-settle-no-ticket-email/assessment.md — NOT part of the suite.
// Run from api-turistear/:
//   npx vitest run --dir ../.specify/bugs/line-settle-no-ticket-email
// Every `it` below asserts TODAY's behaviour; a fix flips the BUG cases.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { seedUser, clearTenancyDb } from '../../../api-turistear/test/helpers/tenancy'
import { sessionCookie } from '../../../api-turistear/test/helpers/session'

const AGENT = 'agent@empresa.com'
const POS = 'http://api.local/api/pos'
const jsonAuth = { Cookie: sessionCookie(AGENT), 'Content-Type': 'application/json' }
const nowSec = () => Math.floor(Date.now() / 1000)
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)

let resendCalls: { to: string; subject: string; html: string }[] = []
const originalFetch = globalThis.fetch
const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
  if (url.includes('resend.com')) {
    const body = JSON.parse((init?.body as string) ?? '{}')
    resendCalls.push({ to: body.to, subject: body.subject, html: body.html })
    return new Response(JSON.stringify({ id: 'mock' }), { status: 200 })
  }
  return originalFetch(input, init)
})
const ticketEmails = () => resendCalls.filter((c) => c.subject.startsWith('Tu reserva está confirmada'))

const stage = async () => {
  const agent = await seedUser({ email: AGENT, role: 'agent', name: 'Ana R.' })
  const org = agent.organizationId
  await env.DB.prepare(`UPDATE organizations SET booking_min_down_payment_pct = 30 WHERE id = ?`).bind(org).run()
  const svc = crypto.randomUUID()
  const ts = nowSec()
  await env.DB.prepare(
    `INSERT INTO services (id, organization_id, name, description, base_price, minimum_price, default_capacity, commission_type, commission_value, status, created_at, updated_at)
     VALUES (?, ?, 'Tour', NULL, 100000, 25000, 12, 'percent', 1000, 'active', ?, ?)`,
  ).bind(svc, org, ts, ts).run()
  const slot = async (date: string) => {
    const id = crypto.randomUUID()
    await env.DB.prepare(
      `INSERT INTO slots (id, organization_id, service_id, schedule_id, date, start_time, capacity, booked, status, created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, '09:00', 12, 0, 'active', ?, ?)`,
    ).bind(id, org, svc, date, ts, ts).run()
    return id
  }
  return { near: await slot(day(3)), far: await slot(day(10)) }
}

// near $1,000 + far $500, org minimum 30%.
const book = async (s: { near: string; far: string }, deposit: number) => {
  const res = await SELF.fetch(`${POS}/folios`, {
    method: 'POST',
    headers: jsonAuth,
    body: JSON.stringify({
      customer_name: 'Cliente Test',
      customer_phone: '+52 55 1234 5678',
      customer_email: 'cliente@example.com',
      down_payment: deposit,
      lines: [
        { slot_id: s.near, quantity: 1, unit_price: 100000 },
        { slot_id: s.far, quantity: 1, unit_price: 50000 },
      ],
    }),
  })
  const json = (await res.json()) as any
  expect(res.status, JSON.stringify(json)).toBe(201)
  const line = (slotId: string) => json.folio.lines.find((l: any) => l.slot_id === slotId).id
  return { id: json.folio.id as string, near: line(s.near), far: line(s.far) }
}

const post = async (path: string) => {
  const res = await SELF.fetch(`${POS}${path}`, { method: 'POST', headers: jsonAuth, body: '{}' })
  expect(res.status, await res.clone().text()).toBe(200)
  return ((await res.json()) as any).folio
}

const outboxEvents = async (folioId: string) =>
  (
    await env.DB.prepare(`SELECT event FROM notifications WHERE folio_id = ?`).bind(folioId).all<{ event: string }>()
  ).results.map((r) => r.event)

beforeEach(async () => {
  for (const t of ['folio_line_extras', 'folio_requests', 'folio_lines', 'folio_access_tokens', 'folio_payments', 'notifications', 'folio_events', 'folios', 'slots', 'services']) {
    await env.DB.exec(`DELETE FROM ${t}`)
  }
  await clearTenancyDb()
  resendCalls = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(mockFetch as any)
  env.RESEND_API_KEY = 'test-key'
  env.RESEND_FROM = 'no-reply@turistearya.com'
})
afterEach(() => vi.restoreAllMocks())

describe('line-settle-no-ticket-email', () => {
  it('CONTROL — per-line settle, then "Liquidar saldo" (settleBooking): one ticket email, both QRs', async () => {
    const f = await book(await stage(), 60000)
    await post(`/folios/${f.id}/lines/${f.near}/settle`)
    const paid = await post(`/folios/${f.id}/settle`)

    expect(paid.status).toBe('paid')
    expect(ticketEmails()).toHaveLength(1)
    for (const l of paid.lines) expect(ticketEmails()[0].html).toContain(encodeURIComponent(l.qr_token))
    // ...yet no `tickets_delivered` outbox event on this path either.
    expect(await outboxEvents(f.id)).not.toContain('tickets_delivered')
  })

  it('BUG — every line settled per line: the folio is paid with a portal, and NO ticket email', async () => {
    const f = await book(await stage(), 60000)
    await post(`/folios/${f.id}/lines/${f.near}/settle`)
    const paid = await post(`/folios/${f.id}/lines/${f.far}/settle`)

    expect(paid.status).toBe('paid')
    expect(paid.portal_link).toBeTruthy()
    expect(paid.lines.every((l: any) => !!l.qr_token)).toBe(true)
    expect(ticketEmails()).toHaveLength(0) // ← the bug
    expect(await outboxEvents(f.id)).not.toContain('tickets_delivered')
  })

  it('BUG (worse) — a line the deposit funded in full never gets a QR when the last line settles per line', async () => {
    // $1,150 deposit: seeds 300 + 150, surplus 700 → near, so near is fully funded at booking.
    const f = await book(await stage(), 115000)
    const paid = await post(`/folios/${f.id}/lines/${f.far}/settle`)

    expect(paid.status).toBe('paid')
    const near = paid.lines.find((l: any) => l.id === f.near)
    expect(near.money_state).toBe('paid')
    expect(near.qr_token).toBeNull() // ← paid tour, no pass: nothing to scan, nothing in the portal
    expect(ticketEmails()).toHaveLength(0)
  })
})
