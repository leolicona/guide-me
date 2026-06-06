import type { Context } from 'hono'
import type { BatchItem } from 'drizzle-orm/batch'
import { and, asc, desc, eq, gte, lte, sql } from 'drizzle-orm'
import { getDb, type Db } from '../../db/client'
import {
  folioLineExtras,
  folioLines,
  folios,
  organizations,
  serviceExtras,
  services,
  slots,
  users,
} from '../../db/schema'
import {
  sendTicketConfirmationEmail,
  type TicketConfirmationEmailInput,
} from '../../services/resend'
import { ApiError } from '../../types/errors'
import type { AppVariables } from '../../types/context'
import {
  deriveOrgKey,
  signTicket,
  verifyTicket,
  type TicketPayload,
} from '../../utils/qr'
import type { ConfirmSaleInput } from './schema'

export type PosContext = Context<{
  Bindings: CloudflareBindings
  Variables: AppVariables
}>

// Org-local "today" as YYYY-MM-DD. MVP single-timezone assumption (mirrors schedules):
// dates are naive calendar strings compared lexicographically. A `today` query param
// lets the client pin the org-local day; otherwise fall back to the server's UTC date.
const utcToday = () => new Date().toISOString().slice(0, 10)

// --- Signed QR access tickets (docs/qr/folio-qr-signing.spec.md) ---

// MVP single-timezone (mirrors schedules/POS naive calendar): a ticket is valid through
// the end of the day AFTER the slot date — a deliberate grace for late/next-morning scans.
const ticketExpiry = (slotDate: string): number =>
  Math.floor(Date.parse(`${slotDate}T00:00:00Z`) / 1000) + 48 * 3600

// Display/audit identity baked into the ticket: customer name, else email, else folio id.
const clientIdentity = (input: ConfirmSaleInput, folioId: string): string =>
  input.customer_name?.trim() || input.customer_email?.trim() || `folio:${folioId}`

// The signature-free subset of a ticket payload echoed on folio responses for the UI
// (so the client need not base64-decode the token to render labels).
const qrEcho = (p: TicketPayload) => ({
  folio_id: p.folio_id,
  folio_line_id: p.folio_line_id,
  service_id: p.service_id,
  slot_id: p.slot_id,
  client_identity: p.client_identity,
  passes_total: p.passes_total,
  expires_at: p.expires_at,
})

// --- Serializers: DB columns → API shape (snake_case, derived `remaining`) ---

const serializeSlot = (row: {
  id: string
  date: string
  startTime: string
  capacity: number
  booked: number
}) => ({
  id: row.id,
  date: row.date,
  start_time: row.startTime,
  capacity: row.capacity,
  booked: row.booked,
  remaining: row.capacity - row.booked,
})

const serializeExtra = (row: { id: string; name: string; price: number }) => ({
  id: row.id,
  name: row.name,
  price: row.price,
})

const slotReadColumns = {
  id: slots.id,
  date: slots.date,
  startTime: slots.startTime,
  capacity: slots.capacity,
  booked: slots.booked,
} as const

const extraReadColumns = {
  id: serviceExtras.id,
  name: serviceExtras.name,
  price: serviceExtras.price,
} as const

// US-AG03 / US-AG10 — POS catalog: active services with an availability rollup over
// their active, future slots (today or later). `available_spots` = Σ remaining;
// `next_slot_date` = earliest active future slot date (or null).
export const listPosServices = async (c: PosContext) => {
  const agent = c.get('user')
  const today = c.req.query('today') ?? utcToday()
  const db = getDb(c.env)

  const serviceRows = await db
    .select({
      id: services.id,
      name: services.name,
      description: services.description,
      basePrice: services.basePrice,
      minimumPrice: services.minimumPrice,
    })
    .from(services)
    .where(
      and(
        eq(services.organizationId, agent.organizationId),
        eq(services.status, 'active'),
      ),
    )
    .orderBy(asc(services.name))

  const availabilityRows = await db
    .select({
      serviceId: slots.serviceId,
      availableSpots: sql<number>`sum(${slots.capacity} - ${slots.booked})`,
      nextSlotDate: sql<string>`min(${slots.date})`,
    })
    .from(slots)
    .where(
      and(
        eq(slots.organizationId, agent.organizationId),
        eq(slots.status, 'active'),
        gte(slots.date, today),
      ),
    )
    .groupBy(slots.serviceId)

  const availability = new Map(
    availabilityRows.map((r) => [r.serviceId, r]),
  )

  const result = serviceRows.map((s) => {
    const a = availability.get(s.id)
    return {
      id: s.id,
      name: s.name,
      description: s.description,
      base_price: s.basePrice,
      minimum_price: s.minimumPrice,
      available_spots: a ? Number(a.availableSpots) : 0,
      next_slot_date: a ? a.nextSlotDate : null,
    }
  })

  return c.json({ services: result })
}

