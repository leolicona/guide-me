import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { seedUser, seedTwoOrgs, clearTenancyDb } from '../helpers/tenancy'
import { buildFakeJwt } from '../helpers/jwt'

// Tourist Self-Service Portal — Magic Link, itinerary, QR, cancellation request +
// Refund PIN. US-T01–T05 + US-A23 (cash refund tracking, bundled).
// Spec: docs/tourist-portal/tourist-self-service-portal.spec.md
//
// The portal is PUBLIC Worker-rendered HTML: the folio-scoped token in the URL is the
// credential (no session, no role). A tourist's cancellation is a REQUEST — inventory
// moves only when an admin approves (funnelling into the existing cancelFolio), which on
// a paid folio opens the refund obligation: refund_status='pending' + a portal-only PIN
// the tourist hands over to prove the physical cash came back.

const ADMIN_EMAIL = 'admin@empresa.com'
const AGENT_EMAIL = 'agent@empresa.com'

const auth = (email: string) => ({ Cookie: `gm_access=${buildFakeJwt(email)}` })
const jsonAuth = (email: string) => ({
  ...auth(email),
  'Content-Type': 'application/json',
})

const nowSec = () => Math.floor(Date.now() / 1000)

// A slot comfortably in the future so the portal token expiry lands past "now".
const SLOT_DATE = (() => {
  const d = new Date(Date.now() + 14 * 86400 * 1000)
  return d.toISOString().slice(0, 10)
})()

// --- Seeders (raw D1) --------------------------------------------------------

const seedService = async (orgId: string, name = 'Tour del Cañón') => {
  const id = crypto.randomUUID()
  const ts = nowSec()
  await env.DB.prepare(
    `INSERT INTO services (id, organization_id, name, description, base_price, minimum_price, default_capacity, commission_value, status, created_at, updated_at)
     VALUES (?, ?, ?, 'Punto de encuentro: muelle 3', 150000, 100000, 12, 0, 'active', ?, ?)`,
  )
    .bind(id, orgId, name, ts, ts)
    .run()
  return { id }
}

const seedSlot = async (orgId: string, svcId: string, cap = 12) => {
  const id = crypto.randomUUID()
  const ts = nowSec()
  await env.DB.prepare(
    `INSERT INTO slots (id, organization_id, service_id, schedule_id, date, start_time, capacity, booked, status, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, '10:00', ?, 0, 'active', ?, ?)`,
  )
    .bind(id, orgId, svcId, SLOT_DATE, cap, ts, ts)
    .run()
  return { id }
}

// A folio seeded directly (bypassing POS) — for the unpaid-booking edge (S9).
const seedRawFolio = async (orgId: string, agentId: string, amountPaid: number) => {
  const id = crypto.randomUUID()
  const ts = nowSec()
  await env.DB.prepare(
    `INSERT INTO folios (id, organization_id, agent_id, customer_name, customer_email, status, payment_method,
       subtotal, discount_total, total, amount_paid, commission_amount, cancellation_clawback, created_at, updated_at)
     VALUES (?, ?, ?, 'Cliente Test', 'cliente@example.com', 'paid', 'cash', 100000, 0, 100000, ?, 0, 0, ?, ?)`,
  )
    .bind(id, orgId, agentId, amountPaid, ts, ts)
    .run()
  return id
}

