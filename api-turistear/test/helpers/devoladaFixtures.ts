// devolada-transfer-verification D18 — fixtures shared by the Devolada suites: an organization with
// a seller, a sellable slot, a connection to a fake Devolada business, and the requests the suites
// make. Requests authenticate the way production does (`sessionCookie`, test/helpers/session.ts).
import { env, SELF } from 'cloudflare:test'
import { seedUser } from './tenancy'
import { sessionCookie } from './session'
import type { FakeDevolada, FakeMode } from './devolada'

export const API = 'http://api.local/api'
export const PHONE = '+52 55 1234 5678'

export const auth = (email: string) => ({ Cookie: sessionCookie(email) })
export const jsonAuth = (email: string) => ({ ...auth(email), 'Content-Type': 'application/json' })

export const call = async (
  email: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
) => {
  const res = await SELF.fetch(`${API}${path}`, {
    method,
    headers: jsonAuth(email),
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json: any = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = text
  }
  return { status: res.status, json, text }
}

const todayStr = (): string => new Date().toISOString().slice(0, 10)
export const addDays = (d: string, n: number): string =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)

/** Wipes every table the Devolada suites write, children first. */
export const clearDevoladaDb = async () => {
  for (const table of [
    'devolada_events',
    'devolada_payments',
    'devolada_links',
    'devolada_connections',
    'devolada_credentials',
    'folio_line_extras',
    'folio_payment_allocations',
    'folio_access_tokens',
    'accommodation_reservations',
    'folio_requests',
    'notifications',
    'folio_events',
    'folio_payments',
    'folio_lines',
    'folios',
    'slot_zones',
    'slots',
    'service_zones',
    'service_extras',
    'schedules',
    'services',
    'invitations',
    'users',
    'organizations',
  ]) {
    await env.DB.exec(`DELETE FROM ${table}`)
  }
}

export const seedService = async (organizationId: string, price = 150000): Promise<string> => {
  const id = crypto.randomUUID()
  const ts = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO services (id, organization_id, name, description, base_price, minimum_price, default_capacity, commission_type, commission_value, status, created_at, updated_at)
     VALUES (?, ?, 'Tour a la isla', NULL, ?, ?, 12, 'percent', 1000, 'active', ?, ?)`,
  )
    .bind(id, organizationId, price, Math.floor(price / 2), ts, ts)
    .run()
  return id
}

/** A slot `daysAhead` days from the frozen today, at `startTime` (UTC = the org's zone in tests). */
export const seedSlot = async (
  organizationId: string,
  serviceId: string,
  opts: { daysAhead?: number; date?: string; startTime?: string } = {},
): Promise<string> => {
  const id = crypto.randomUUID()
  const ts = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO slots (id, organization_id, service_id, schedule_id, date, start_time, capacity, booked, status, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, ?, 12, 0, 'active', ?, ?)`,
  )
    .bind(
      id,
      organizationId,
      serviceId,
      opts.date ?? addDays(todayStr(), opts.daysAhead ?? 3),
      opts.startTime ?? '06:00',
      ts,
      ts,
    )
    .run()
  return id
}

export interface SeededSellers {
  organizationId: string
  adminEmail: string
  adminId: string
  agentEmail: string
  agentId: string
  serviceId: string
  slotId: string
}

let orgCounter = 0
/** An organization with an admin, a seller (agent), one service and a slot three days out. */
export const seedSellers = async (prefix = 'org'): Promise<SeededSellers> => {
  orgCounter += 1
  const adminEmail = `${prefix}-admin-${orgCounter}@empresa.com`
  const agentEmail = `${prefix}-agent-${orgCounter}@empresa.com`
  const admin = await seedUser({ email: adminEmail, role: 'admin', name: 'Ana Ruiz', organizationName: `Empresa ${prefix}` })
  const agent = await seedUser({
    email: agentEmail,
    role: 'agent',
    name: 'Beto Vende',
    organizationId: admin.organizationId,
  })
  const serviceId = await seedService(admin.organizationId)
  const slotId = await seedSlot(admin.organizationId, serviceId)
  return {
    organizationId: admin.organizationId,
    adminEmail,
    adminId: admin.userId,
    agentEmail,
    agentId: agent.userId,
    serviceId,
    slotId,
  }
}

/** Connects the organization to a new fake business; answers the business and its key. */
export const connectToFake = async (
  fake: FakeDevolada,
  adminEmail: string,
  opts: { mode?: FakeMode; replaceWebhook?: boolean } = {},
) => {
  const business = fake.addBusiness({ mode: opts.mode ?? 'test' })
  const res = await call(adminEmail, 'PUT', '/organizations/me/devolada', {
    api_key: business.apiKey,
    ...(opts.replaceWebhook ? { replace_webhook: true } : {}),
  })
  if (res.status !== 200) throw new Error(`connect → ${res.status} ${res.text}`)
  return business
}