// US-AG03 / AG04 / AG05 — POS service detail: one active service in the caller's org
// with its active extras and its active, future slots (each with derived `remaining`).
// Unknown / inactive / foreign service → 404.
export const getPosService = async (c: PosContext) => {
  const agent = c.get('user')
  const id = c.req.param('id')
  const db = getDb(c.env)

  const serviceRows = await db
    .select({
      id: services.id,
      name: services.name,
      description: services.description,
      basePrice: services.basePrice,
      minimumPrice: services.minimumPrice,
    })
    .from(services)
    .where(
      and(
        eq(services.id, id),
        eq(services.organizationId, agent.organizationId),
        eq(services.status, 'active'),
      ),
    )
    .limit(1)

  const service = serviceRows[0]
  if (!service) {
    throw new ApiError('NOT_FOUND', 404, 'Service not found')
  }

  const extras = await db
    .select(extraReadColumns)
    .from(serviceExtras)
    .where(
      and(
        eq(serviceExtras.serviceId, id),
        eq(serviceExtras.organizationId, agent.organizationId),
        eq(serviceExtras.status, 'active'),
      ),
    )
    .orderBy(asc(serviceExtras.name))

  const from = c.req.query('from') ?? utcToday()
  const to = c.req.query('to')

  const slotFilters = [
    eq(slots.serviceId, id),
    eq(slots.organizationId, agent.organizationId),
    eq(slots.status, 'active'),
    gte(slots.date, from),
  ]
  if (to) slotFilters.push(lte(slots.date, to))

  const slotRows = await db
    .select(slotReadColumns)
    .from(slots)
    .where(and(...slotFilters))
    .orderBy(asc(slots.date), asc(slots.startTime))

  return c.json({
    service: {
      id: service.id,
      name: service.name,
      description: service.description,
      base_price: service.basePrice,
      minimum_price: service.minimumPrice,
      extras: extras.map(serializeExtra),
      slots: slotRows.map(serializeSlot),
    },
  })
}

// A fully-priced cart line, ready to persist, built from DB snapshots in confirmSale.
interface PreparedExtra {
  id: string
  extraId: string
  name: string
  price: number
  quantity: number
}

interface PreparedLine {
  id: string
  slotId: string
  serviceId: string
  serviceName: string
  slotDate: string
  slotStartTime: string
  quantity: number
  basePrice: number
  minimumPrice: number
  unitPrice: number
  lineTotal: number
  commissionBonus: number // per-pass service bonus snapshot (US-A12)
  extras: PreparedExtra[]
  // Signed at confirm time, once all decrements succeed (below).
  qrToken?: string
  qr?: ReturnType<typeof qrEcho>
}