const seedToken = async (
  orgId: string,
  folioId: string,
  opts: { expiresAt?: number } = {},
) => {
  const token = `tok-${crypto.randomUUID()}`
  await env.DB.prepare(
    `INSERT INTO folio_access_tokens (id, organization_id, folio_id, token, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(crypto.randomUUID(), orgId, folioId, token, opts.expiresAt ?? nowSec() + 86400)
    .run()
  return token
}

const getTokenRow = (folioId: string) =>
  env.DB.prepare(
    `SELECT token, expires_at, last_accessed_at FROM folio_access_tokens WHERE folio_id = ?`,
  )
    .bind(folioId)
    .first<{ token: string; expires_at: number; last_accessed_at: number | null }>()

const getFolioRow = (id: string) =>
  env.DB.prepare(
    `SELECT status, refund_status, refund_amount, refund_pin, refund_pin_attempts, refund_note, refunded_by
       FROM folios WHERE id = ?`,
  )
    .bind(id)
    .first<{
      status: string
      refund_status: string
      refund_amount: number | null
      refund_pin: string | null
      refund_pin_attempts: number
      refund_note: string | null
      refunded_by: string | null
    }>()

const getSlotBooked = async (id: string) =>
  Number(
    (await env.DB.prepare(`SELECT booked FROM slots WHERE id = ?`).bind(id).first<{ booked: number }>())
      ?.booked ?? -1,
  )

const getRequestRow = (folioId: string) =>
  env.DB.prepare(
    `SELECT id, status, reason, resolution_note, resolved_by FROM cancellation_requests WHERE folio_id = ? ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(folioId)
    .first<{
      id: string
      status: string
      reason: string | null
      resolution_note: string | null
      resolved_by: string | null
    }>()

// --- API helpers ---------------------------------------------------------------

const confirmSale = async (email: string, body: Record<string, unknown>) => {
  const res = await SELF.fetch('http://api.local/api/pos/folios', {
    method: 'POST',
    headers: jsonAuth(email),
    body: JSON.stringify(body),
  })
  return { status: res.status, json: (await res.json()) as any }
}

const portalGet = async (token: string) => {
  const res = await SELF.fetch(`http://api.local/portal/${token}`)
  return { status: res.status, html: await res.text() }
}

const requestCancellation = async (token: string, reason?: string) => {
  const res = await SELF.fetch(`http://api.local/portal/${token}/cancellation-request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: reason != null ? new URLSearchParams({ reason }).toString() : '',
    redirect: 'manual',
  })
  return { status: res.status, location: res.headers.get('location'), html: await res.text() }
}

const listRequests = async (email: string, query = '') => {
  const res = await SELF.fetch(
    `http://api.local/api/folios/cancellation-requests${query ? `?${query}` : ''}`,
    { headers: auth(email) },
  )
  return { status: res.status, json: (await res.json()) as any }
}

const approveRequest = async (email: string, requestId: string, body: Record<string, unknown> = {}) => {
  const res = await SELF.fetch(
    `http://api.local/api/folios/cancellation-requests/${requestId}/approve`,
    { method: 'POST', headers: jsonAuth(email), body: JSON.stringify(body) },
  )
  return { status: res.status, json: (await res.json()) as any }
}

const rejectRequest = async (email: string, requestId: string, body: Record<string, unknown>) => {
  const res = await SELF.fetch(
    `http://api.local/api/folios/cancellation-requests/${requestId}/reject`,
    { method: 'POST', headers: jsonAuth(email), body: JSON.stringify(body) },
  )
  return { status: res.status, json: (await res.json()) as any }
}

const confirmRefund = async (email: string, folioId: string, body: Record<string, unknown>) => {
  const res = await SELF.fetch(`http://api.local/api/folios/${folioId}/refund/confirm`, {
    method: 'POST',
    headers: jsonAuth(email),
    body: JSON.stringify(body),
  })
  return { status: res.status, json: (await res.json()) as any }
}

const adminCancel = async (email: string, folioId: string) => {
  const res = await SELF.fetch(`http://api.local/api/folios/${folioId}/cancel`, {
    method: 'POST',
    headers: jsonAuth(email),
    body: JSON.stringify({}),
  })
  return { status: res.status, json: (await res.json()) as any }
}

const errCode = (json: any): string => json.error?.code ?? json.code

// Sell one folio through the real POS flow (token issued, email queued). Returns the
// portal token straight from the DB — the same value the email link carries.
const sellFolio = async (orgId: string) => {
  const svc = await seedService(orgId)
  const slot = await seedSlot(orgId, svc.id)
  const sale = await confirmSale(AGENT_EMAIL, {
    customer_email: 'cliente@example.com',
    customer_name: 'Cliente Test',
    lines: [{ slot_id: slot.id, quantity: 2, unit_price: 150000 }],
  })
  expect(sale.status).toBe(201)
  const folioId: string = sale.json.folio.id
  const tokenRow = await getTokenRow(folioId)
  expect(tokenRow).toBeTruthy()
  return { folioId, token: tokenRow!.token, slotId: slot.id, serviceName: 'Tour del Cañón' }
}

// --- Resend mock (same pattern as the email suite) -------------------------------

let resendCalls: { to: string; subject: string; html: string }[] = []

const originalFetch = globalThis.fetch
const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url =
    typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input.url ?? String(input))
  if (url.includes('resend.com')) {
    const body = JSON.parse((init?.body as string) ?? '{}')
    resendCalls.push({ to: body.to, subject: body.subject, html: body.html })
    return new Response(JSON.stringify({ id: 'mock-id' }), { status: 200 })
  }
  return originalFetch(input, init)
})

