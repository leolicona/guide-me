import { describe, it, expect, beforeEach } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { seedUser, seedTwoOrgs, clearFullDb, materializeSeededFolio } from '../helpers/tenancy'
import { EVENTS, renderOutboxMessage } from '../../src/utils/notifications'
import { sessionCookie } from '../helpers/session'

// US-A86 / US-AG51 — the notification outbox.
// Spec: docs/folios/folio-state-machine.spec.md — S-13 … S-17, plus D20/D21/D26.
//
// What is worth asserting here is the set of promises the outbox makes and nothing else:
//   · every event is written to the customer by WhatsApp, email additionally (D20)
//   · a re-run cannot duplicate a message (the unique guard)
//   · `skipped` (no address) is a different fact from `failed` (the provider refused)
//   · a drained row says a human SENT it, never that the customer received it (D21)
//   · draining `tickets_delivered` is the only writer of `tickets_sent_at` (D26)

const ADMIN = 'admin@empresa.com'
const auth = (email: string) => ({ Cookie: sessionCookie(email) })
const OUTBOX = 'http://api.local/api/notifications'
const nowSec = () => Math.floor(Date.now() / 1000)

const seedFolio = async (opts: {
  organizationId: string
  agentId: string
  customerEmail?: string | null
}): Promise<string> => {
  const id = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO folios
       (id, organization_id, agent_id, customer_name, customer_email, customer_phone,
        status, subtotal, discount_total, total, amount_paid, created_at, updated_at)
     VALUES (?, ?, ?, 'Ana Buceo', ?, '+529981234567', 'paid', 200000, 0, 200000, 200000, ?, ?)`,
  )
    .bind(id, opts.organizationId, opts.agentId, opts.customerEmail ?? null, nowSec(), nowSec())
    .run()
  return id
}

const seedRow = async (opts: {
  organizationId: string
  folioId: string
  event?: string
  channel?: 'email' | 'whatsapp'
  status?: string
}): Promise<string> => {
  const id = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO notifications (id, organization_id, folio_id, event, channel, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id, opts.organizationId, opts.folioId,
      opts.event ?? 'payment_verified', opts.channel ?? 'whatsapp',
      opts.status ?? 'pending', nowSec(),
    )
    .run()
  return id
}

const rowsFor = async (folioId: string) =>
  (
    await env.DB.prepare(
      `SELECT event, channel, status, sent_by FROM notifications WHERE folio_id = ? ORDER BY channel`,
    )
      .bind(folioId)
      .all()
  ).results as Array<{ event: string; channel: string; status: string; sent_by: string | null }>

const drain = (email: string, id: string) =>
  SELF.fetch(`${OUTBOX}/${id}/sent`, {
    method: 'POST',
    headers: { ...auth(email), 'Content-Type': 'application/json' },
    body: '{}',
  })

beforeEach(clearFullDb)

describe('US-A86 — the outbox records what was emitted', () => {
  it('S-13 — no address on file: the WhatsApp row is pending, the email row is SKIPPED', async () => {
    const { organizationId, userId } = await seedUser({ email: ADMIN, role: 'admin' })
    const folioId = await seedFolio({ organizationId, agentId: userId, customerEmail: null })

    // Emitting is what the handlers do; asserting it through one is what the other suites cover.
    await env.DB.prepare(
      `INSERT INTO notifications (id, organization_id, folio_id, event, channel, status)
       VALUES (?, ?, ?, 'payment_verified', 'whatsapp', 'pending'),
              (?, ?, ?, 'payment_verified', 'email', 'skipped')`,
    )
      .bind(crypto.randomUUID(), organizationId, folioId, crypto.randomUUID(), organizationId, folioId)
      .run()

    const rows = await rowsFor(folioId)
    expect(rows.find((r) => r.channel === 'whatsapp')!.status).toBe('pending')
    // `skipped`, NOT `failed` — no address is "this channel does not apply", which must not be
    // counted alongside "the provider refused".
    expect(rows.find((r) => r.channel === 'email')!.status).toBe('skipped')
  })

  it('S-14 — the unique guard makes a re-run unable to duplicate a message', async () => {
    const { organizationId, userId } = await seedUser({ email: ADMIN, role: 'admin' })
    const folioId = await seedFolio({ organizationId, agentId: userId })
    await seedRow({ organizationId, folioId, event: 'booking_grace_entered' })

    // Exactly what a second sweep run would attempt.
    await expect(
      seedRow({ organizationId, folioId, event: 'booking_grace_entered' }),
    ).rejects.toThrow()

    expect(await rowsFor(folioId)).toHaveLength(1)
  })
})

describe('US-A86 — draining a WhatsApp row', () => {
  it('an admin marks it sent, and the row records WHO', async () => {
    const { organizationId, userId } = await seedUser({ email: ADMIN, role: 'admin' })
    const folioId = await seedFolio({ organizationId, agentId: userId })
    const id = await seedRow({ organizationId, folioId })

    expect((await drain(ADMIN, id)).status).toBe(200)
    const [row] = await rowsFor(folioId)
    expect(row.status).toBe('sent')
    expect(row.sent_by).toBe(userId)
  })

  it('S-16 — an email row cannot be drained by a human', async () => {
    const { organizationId, userId } = await seedUser({ email: ADMIN, role: 'admin' })
    const folioId = await seedFolio({ organizationId, agentId: userId })
    const id = await seedRow({ organizationId, folioId, channel: 'email' })

    const res = await drain(ADMIN, id)
    expect(res.status).toBe(422)
    expect(JSON.stringify(await res.json())).toContain('NOTIFICATION_NOT_DRAINABLE')
  })

  it('draining twice is a 409, not a second send', async () => {
    const { organizationId, userId } = await seedUser({ email: ADMIN, role: 'admin' })
    const folioId = await seedFolio({ organizationId, agentId: userId })
    const id = await seedRow({ organizationId, folioId })

    expect((await drain(ADMIN, id)).status).toBe(200)
    const again = await drain(ADMIN, id)
    expect(again.status).toBe(409)
    expect(JSON.stringify(await again.json())).toContain('NOTIFICATION_ALREADY_SENT')
  })

  it("an agent may drain their OWN sale's row, and not somebody else's", async () => {
    const { organizationId, userId: adminId } = await seedUser({ email: ADMIN, role: 'admin' })
    const { userId: agentId } = await seedUser({
      email: 'agente@empresa.com', role: 'agent', organizationId,
    })

    const mine = await seedFolio({ organizationId, agentId })
    const theirs = await seedFolio({ organizationId, agentId: adminId })
    const mineRow = await seedRow({ organizationId, folioId: mine })
    const theirsRow = await seedRow({ organizationId, folioId: theirs })

    expect((await drain('agente@empresa.com', mineRow)).status).toBe(200)
    // 404, never 403 — an agent must not learn that another seller's row exists.
    expect((await drain('agente@empresa.com', theirsRow)).status).toBe(404)
  })

  it('S-16d / D26 — draining `tickets_delivered` is what stamps `tickets_sent_at`', async () => {
    const { organizationId, userId } = await seedUser({ email: ADMIN, role: 'admin' })
    const folioId = await seedFolio({ organizationId, agentId: userId })
    const id = await seedRow({ organizationId, folioId, event: 'tickets_delivered' })

    const before = await env.DB.prepare(`SELECT tickets_sent_at FROM folios WHERE id = ?`)
      .bind(folioId).first<{ tickets_sent_at: number | null }>()
    expect(before!.tickets_sent_at).toBeNull()

    expect((await drain(ADMIN, id)).status).toBe(200)

    const after = await env.DB.prepare(
      `SELECT tickets_sent_at, tickets_sent_by FROM folios WHERE id = ?`,
    ).bind(folioId).first<{ tickets_sent_at: number | null; tickets_sent_by: string | null }>()
    // One write produced both records, so they cannot drift. The mutation this must catch is a
    // second code path stamping the axis on its own.
    expect(after!.tickets_sent_at).not.toBeNull()
    expect(after!.tickets_sent_by).toBe(userId)
  })

  it('S-16c — sent is not received: no drain may touch `tickets_viewed_at`', async () => {
    const { organizationId, userId } = await seedUser({ email: ADMIN, role: 'admin' })
    const folioId = await seedFolio({ organizationId, agentId: userId })

    for (const event of ['tickets_delivered', 'payment_verified', 'refund_completed']) {
      const id = await seedRow({ organizationId, folioId, event })
      expect((await drain(ADMIN, id)).status).toBe(200)
    }

    const row = await env.DB.prepare(`SELECT tickets_viewed_at FROM folios WHERE id = ?`)
      .bind(folioId).first<{ tickets_viewed_at: number | null }>()
    // `tickets_viewed_at` is a real first-view beacon from the portal and the ONLY thing that may
    // render `✓✓ Visto`. A drained row asserts a human sent it, never that anyone read it (D21).
    expect(row!.tickets_viewed_at).toBeNull()
  })
})

describe('US-A86 — the admin outbox view', () => {
  it('lists pending rows with the customer they are about', async () => {
    const { organizationId, userId } = await seedUser({ email: ADMIN, role: 'admin' })
    const folioId = await seedFolio({ organizationId, agentId: userId })
    await seedRow({ organizationId, folioId })

    const res = await SELF.fetch(`${OUTBOX}?status=pending&channel=whatsapp`, { headers: auth(ADMIN) })
    const body = (await res.json()) as any
    expect(body.notifications).toHaveLength(1)
    expect(body.notifications[0].customer_name).toBe('Ana Buceo')
    expect(body.notifications[0].customer_phone).toBe('+529981234567')
    // The message travels with the row so the drain screen opens the composer without a second read.
    expect(body.notifications[0].template).toContain('{customer_name}')
  })

  it('S-12 — a seller gets no inbox', async () => {
    const { organizationId } = await seedUser({ email: ADMIN, role: 'admin' })
    await seedUser({ email: 'agente@empresa.com', role: 'agent', organizationId })
    expect((await SELF.fetch(OUTBOX, { headers: auth('agente@empresa.com') })).status).toBe(403)
  })
})

describe('Multitenancy isolation', () => {
  it("S-17 — another org's row is invisible, and undrainable with a 404", async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    const folioB = await seedFolio({ organizationId: orgB.organizationId, agentId: orgB.adminUserId })
    const rowB = await seedRow({ organizationId: orgB.organizationId, folioId: folioB })

    const list = await SELF.fetch(OUTBOX, { headers: auth(orgA.adminEmail) })
    expect(((await list.json()) as any).notifications).toHaveLength(0)

    // 404, never 403 — a 403 confirms the row exists.
    const res = await drain(orgA.adminEmail, rowB)
    expect(res.status).toBe(404)

    // And it was NOT drained by the attempt.
    const [row] = await rowsFor(folioB)
    expect(row.status).toBe('pending')
  })
})

// bug: payment-rejected-folio-copy (.specify/bugs/payment-rejected-folio-copy/assessment.md) — the
// customer bought a «compra», never a «folio» (constitution VII), and the outbox row carries its
// message already filled from the sale: the composer used to fill only the customer's name and cut
// the rest, so the customer read «…la cancelación de tu folio en .». D11 (Devolada) sends
// `payment_rejected` for every transfer that never arrives, with no human tap behind it.
describe('bug: payment-rejected-folio-copy — the outbox sends a whole message', () => {
  const pendingMessages = async (email: string) => {
    const res = await SELF.fetch(`${OUTBOX}?status=pending&channel=whatsapp`, { headers: auth(email) })
    expect(res.status).toBe(200)
    return ((await res.json()) as any).notifications.map((n: any) => n.message as string)
  }

  it('a rejected payment names the organization and is signed by the seller', async () => {
    const { organizationId, userId } = await seedUser({
      email: ADMIN, role: 'admin', name: 'Lucía Vende', organizationName: 'Buceo Cancún',
    })
    const folioId = await seedFolio({ organizationId, agentId: userId })
    await seedRow({ organizationId, folioId, event: 'payment_rejected' })

    expect(await pendingMessages(ADMIN)).toEqual([
      'Hola Ana Buceo, no pudimos confirmar el pago de tu compra en Buceo Cancún, así que tuvimos ' +
        'que cancelarla. Si crees que es un error, escríbeme. — Lucía Vende',
    ])
  })

  it('an approved cancellation names the organization', async () => {
    const { organizationId, userId } = await seedUser({
      email: ADMIN, role: 'admin', organizationName: 'Buceo Cancún',
    })
    const folioId = await seedFolio({ organizationId, agentId: userId })
    await seedRow({ organizationId, folioId, event: 'cancellation_approved' })

    expect(await pendingMessages(ADMIN)).toEqual([
      'Hola Ana Buceo, aprobamos la cancelación de tu compra en Buceo Cancún. Te contamos ' +
        'enseguida cómo queda.',
    ])
  })

  it('a completed refund spells out what was paid, returned and kept', async () => {
    const { organizationId, userId } = await seedUser({
      email: ADMIN, role: 'admin', organizationName: 'Buceo Cancún',
    })
    const folioId = await seedFolio({ organizationId, agentId: userId })
    await materializeSeededFolio(folioId)
    await env.DB.prepare(
      `UPDATE folio_lines SET refund_status = 'refunded', refund_amount = 150000 WHERE folio_id = ?`,
    )
      .bind(folioId)
      .run()
    await seedRow({ organizationId, folioId, event: 'refund_completed' })

    expect(await pendingMessages(ADMIN)).toEqual([
      'Hola Ana Buceo, confirmamos el reembolso de tu compra en Buceo Cancún. Pagaste $2,000.00, ' +
        'te devolvimos $1,500.00 y se retuvo $500.00 según la política de cancelación.',
    ])
  })

  it("each organization's message names its own organization", async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    for (const o of [orgA, orgB]) {
      const folioId = await seedFolio({ organizationId: o.organizationId, agentId: o.adminUserId })
      await seedRow({ organizationId: o.organizationId, folioId, event: 'cancellation_approved' })
    }
    const [a] = await pendingMessages(orgA.adminEmail)
    const [b] = await pendingMessages(orgB.adminEmail)
    expect(a).toContain('tu compra en Org A.')
    expect(b).toContain('tu compra en Org B.')
  })

  it('no shipped template says «folio», and a value is never read again as a placeholder', () => {
    for (const [event, def] of Object.entries(EVENTS)) {
      expect(def.template, event).not.toMatch(/folio/i)
    }
    const message = renderOutboxMessage(EVENTS.payment_rejected.template, {
      customerName: 'Ana {org_name}',
      orgName: 'Buceo',
      agentName: null,
      timezone: 'UTC',
      total: 0,
      amountPaid: 0,
      refundAmount: null,
      creditAmount: null,
      creditExpiresAt: null,
      bookingExpiresAt: null,
    })
    expect(message.startsWith('Hola Ana {org_name}, no pudimos')).toBe(true)
    expect(message).not.toMatch(/\{(?!org_name\})[a-z_]+\}/)
  })
})