// US-AG04 / AG05 / AG06 / AG08 / AG11 — confirm a sale.
//
// D1 has no interactive transactions and a 0-row conditional UPDATE is not an error,
// so the flow is validate → conditional-decrement → compensate-on-failure → persist:
//   1. Validate every line against DB snapshots (ownership, active, discount floor).
//   2. Conditionally decrement each distinct slot, tracking successes.
//   3. If any decrement matches 0 rows (sold out / race) → re-increment the ones already
//      applied and throw 409 SLOT_UNAVAILABLE. No folio rows exist yet.
//   4. Persist folio + lines + extras in a single atomic batch.
export const confirmSale = async (c: PosContext) => {
  const agent = c.get('user')
  const input = (await c.req.json()) as ConfirmSaleInput
  const db = getDb(c.env)
  const org = agent.organizationId

  // 1. VALIDATE (reads only) — snapshot prices/names from active, in-org inventory.
  const prepared: PreparedLine[] = []
  for (const line of input.lines) {
    const slotRows = await db
      .select({
        slotId: slots.id,
        date: slots.date,
        startTime: slots.startTime,
        serviceId: slots.serviceId,
        serviceName: services.name,
        basePrice: services.basePrice,
        minimumPrice: services.minimumPrice,
        commissionBonus: services.commissionBonus,
      })
      .from(slots)
      .innerJoin(services, eq(slots.serviceId, services.id))
      .where(
        and(
          eq(slots.id, line.slot_id),
          eq(slots.organizationId, org),
          eq(slots.status, 'active'),
          eq(services.status, 'active'),
        ),
      )
      .limit(1)

    const slot = slotRows[0]
    if (!slot) {
      throw new ApiError('NOT_FOUND', 404, 'Slot not found or unavailable')
    }

    // Controlled discount (US-AG06): floor at the admin's minimum_price.
    if (line.unit_price < slot.minimumPrice) {
      throw new ApiError(
        'PRICE_BELOW_MINIMUM',
        400,
        'Unit price is below the minimum price for this service',
      )
    }
    if (line.unit_price > slot.basePrice) {
      throw new ApiError(
        'VALIDATION_ERROR',
        400,
        'Unit price may not exceed the base price',
      )
    }

    const preparedExtras: PreparedExtra[] = []
    let extrasTotal = 0
    // `extras` is optional in the payload; the schema default isn't applied to the
    // raw body read here, so default to [] at the use site.
    for (const ex of line.extras ?? []) {
      const extraRows = await db
        .select(extraReadColumns)
        .from(serviceExtras)
        .where(
          and(
            eq(serviceExtras.id, ex.extra_id),
            eq(serviceExtras.organizationId, org),
            eq(serviceExtras.serviceId, slot.serviceId),
            eq(serviceExtras.status, 'active'),
          ),
        )
        .limit(1)

      const extra = extraRows[0]
      if (!extra) {
        throw new ApiError('NOT_FOUND', 404, 'Extra not found for this service')
      }

      preparedExtras.push({
        id: crypto.randomUUID(),
        extraId: extra.id,
        name: extra.name,
        price: extra.price, // snapshot — no discount ever applies to an extra
        quantity: ex.quantity,
      })
      extrasTotal += extra.price * ex.quantity
    }

    const lineTotal = line.unit_price * line.quantity + extrasTotal
    prepared.push({
      id: crypto.randomUUID(),
      slotId: slot.slotId,
      serviceId: slot.serviceId,
      serviceName: slot.serviceName,
      slotDate: slot.date,
      slotStartTime: slot.startTime,
      quantity: line.quantity,
      basePrice: slot.basePrice,
      minimumPrice: slot.minimumPrice,
      unitPrice: line.unit_price,
      lineTotal,
      commissionBonus: slot.commissionBonus,
      extras: preparedExtras,
    })
  }

  const subtotal = prepared.reduce((sum, l) => sum + l.lineTotal, 0)
  const discountTotal = prepared.reduce(
    (sum, l) => sum + (l.basePrice - l.unitPrice) * l.quantity,
    0,
  )
  const total = subtotal

  // COMMISSION (US-AG23 / US-A12): the agent's base % of the folio total plus each line's
  // per-pass service bonus, snapshotted now so later rate changes don't rewrite history.
  // base_commission is a whole-number percentage; round half-up to the nearest centavo.
  const [agentRow] = await db
    .select({ baseCommission: users.baseCommission })
    .from(users)
    .where(and(eq(users.id, agent.userId), eq(users.organizationId, org)))
    .limit(1)
  const basePct = agentRow?.baseCommission ?? 0
  const baseCommission = Math.round((total * basePct) / 100)
  const bonusTotal = prepared.reduce(
    (sum, l) => sum + l.commissionBonus * l.quantity,
    0,
  )
  const commissionAmount = baseCommission + bonusTotal

  // 2. DECREMENT each slot atomically & conditionally; track successes.
  const applied: { slotId: string; qty: number }[] = []
  for (const line of prepared) {
    const decremented = await db
      .update(slots)
      .set({
        booked: sql`${slots.booked} + ${line.quantity}`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(slots.id, line.slotId),
          eq(slots.organizationId, org),
          eq(slots.status, 'active'),
          gte(sql`${slots.capacity} - ${slots.booked}`, line.quantity),
        ),
      )
      .returning({ id: slots.id })

    if (decremented.length === 0) {
      // 3. COMPENSATE every decrement already applied, then fail. No folio yet.
      for (const a of applied) {
        await db
          .update(slots)
          .set({
            booked: sql`${slots.booked} - ${a.qty}`,
            updatedAt: new Date(),
          })
          .where(and(eq(slots.id, a.slotId), eq(slots.organizationId, org)))
      }
      throw new ApiError(
        'SLOT_UNAVAILABLE',
        409,
        'A selected time just sold out — please review your cart',
      )
    }
    applied.push({ slotId: line.slotId, qty: line.quantity })
  }

  // 4. SIGN one QR access ticket per line, from server-owned payload only (org from
  //    context, passes_total = quantity, identity derived). Per-org derived key; HMAC is
  //    deterministic so the stored token is stable across later reads.
  const folioId = crypto.randomUUID()
  const orgKey = await deriveOrgKey(c.env.QR_SECRET, org)
  const identity = clientIdentity(input, folioId)
  for (const line of prepared) {
    const payload: TicketPayload = {
      v: 1,
      folio_id: folioId,
      folio_line_id: line.id,
      organization_id: org,
      service_id: line.serviceId,
      slot_id: line.slotId,
      client_identity: identity,
      passes_total: line.quantity,
      issued_at: Math.floor(Date.now() / 1000),
      expires_at: ticketExpiry(line.slotDate),
    }
    line.qrToken = await signTicket(payload, orgKey)
    line.qr = qrEcho(payload)
  }

  // 5. PERSIST — folio + lines + extras in one atomic batch (D1 batch rolls back on error).
  const statements: BatchItem<'sqlite'>[] = [
    db.insert(folios).values({
      id: folioId,
      organizationId: org,
      agentId: agent.userId,
      customerName: input.customer_name ?? null,
      customerEmail: input.customer_email ?? null,
      customerPhone: input.customer_phone ?? null,
      status: 'paid',
      paymentMethod: input.payment_method ?? 'cash',
      subtotal,
      discountTotal,
      total,
      amountPaid: total,
      commissionAmount,
    }),
  ]

  for (const line of prepared) {
    statements.push(
      db.insert(folioLines).values({
        id: line.id,
        organizationId: org,
        folioId,
        serviceId: line.serviceId,
        slotId: line.slotId,
        serviceName: line.serviceName,
        slotDate: line.slotDate,
        slotStartTime: line.slotStartTime,
        quantity: line.quantity,
        basePrice: line.basePrice,
        minimumPrice: line.minimumPrice,
        unitPrice: line.unitPrice,
        lineTotal: line.lineTotal,
        qrToken: line.qrToken,
      }),
    )
    for (const ex of line.extras) {
      statements.push(
        db.insert(folioLineExtras).values({
          id: ex.id,
          organizationId: org,
          folioId,
          folioLineId: line.id,
          extraId: ex.extraId,
          name: ex.name,
          price: ex.price,
          quantity: ex.quantity,
        }),
      )
    }
  }

  await db.batch(statements as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]])

  // Fire-and-forget — a Resend failure must never roll back a committed sale.
  if (input.customer_email && c.env.RESEND_API_KEY) {
    const orgRows = await db
      .select({ name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, org))
      .limit(1)
    const orgName = orgRows[0]?.name ?? 'GuideMe'

    const emailData: TicketConfirmationEmailInput = {
      to: input.customer_email,
      customerName: input.customer_name ?? null,
      orgName,
      folioId,
      createdAt: new Date(),
      paymentMethod: input.payment_method ?? 'cash',
      total,
      lines: prepared.map((line) => ({
        serviceName: line.serviceName,
        slotDate: line.slotDate,
        slotStartTime: line.slotStartTime,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        lineTotal: line.lineTotal,
        qrToken: line.qrToken!,
        extras: line.extras.map((ex) => ({
          name: ex.name,
          price: ex.price,
          quantity: ex.quantity,
        })),
      })),
    }

    // waitUntil — guarantees the send completes after the 201 returns. A bare floating
    // promise can be cancelled when the Worker returns, silently dropping the email.
    c.executionCtx.waitUntil(
      sendTicketConfirmationEmail(c.env, emailData).catch((err) =>
        console.error('[email] confirmation send failed', folioId, err),
      ),
    )
  }

  return c.json(
    {
      folio: {
        id: folioId,
        status: 'paid',
        payment_method: input.payment_method ?? 'cash',
        customer_name: input.customer_name ?? null,
        customer_email: input.customer_email ?? null,
        customer_phone: input.customer_phone ?? null,
        subtotal,
        discount_total: discountTotal,
        total,
        amount_paid: total,
        commission_amount: commissionAmount,
        lines: prepared.map((line) => ({
          id: line.id,
          service_id: line.serviceId,
          slot_id: line.slotId,
          service_name: line.serviceName,
          slot_date: line.slotDate,
          slot_start_time: line.slotStartTime,
          quantity: line.quantity,
          base_price: line.basePrice,
          minimum_price: line.minimumPrice,
          unit_price: line.unitPrice,
          line_total: line.lineTotal,
          qr_token: line.qrToken ?? null,
          qr: line.qr ?? null,
          extras: line.extras.map((ex) => ({
            id: ex.id,
            extra_id: ex.extraId,
            name: ex.name,
            price: ex.price,
            quantity: ex.quantity,
          })),
        })),
      },
    },
    201,
  )
}