const clearPortalDb = async () => {
  await env.DB.exec('DELETE FROM cancellation_requests')
  await env.DB.exec('DELETE FROM folio_access_tokens')
  await env.DB.exec('DELETE FROM folio_line_extras')
  await env.DB.exec('DELETE FROM folio_lines')
  await env.DB.exec('DELETE FROM folios')
  await env.DB.exec('DELETE FROM slots')
  await env.DB.exec('DELETE FROM service_extras')
  await env.DB.exec('DELETE FROM services')
}

const seedOrgWithStaff = async () => {
  const { organizationId, userId: adminId } = await seedUser({ email: ADMIN_EMAIL, role: 'admin' })
  const { userId: agentId } = await seedUser({ email: AGENT_EMAIL, role: 'agent', organizationId })
  return { organizationId, adminId, agentId }
}

beforeEach(async () => {
  await clearPortalDb()
  await clearTenancyDb()
  resendCalls = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(mockFetch as any)
})
afterEach(() => vi.restoreAllMocks())

describe('Tourist Self-Service Portal — magic link, itinerary, cancellation request, refund PIN', () => {
  // ---------------------------------------------------------------------------
  // US-T01 — magic link issuance
  // ---------------------------------------------------------------------------
  it('S1 — a confirmed sale issues a folio-scoped token and the email carries the portal link', async () => {
    const { organizationId } = await seedOrgWithStaff()
    const { folioId, token } = await sellFolio(organizationId)

    // The confirmation email contains the portal link built from the same token.
    expect(resendCalls).toHaveLength(1)
    expect(resendCalls[0].html).toContain(`/portal/${token}`)

    // And the token resolves to that folio.
    const page = await portalGet(token)
    expect(page.status).toBe(200)
    expect(page.html).toContain(folioId.slice(0, 8).toUpperCase())
  })

  it('S2 — a sale missing nothing but the email link still commits (token without email)', async () => {
    // The link delivery is best-effort: even when no confirmation email goes out
    // (here: Resend key removed), the sale and the token row both commit.
    const prevKey = env.RESEND_API_KEY
    ;(env as any).RESEND_API_KEY = ''
    try {
      const { organizationId } = await seedOrgWithStaff()
      const { folioId, token } = await sellFolio(organizationId)
      expect(resendCalls).toHaveLength(0)
      expect((await getTokenRow(folioId))?.token).toBe(token)
    } finally {
      ;(env as any).RESEND_API_KEY = prevKey
    }
  })

  it('S19 — token is high-entropy base64url and unique per sale; the PIN is 6 crypto digits', async () => {
    const { organizationId } = await seedOrgWithStaff()
    const a = await sellFolio(organizationId)
    const b = await sellFolio(organizationId)
    // 32 random bytes → 43 base64url chars, no padding.
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(b.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(a.token).not.toBe(b.token)

    await requestCancellation(a.token)
    const req = await getRequestRow(a.folioId)
    await approveRequest(ADMIN_EMAIL, req!.id)
    expect((await getFolioRow(a.folioId))?.refund_pin).toMatch(/^\d{6}$/)
  })

  // ---------------------------------------------------------------------------
  // US-T02 / US-T03 — itinerary & QR
  // ---------------------------------------------------------------------------
  it('S3 — the portal renders the itinerary with QR images and touches last_accessed_at', async () => {
    const { organizationId } = await seedOrgWithStaff()
    const { folioId, token, serviceName } = await sellFolio(organizationId)

    const page = await portalGet(token)
    expect(page.status).toBe(200)
    expect(page.html).toContain(serviceName)
    // BUG-009 — the QR is an inline locally-rendered SVG; the signed token (the entry
    // credential) must never be shipped to a third-party image service.
    expect(page.html).toContain('<svg')
    expect(page.html).not.toContain('qrserver.com')
    expect(page.html).toContain('Presenta este código al llegar')
    expect(page.html).toContain('2 personas')
    // The service description doubles as the meeting-point blurb (US-T02).
    expect(page.html).toContain('Punto de encuentro: muelle 3')

    expect((await getTokenRow(folioId))?.last_accessed_at).not.toBeNull()
  })

  it('S4 — unknown token → 404 page; expired token → 410 page (generic copy)', async () => {
    const { organizationId, agentId } = await seedOrgWithStaff()

    const unknown = await portalGet('definitely-not-a-token')
    expect(unknown.status).toBe(404)
    expect(unknown.html).toContain('Enlace no válido')

    const folioId = await seedRawFolio(organizationId, agentId, 100000)
    const expired = await seedToken(organizationId, folioId, { expiresAt: nowSec() - 60 })
    const gone = await portalGet(expired)
    expect(gone.status).toBe(410)
    expect(gone.html).toContain('Enlace expirado')
    // Generic copy — the page never confirms a folio exists.
    expect(gone.html).not.toContain(folioId.slice(0, 8).toUpperCase())
  })

  it('S5 — a cancelled folio shows the cancelled banner and no QR / valid-ticket framing', async () => {
    const { organizationId } = await seedOrgWithStaff()
    const { folioId, token } = await sellFolio(organizationId)

    await adminCancel(ADMIN_EMAIL, folioId)

    const page = await portalGet(token)
    expect(page.status).toBe(200)
    expect(page.html).toContain('Reserva cancelada')
    expect(page.html).not.toContain('<svg')
    expect(page.html).not.toContain('Presenta este código al llegar')
  })

  // ---------------------------------------------------------------------------
  // US-T04 — cancellation request
  // ---------------------------------------------------------------------------
  it('S6 — submitting a request creates a pending row, touches no inventory, and lands in the admin queue', async () => {
    const { organizationId } = await seedOrgWithStaff()
    const { folioId, token, slotId } = await sellFolio(organizationId)
    expect(await getSlotBooked(slotId)).toBe(2)

    const res = await requestCancellation(token, 'Cambio de planes')
    expect(res.status).toBe(303)
    expect(res.location).toContain(`/portal/${token}`)

    const request = await getRequestRow(folioId)
    expect(request?.status).toBe('pending')
    expect(request?.reason).toBe('Cambio de planes')
    // Inventory and folio untouched — only an admin approval cancels (spec D4).
    expect((await getFolioRow(folioId))?.status).toBe('paid')
    expect(await getSlotBooked(slotId)).toBe(2)

    const queue = await listRequests(ADMIN_EMAIL)
    expect(queue.status).toBe(200)
    expect(queue.json.requests.map((r: any) => r.id)).toContain(request!.id)
    expect(queue.json.requests[0].reason).toBe('Cambio de planes')
    expect(queue.json.requests[0].folio.customer_name).toBe('Cliente Test')

    // The portal now shows the in-review state instead of the request form.
    const page = await portalGet(token)
    expect(page.html).toContain('Solicitud de cancelación en revisión')
  })

  it('S7 — a duplicate open request, or a request on a cancelled folio, is rejected with 409', async () => {
    const { organizationId } = await seedOrgWithStaff()
    const { folioId, token } = await sellFolio(organizationId)

    expect((await requestCancellation(token)).status).toBe(303)
    expect((await requestCancellation(token)).status).toBe(409)

    // Second folio: cancelled before the tourist asks → 409 too.
    const second = await sellFolio(organizationId)
    await adminCancel(ADMIN_EMAIL, second.folioId)
    expect((await requestCancellation(second.token)).status).toBe(409)

    // Still exactly one request row for the first folio.
    const count = await env.DB.prepare(
      `SELECT count(*) AS c FROM cancellation_requests WHERE folio_id = ?`,
    )
      .bind(folioId)
      .first<{ c: number }>()
    expect(Number(count?.c)).toBe(1)
  })

  it('S8 — approval cancels via the US-A21 path, releases seats, emails, and opens the refund with a PIN', async () => {
    const { organizationId, adminId } = await seedOrgWithStaff()
    const { folioId, token, slotId } = await sellFolio(organizationId)
    await requestCancellation(token, 'Ya no podremos ir')
    const request = await getRequestRow(folioId)
    resendCalls = []

    const res = await approveRequest(ADMIN_EMAIL, request!.id)
    expect(res.status).toBe(200)
    expect(res.json.request.status).toBe('approved')
    expect(res.json.request.resolved_by).toBe(adminId)
    expect(res.json.folio.status).toBe('cancelled')
    expect(res.json.folio.refund_status).toBe('pending')
    expect(res.json.folio.refund_amount).toBe(300000) // 2 × 150000

    // Seats released; the tourist's reason became the cancellation reason.
    expect(await getSlotBooked(slotId)).toBe(0)
    const folio = await getFolioRow(folioId)
    expect(folio?.status).toBe('cancelled')
    expect(folio?.refund_pin).toMatch(/^\d{6}$/)

    // The standard cancellation email fired (US-A21 path, unchanged).
    expect(resendCalls).toHaveLength(1)
    expect(resendCalls[0].subject).toContain('cancelada')

    // Approving again → 409 (already resolved).
    expect((await approveRequest(ADMIN_EMAIL, request!.id)).status).toBe(409)
  })

  it('S9 — approving an UNPAID folio cancels it without opening a refund (no PIN)', async () => {
    const { organizationId, agentId } = await seedOrgWithStaff()
    const folioId = await seedRawFolio(organizationId, agentId, 0)
    const token = await seedToken(organizationId, folioId)
    await requestCancellation(token)
    const request = await getRequestRow(folioId)

    const res = await approveRequest(ADMIN_EMAIL, request!.id)
    expect(res.status).toBe(200)
    const folio = await getFolioRow(folioId)
    expect(folio?.status).toBe('cancelled')
    expect(folio?.refund_status).toBe('none')
    expect(folio?.refund_pin).toBeNull()
  })

  it('S10 — rejection requires a note, resolves the request, and leaves the folio untouched', async () => {
    const { organizationId, adminId } = await seedOrgWithStaff()
    const { folioId, token, slotId } = await sellFolio(organizationId)
    await requestCancellation(token)
    const request = await getRequestRow(folioId)

    // Empty note → 400.
    for (const body of [{ note: '' }, { note: '   ' }, {}]) {
      const bad = await rejectRequest(ADMIN_EMAIL, request!.id, body)
      expect(bad.status).toBe(400)
      expect(errCode(bad.json)).toBe('VALIDATION_ERROR')
    }

    const res = await rejectRequest(ADMIN_EMAIL, request!.id, { note: 'Fuera de la ventana de cancelación' })
    expect(res.status).toBe(200)
    expect(res.json.request.status).toBe('rejected')
    expect(res.json.request.resolution_note).toBe('Fuera de la ventana de cancelación')
    expect(res.json.request.resolved_by).toBe(adminId)

    // Folio + seats untouched.
    expect((await getFolioRow(folioId))?.status).toBe('paid')
    expect(await getSlotBooked(slotId)).toBe(2)

    // The portal shows the rejection note and offers the form again.
    const page = await portalGet(token)
    expect(page.html).toContain('Fuera de la ventana de cancelación')
    expect(page.html).toContain('Solicitar cancelación')

    // Re-rejecting / approving a resolved request → 409.
    expect((await rejectRequest(ADMIN_EMAIL, request!.id, { note: 'x' })).status).toBe(409)
    expect((await approveRequest(ADMIN_EMAIL, request!.id)).status).toBe(409)

    // After a rejection the tourist may file a fresh request (only OPEN ones are unique).
    expect((await requestCancellation(token)).status).toBe(303)
  })

  // ---------------------------------------------------------------------------
  // US-T05 / US-A23 — Refund PIN & confirmation
  // ---------------------------------------------------------------------------
  const approvedRefundSetup = async () => {
    const { organizationId, adminId } = await seedOrgWithStaff()
    const sold = await sellFolio(organizationId)
    await requestCancellation(sold.token)
    const request = await getRequestRow(sold.folioId)
    await approveRequest(ADMIN_EMAIL, request!.id)
    const pin = (await getFolioRow(sold.folioId))!.refund_pin!
    return { ...sold, organizationId, adminId, pin }
  }

  it('S11 — the PIN is portal-only: absent before approval, shown while pending, never in any email', async () => {
    const { organizationId } = await seedOrgWithStaff()
    const { folioId, token } = await sellFolio(organizationId)

    expect((await portalGet(token)).html).not.toContain('PIN de reembolso')

    await requestCancellation(token)
    const request = await getRequestRow(folioId)
    await approveRequest(ADMIN_EMAIL, request!.id)
    const pin = (await getFolioRow(folioId))!.refund_pin!

    const page = await portalGet(token)
    expect(page.html).toContain('PIN de reembolso')
    expect(page.html).toContain(pin)

    // No email ever carries the PIN (D6) — not the confirmation, not the cancellation.
    for (const call of resendCalls) {
      expect(call.html).not.toContain(pin)
    }
  })

  it('S12 — confirming with the correct PIN closes the loop; the portal flips to refunded', async () => {
    const { folioId, token, adminId, pin } = await approvedRefundSetup()

    const res = await confirmRefund(ADMIN_EMAIL, folioId, { pin })
    expect(res.status).toBe(200)
    expect(res.json.folio.refund_status).toBe('refunded')
    expect(res.json.folio.refunded_by).toBe(adminId)
    expect(typeof res.json.folio.refunded_at).toBe('number')

    const page = await portalGet(token)
    expect(page.html).toContain('Reembolso confirmado')
    expect(page.html).not.toContain('PIN de reembolso')
  })

  it('S13 — a wrong PIN is 422 and counts; five failures lock the PIN path (409), override remains', async () => {
    const { folioId, pin } = await approvedRefundSetup()

    for (let i = 1; i <= 5; i++) {
      const bad = await confirmRefund(ADMIN_EMAIL, folioId, { pin: '000111' })
      expect(bad.status).toBe(422)
      expect(errCode(bad.json)).toBe('VALIDATION_ERROR')
      expect((await getFolioRow(folioId))?.refund_pin_attempts).toBe(i)
    }

    // Locked: even the CORRECT pin is refused now — only the override path remains.
    const locked = await confirmRefund(ADMIN_EMAIL, folioId, { pin })
    expect(locked.status).toBe(409)
    expect(errCode(locked.json)).toBe('CONFLICT')

    const override = await confirmRefund(ADMIN_EMAIL, folioId, {
      override_note: 'Cliente perdió el enlace; reembolso entregado en persona',
    })
    expect(override.status).toBe(200)
    expect(override.json.folio.refund_status).toBe('refunded')
  })

  it('S14 — the override path records the refund with an audit note; an empty body is 400', async () => {
    const { folioId } = await approvedRefundSetup()

    const empty = await confirmRefund(ADMIN_EMAIL, folioId, {})
    expect(empty.status).toBe(400)
    expect(errCode(empty.json)).toBe('VALIDATION_ERROR')

    const both = await confirmRefund(ADMIN_EMAIL, folioId, { pin: '123456', override_note: 'x' })
    expect(both.status).toBe(400)

    const res = await confirmRefund(ADMIN_EMAIL, folioId, { override_note: 'Enlace perdido' })
    expect(res.status).toBe(200)
    expect((await getFolioRow(folioId))?.refund_note).toBe('Enlace perdido')
  })

  it('S15 — confirming when no refund is pending → 409', async () => {
    const { organizationId } = await seedOrgWithStaff()
    const { folioId } = await sellFolio(organizationId)

    // Not cancelled at all → nothing pending.
    expect((await confirmRefund(ADMIN_EMAIL, folioId, { pin: '123456' })).status).toBe(409)
  })

  it('S16 — injected server-owned fields are stripped/ignored', async () => {
    const { folioId, pin } = await approvedRefundSetup()

    // Injected refund_status/refunded_by must not leak into the update.
    const bad = await confirmRefund(ADMIN_EMAIL, folioId, {
      pin: '999999',
      refund_status: 'refunded',
      refunded_by: 'someone-else',
      organization_id: 'org-x',
    })
    expect(bad.status).toBe(422)
    expect((await getFolioRow(folioId))?.refund_status).toBe('pending')

    const ok = await confirmRefund(ADMIN_EMAIL, folioId, { pin, status: 'paid' })
    expect(ok.status).toBe(200)
  })

  // ---------------------------------------------------------------------------
  // Roles & multitenancy
  // ---------------------------------------------------------------------------
  it('S17 — the admin surface is admin-only; the portal needs no auth at all', async () => {
    const { organizationId } = await seedOrgWithStaff()
    const { folioId, token } = await sellFolio(organizationId)
    await requestCancellation(token)
    const request = await getRequestRow(folioId)

    expect((await listRequests(AGENT_EMAIL)).status).toBe(403)
    expect((await approveRequest(AGENT_EMAIL, request!.id)).status).toBe(403)
    expect((await rejectRequest(AGENT_EMAIL, request!.id, { note: 'x' })).status).toBe(403)
    expect((await confirmRefund(AGENT_EMAIL, folioId, { pin: '123456' })).status).toBe(403)

    // Portal GET/POST already exercised with zero auth headers throughout this suite.
    expect((await portalGet(token)).status).toBe(200)
  })

  it('S18 — seedTwoOrgs isolation: tokens, queues, approvals and refunds never cross orgs', async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    await seedUser({ email: AGENT_EMAIL, role: 'agent', organizationId: orgA.organizationId })

    const { folioId, token } = await sellFolio(orgA.organizationId)
    await requestCancellation(token)
    const request = await getRequestRow(folioId)

    // Org-B sees nothing and can touch nothing.
    const queueB = await listRequests(orgB.adminEmail)
    expect(queueB.json.requests).toHaveLength(0)
    expect((await approveRequest(orgB.adminEmail, request!.id)).status).toBe(404)
    expect((await rejectRequest(orgB.adminEmail, request!.id, { note: 'x' })).status).toBe(404)

    // Org-A approves; Org-B still cannot confirm the refund.
    await approveRequest(orgA.adminEmail, request!.id)
    const pin = (await getFolioRow(folioId))!.refund_pin!
    expect((await confirmRefund(orgB.adminEmail, folioId, { pin })).status).toBe(404)

    // Org-A's queue does show it (history filter).
    const queueA = await listRequests(orgA.adminEmail, 'status=approved')
    expect(queueA.json.requests.map((r: any) => r.id)).toContain(request!.id)

    // The request row stayed approved and untouched by org B's attempts.
    expect((await getRequestRow(folioId))?.status).toBe('approved')
  })
})