/** A full sale of one seat by transfer, from the seller. */
export const sellByTransfer = async (
  agentEmail: string,
  slotId: string,
  extra: Record<string, unknown> = {},
) =>
  call(agentEmail, 'POST', '/pos/folios', {
    customer_name: 'Cliente Test',
    customer_phone: PHONE,
    payment_method: 'transfer',
    lines: [{ slot_id: slotId, quantity: 1, unit_price: 150000 }],
    ...extra,
  })

export const linkRows = async (folioId: string) =>
  (
    await env.DB.prepare(`SELECT * FROM devolada_links WHERE folio_id = ? ORDER BY created_at, rowid`)
      .bind(folioId)
      .all<any>()
  ).results

export const paymentRowsOf = async (folioId: string) =>
  (
    await env.DB.prepare(
      `SELECT * FROM folio_payments WHERE folio_id = ? AND entry_type = 'payment' ORDER BY created_at, rowid`,
    )
      .bind(folioId)
      .all<any>()
  ).results

export const folioRow = async (folioId: string) =>
  env.DB.prepare(`SELECT * FROM folios WHERE id = ?`).bind(folioId).first<any>()

export const connectionRow = async (organizationId: string) =>
  env.DB.prepare(`SELECT * FROM devolada_connections WHERE organization_id = ?`)
    .bind(organizationId)
    .first<any>()

export const credentialRows = async (organizationId: string) =>
  (
    await env.DB.prepare(
      `SELECT * FROM devolada_credentials WHERE organization_id = ? ORDER BY created_at, rowid`,
    )
      .bind(organizationId)
      .all<any>()
  ).results

/** A sale's detail as its seller reads it. */
export const posFolio = async (email: string, folioId: string) => {
  const res = await call(email, 'GET', `/pos/folios/${folioId}`)
  return res.json?.folio
}

/** A sale's detail as an admin reads it. */
export const adminFolio = async (email: string, folioId: string) => {
  const res = await call(email, 'GET', `/folios/${folioId}`)
  return res.json?.folio
}

export const counts = async (adminEmail: string) => (await call(adminEmail, 'GET', '/folios/counts')).json

/** Inserts a link row directly, for the states no request reaches in this PR. */
export const insertLink = async (input: {
  organizationId: string
  folioId: string
  credentialId: string
  requestedBy: string
  state: string
  kind?: 'sale' | 'deposit' | 'settlement'
  folioPaymentId?: string | null
  folioLineId?: string | null
  devoladaLinkId?: string | null
  mode?: 'test' | 'real'
  amount?: number
  expiresAt?: number
  lastCheckedAt?: number | null
  createdAt?: number
  url?: string | null
}) => {
  const id = crypto.randomUUID()
  const now = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO devolada_links (id, organization_id, folio_id, folio_line_id, folio_payment_id, kind, credential_id, mode, amount, devolada_link_id, url, expires_at, state, requested_by, last_checked_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      input.organizationId,
      input.folioId,
      input.folioLineId ?? null,
      input.folioPaymentId ?? null,
      input.kind ?? 'sale',
      input.credentialId,
      input.mode ?? 'test',
      input.amount ?? 150000,
      input.devoladaLinkId ?? null,
      input.url ?? null,
      input.expiresAt ?? now + 3600,
      input.state,
      input.requestedBy,
      input.lastCheckedAt ?? null,
      input.createdAt ?? now,
      input.createdAt ?? now,
    )
    .run()
  return id
}

/** Inserts a Devolada payment snapshot directly. */
export const insertPayment = async (input: {
  organizationId: string
  linkId: string
  folioId: string
  status: string
  devoladaPaymentId?: string
  askedAmount?: number
  createdAt?: number
  resolution?: string | null
}) => {
  const id = crypto.randomUUID()
  const now = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO devolada_payments (id, organization_id, link_id, folio_id, devolada_payment_id, status, proof_door, asked_amount, devolada_created_at, resolution, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'transfer', ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      input.organizationId,
      input.linkId,
      input.folioId,
      input.devoladaPaymentId ?? `pay_${crypto.randomUUID()}`,
      input.status,
      input.askedAmount ?? 150000,
      input.createdAt ?? now,
      input.resolution ?? null,
      now,
      now,
    )
    .run()
  return id
}

/** A bare sale row, for suites that only need a folio id to hang links on (the sweep's volume). */
export const insertBareFolio = async (organizationId: string, agentId: string) => {
  const id = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO folios (id, organization_id, agent_id, subtotal, total, amount_paid, payment_verification)
     VALUES (?, ?, ?, 150000, 150000, 150000, 'pending')`,
  )
    .bind(id, organizationId, agentId)
    .run()
  return id
}

/** The organization's current credential id. */
export const currentCredentialId = async (organizationId: string) =>
  (await connectionRow(organizationId)).current_credential_id as string