// Re-read a folio (with lines + extras) scoped to the caller agent, for the response
// shape. Shared by getFolio; returns null when no such folio belongs to the agent.
const readFolio = async (
  db: Db,
  org: string,
  agentId: string,
  folioId: string,
  qrSecret: string,
) => {
  const folioRows = await db
    .select({
      id: folios.id,
      status: folios.status,
      paymentMethod: folios.paymentMethod,
      customerName: folios.customerName,
      customerEmail: folios.customerEmail,
      customerPhone: folios.customerPhone,
      subtotal: folios.subtotal,
      discountTotal: folios.discountTotal,
      total: folios.total,
      amountPaid: folios.amountPaid,
      commissionAmount: folios.commissionAmount,
      cancelledAt: folios.cancelledAt,
      createdAt: folios.createdAt,
    })
    .from(folios)
    .where(
      and(
        eq(folios.id, folioId),
        eq(folios.organizationId, org),
        eq(folios.agentId, agentId),
      ),
    )
    .limit(1)

  const folio = folioRows[0]
  if (!folio) return null

  const lineRows = await db
    .select({
      id: folioLines.id,
      serviceId: folioLines.serviceId,
      slotId: folioLines.slotId,
      serviceName: folioLines.serviceName,
      slotDate: folioLines.slotDate,
      slotStartTime: folioLines.slotStartTime,
      quantity: folioLines.quantity,
      basePrice: folioLines.basePrice,
      minimumPrice: folioLines.minimumPrice,
      unitPrice: folioLines.unitPrice,
      lineTotal: folioLines.lineTotal,
      qrToken: folioLines.qrToken,
    })
    .from(folioLines)
    .where(and(eq(folioLines.folioId, folioId), eq(folioLines.organizationId, org)))
    .orderBy(asc(folioLines.createdAt))

  const extraRows = await db
    .select({
      id: folioLineExtras.id,
      folioLineId: folioLineExtras.folioLineId,
      extraId: folioLineExtras.extraId,
      name: folioLineExtras.name,
      price: folioLineExtras.price,
      quantity: folioLineExtras.quantity,
    })
    .from(folioLineExtras)
    .where(
      and(
        eq(folioLineExtras.folioId, folioId),
        eq(folioLineExtras.organizationId, org),
      ),
    )

  const extrasByLine = new Map<string, typeof extraRows>()
  for (const ex of extraRows) {
    const list = extrasByLine.get(ex.folioLineId) ?? []
    list.push(ex)
    extrasByLine.set(ex.folioLineId, list)
  }

  // Decode (and integrity-check) each stored ticket for the UI echo. Tokenless lines
  // (folios sold before the QR feature) and any corrupt token resolve to qr: null.
  const orgKey = await deriveOrgKey(qrSecret, org)
  const lines = await Promise.all(
    lineRows.map(async (line) => {
      const payload = line.qrToken
        ? await verifyTicket(line.qrToken, orgKey)
        : null
      return {
        id: line.id,
        service_id: line.serviceId,
        slot_id: line.slotId,
        service_name: line.serviceName,
        slot_date: line.slotDate,
        slot_start_time: line.slotStartTime,
        quantity: line.quantity,
        base_price: line.basePrice,
        minimum_price: line.minimumPrice,
        unit_price: line.unitPrice,
        line_total: line.lineTotal,
        qr_token: line.qrToken ?? null,
        qr: payload ? qrEcho(payload) : null,
        extras: (extrasByLine.get(line.id) ?? []).map((ex) => ({
          id: ex.id,
          extra_id: ex.extraId,
          name: ex.name,
          price: ex.price,
          quantity: ex.quantity,
        })),
      }
    }),
  )

  return {
    id: folio.id,
    status: folio.status,
    payment_method: folio.paymentMethod,
    customer_name: folio.customerName,
    customer_email: folio.customerEmail,
    customer_phone: folio.customerPhone,
    subtotal: folio.subtotal,
    discount_total: folio.discountTotal,
    total: folio.total,
    amount_paid: folio.amountPaid,
    commission_amount: folio.commissionAmount,
    cancelled_at: folio.cancelledAt
      ? Math.floor(folio.cancelledAt.getTime() / 1000)
      : null,
    created_at: Math.floor(folio.createdAt.getTime() / 1000),
    lines,
  }
}

// US-AG08 — read back one of the caller agent's own folios (receipt). Foreign /
// other-agent / unknown → 404.
export const getFolio = async (c: PosContext) => {
  const agent = c.get('user')
  const id = c.req.param('id')
  const db = getDb(c.env)

  const folio = await readFolio(
    db,
    agent.organizationId,
    agent.userId,
    id,
    c.env.QR_SECRET,
  )
  if (!folio) {
    throw new ApiError('NOT_FOUND', 404, 'Folio not found')
  }

  return c.json({ folio })
}

// US-AG20 — the caller agent's own folios (their read-only sales history). Caller-scoped:
// organization_id AND agent_id come from context — there is NO agent_id query param, so an
// agent can never see another agent's folios (that is the admin org-wide list at
// GET /api/folios). Optional status / date (created_at UTC day) filters; newest first. A
// lean row — a history list, not a metrics dashboard.
export const listAgentFolios = async (c: PosContext) => {
  const agent = c.get('user')
  const org = agent.organizationId
  const db = getDb(c.env)

  const statusQ = c.req.query('status')
  const dateQ = c.req.query('date')

  const filters = [
    eq(folios.organizationId, org),
    eq(folios.agentId, agent.userId), // caller-scoped — never from the request
  ]
  if (statusQ === 'paid' || statusQ === 'booking' || statusQ === 'cancelled') {
    filters.push(eq(folios.status, statusQ))
  }
  if (dateQ) {
    filters.push(
      sql`strftime('%Y-%m-%d', ${folios.createdAt}, 'unixepoch') = ${dateQ}`,
    )
  }

  const rows = await db
    .select({
      id: folios.id,
      customerName: folios.customerName,
      status: folios.status,
      total: folios.total,
      amountPaid: folios.amountPaid,
      createdAt: folios.createdAt,
      cancelledAt: folios.cancelledAt,
    })
    .from(folios)
    .where(and(...filters))
    .orderBy(desc(folios.createdAt))

  return c.json({
    folios: rows.map((r) => ({
      id: r.id,
      customer_name: r.customerName,
      status: r.status,
      total: r.total,
      amount_paid: r.amountPaid,
      created_at: Math.floor(r.createdAt.getTime() / 1000),
      cancelled_at: r.cancelledAt
        ? Math.floor(r.cancelledAt.getTime() / 1000)
        : null,
    })),
  })
}
