import type { Context } from 'hono'
import type { BatchItem } from 'drizzle-orm/batch'
import { and, asc, desc, eq, gte, lte, sql } from 'drizzle-orm'
import { getDb, type Db } from '../../db/client'
import {
  folioAccessTokens,
  folioLineExtras,
  folioLines,
  folios,
  organizations,
  serviceExtras,
  services,
  slots,
} from '../../db/schema'
import {
  sendBookingConfirmationEmail,
  sendTicketConfirmationEmail,
  type TicketConfirmationEmailInput,
} from '../../services/resend'
import { ApiError } from '../../types/errors'
import type { AppVariables, UserPayload } from '../../types/context'
import {
  deriveOrgKey,
  signTicket,
  verifyTicket,
  type TicketPayload,
} from '../../utils/qr'
import { generatePortalToken, portalTokenExpiry } from '../../utils/portal'
import type { ConfirmSaleInput } from './schema'

export type PosContext = Context<{
  Bindings: CloudflareBindings
  Variables: AppVariables
}>

// Org-local "today" as YYYY-MM-DD. MVP single-timezone assumption (mirrors schedules):
// dates are naive calendar strings compared lexicographically. A `today` query param
// lets the client pin the org-local day; otherwise fall back to the server's UTC date.
const utcToday = () => new Date().toISOString().slice(0, 10)

// Add `n` whole days to a naive YYYY-MM-DD calendar string (UTC midnight arithmetic —
// no timezone math, matching the single-timezone model). Used for the catalog's rolling
// availability window (US-AG30).
const addDays = (date: string, n: number): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)

// US-AG30 — the default catalog availability window spans `today` + the next 2 days
// (3 calendar days inclusive). When the agent selects an explicit date the window
// collapses to that single day.
const AVAILABILITY_WINDOW_DAYS = 2

// Last calendar day of a `YYYY-MM` month, as a naive YYYY-MM-DD string. `Date.UTC(y, m, 0)`
// — month `m` is 1-based here, so as a 0-based index it is the *next* month, and day 0 rolls
// back to the last day of the requested month (handles 28/29/30/31 incl. leap Feb).
const lastOfMonth = (month: string): string => {
  const [y, m] = month.split('-').map(Number)
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)
}

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

// US-AG03 / US-AG10 / US-AG30 — POS catalog: active services with a LIGHTWEIGHT,
// windowed availability flag (no slot details, no spot count). `has_availability` is
// true when the service has ≥ 1 active slot with effective remaining > 0 inside the
// availability window; `next_slot_date` = earliest active slot date in that window
// (or null). The window is a rolling 3-day span (today … today + 2) by default, or the
// single `date` the agent selected (US-AG30).
export const listPosServices = async (c: PosContext) => {
  const agent = c.get('user')
  const today = c.req.query('today') ?? utcToday()
  // US-AG30 — an explicit selected date collapses the window to that single day; absent,
  // the window is today … today + AVAILABILITY_WINDOW_DAYS (the default "next 3 days").
  const selectedDate = c.req.query('date')
  const windowFrom = selectedDate ?? today
  const windowTo = selectedDate ?? addDays(today, AVAILABILITY_WINDOW_DAYS)
  const db = getDb(c.env)

  const serviceRows = await db
    .select({
      id: services.id,
      name: services.name,
      description: services.description,
      basePrice: services.basePrice,
      minimumPrice: services.minimumPrice,
      isFlexible: services.isFlexible,
      flexCapacityPct: services.flexCapacityPct,
      category: services.category,
    })
    .from(services)
    .where(
      and(
        eq(services.organizationId, agent.organizationId),
        eq(services.status, 'active'),
      ),
    )
    .orderBy(asc(services.name))

  // US-A36 — availability is the Σ EFFECTIVE remaining: each slot's raw remaining plus its
  // flexible margin (floor(capacity × pct / 100)) for a Soft Cap service. pct is constant per
  // service and we group per service, so SQLite's per-row integer division yields each slot's
  // floored margin and the sum is exact — a fully-booked-but-flexible service still advertises
  // its sellable last-minute spots instead of reading "Agotado".
  // US-A47 — exclude slots already past the sales cutoff so `has_availability` / `next_slot_date`
  // never advertise a departed time (e.g. a service whose only "remaining" slot today is over).
  const cutoffRows = await db
    .select({ v: organizations.salesCutoffOffsetMinutes })
    .from(organizations)
    .where(eq(organizations.id, agent.organizationId))
    .limit(1)
  const sellableThreshold = salesThresholdStr(
    Math.floor(Date.now() / 1000),
    cutoffRows[0]?.v ?? 0,
  )

  const availabilityRows = await db
    .select({
      serviceId: slots.serviceId,
      availableSpots: sql<number>`sum(
        (${slots.capacity} - ${slots.booked})
        + (CASE WHEN ${services.isFlexible}
                THEN (${slots.capacity} * ${services.flexCapacityPct}) / 100
                ELSE 0 END)
      )`,
      nextSlotDate: sql<string>`min(${slots.date})`,
    })
    .from(slots)
    .innerJoin(services, eq(slots.serviceId, services.id))
    .where(
      and(
        eq(slots.organizationId, agent.organizationId),
        eq(slots.status, 'active'),
        // US-AG30 — bound to the availability window [windowFrom, windowTo].
        gte(slots.date, windowFrom),
        lte(slots.date, windowTo),
        sellableSlotSql(sellableThreshold),
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
      // US-A36 — capacity-mode flags let the client badge a flexible service and compute the
      // effective margin per slot on the detail screen. available_spots already reflects the
      // effective Σ remaining (see the availability query above).
      is_flexible: s.isFlexible,
      flex_capacity_pct: s.flexCapacityPct,
      // US-A37 — primary category (or null for a pre-migration service); drives the POS
      // filter chips, which the client derives from the present, non-null categories.
      category: s.category,
      // US-AG30 — lightweight boolean (no count): true when any in-window slot is sellable.
      // availableSpots is the Σ EFFECTIVE remaining over the window; since effective
      // remaining is always ≥ 0, sum > 0 ⟺ ≥ 1 slot has a sellable spot.
      has_availability: a ? Number(a.availableSpots) > 0 : false,
      next_slot_date: a ? a.nextSlotDate : null,
    }
  })

  return c.json({ services: result })
}

// US-AG35 — month availability for the POS calendar Bottom Sheet: the set of dates IN THE
// GIVEN MONTH that have ≥ 1 active slot with effective remaining > 0 (US-A36). The caller
// names a `month` (YYYY-MM); the server derives the scan window `[firstOfMonth, lastOfMonth]`
// itself (no caller-controlled width). Past days are never returned — for the current month
// the window floors at `today`; a fully-past month returns []. Org-scoped (multitenancy
// Rule: every read filters by organizationId), so a foreign org's slot can never light up a
// day for this org. Returns only date strings — no slot-level or per-service data.
export const listAvailabilityDays = async (c: PosContext) => {
  const agent = c.get('user')
  const { month, today: todayParam } = c.req.valid('query')
  const today = todayParam ?? utcToday()

  const monthStart = `${month}-01`
  const monthEnd = lastOfMonth(month)
  // Floor the scan at `today` for the current month (no past days surface). For a fully-past
  // month `windowFrom` exceeds `windowEnd`; short-circuit rather than issue a no-row query.
  const windowFrom = today > monthStart ? today : monthStart
  if (windowFrom > monthEnd) {
    return c.json({ days: [] })
  }

  const db = getDb(c.env)

  // US-A47 — drop days whose only slots have passed the sales cutoff (no past times in the picker).
  const cutoffRows = await db
    .select({ v: organizations.salesCutoffOffsetMinutes })
    .from(organizations)
    .where(eq(organizations.id, agent.organizationId))
    .limit(1)
  const sellableThreshold = salesThresholdStr(
    Math.floor(Date.now() / 1000),
    cutoffRows[0]?.v ?? 0,
  )

  const rows = await db
    .select({ date: slots.date })
    .from(slots)
    .innerJoin(services, eq(slots.serviceId, services.id))
    .where(
      and(
        eq(slots.organizationId, agent.organizationId),
        eq(slots.status, 'active'),
        eq(services.status, 'active'),
        gte(slots.date, windowFrom),
        lte(slots.date, monthEnd),
        sellableSlotSql(sellableThreshold),
        // US-A36 — effective remaining > 0 per slot: raw remaining plus the flexible margin
        // (floor(capacity × pct / 100)) for a Soft Cap service. Grouping by date then yields
        // exactly the days with at least one sellable slot.
        sql`((${slots.capacity} - ${slots.booked})
             + (CASE WHEN ${services.isFlexible}
                     THEN (${slots.capacity} * ${services.flexCapacityPct}) / 100
                     ELSE 0 END)) > 0`,
      ),
    )
    .groupBy(slots.date)
    .orderBy(asc(slots.date))

  return c.json({ days: rows.map((r) => r.date) })
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
      isFlexible: services.isFlexible,
      flexCapacityPct: services.flexCapacityPct,
      category: services.category,
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

  // US-A47 — never surface a slot that's no longer sellable (its departure passed the cutoff),
  // so the matrix shows only the times an agent can actually sell today.
  const cutoffRows = await db
    .select({ v: organizations.salesCutoffOffsetMinutes })
    .from(organizations)
    .where(eq(organizations.id, agent.organizationId))
    .limit(1)
  const threshold = salesThresholdStr(
    Math.floor(Date.now() / 1000),
    cutoffRows[0]?.v ?? 0,
  )

  const slotFilters = [
    eq(slots.serviceId, id),
    eq(slots.organizationId, agent.organizationId),
    eq(slots.status, 'active'),
    gte(slots.date, from),
    sellableSlotSql(threshold),
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
      // US-A36 — raw capacity-mode fields. The client computes Effective Capacity per slot
      // (capacity + floor(capacity × pct / 100) for Soft Cap) so it can drive UI states such
      // as highlighting a slot once the agent dips into the flexible margin. The server still
      // enforces this ceiling atomically at confirmSale; these fields are display-only.
      is_flexible: service.isFlexible,
      flex_capacity_pct: service.flexCapacityPct,
      // US-A37 — echoed for a consistent service shape (the detail screen doesn't filter).
      category: service.category,
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
  // Service-based commission snapshot (US-A12 rev.): percent → value is basis points of the
  // line total; fixed → value is minor units per spot (× quantity).
  commissionType: 'percent' | 'fixed'
  commissionValue: number
  // US-A36 — capacity mode, used to build the effective-capacity guard at decrement time.
  isFlexible: boolean
  flexCapacityPct: number
  extras: PreparedExtra[]
  // Signed at confirm time, once all decrements succeed (below).
  qrToken?: string
  qr?: ReturnType<typeof qrEcho>
}

// --- Bookings/down-payments shared helpers (US-AG07) ---

interface BookingPolicy {
  minDownPaymentPct: number
  holdDays: number
  bookingGraceOffsetMinutes: number
}

// US-AG07.1 — cascade-ready policy resolver. A per-service override (later phase) would take
// precedence over the org global; this phase there are no overrides, so it returns the org globals.
function resolveBookingPolicy(org: {
  bookingMinDownPaymentPct: number
  bookingHoldDays: number
  bookingGraceOffsetMinutes: number
}): BookingPolicy {
  return {
    minDownPaymentPct: org.bookingMinDownPaymentPct,
    holdDays: org.bookingHoldDays,
    bookingGraceOffsetMinutes: org.bookingGraceOffsetMinutes,
  }
}

// US-A47 — a slot is sellable only while its start is beyond the org's sales cutoff. SIGNED
// offset: positive closes sales N min BEFORE departure; negative keeps them open until N min
// AFTER (a walk-up grace). Threshold instant = now + offset; a slot is sellable ⟺ its start is
// strictly after the threshold. Compared in the naive-UTC model (same as slotEpoch); absolute-
// timezone correctness is the separate BUG-007 limitation.
const salesThresholdStr = (nowSec: number, cutoffOffsetMin: number): string =>
  new Date((nowSec + cutoffOffsetMin * 60) * 1000).toISOString().slice(0, 16)

// SQL predicate form for the read filters (matrix / availability): keep only future-of-cutoff
// slots. `slots.date` is 'YYYY-MM-DD' and `slots.startTime` is 'HH:MM', so `date||'T'||time` is a
// fixed-width ISO minute string, lexicographically comparable to the threshold.
const sellableSlotSql = (thresholdStr: string) =>
  sql`(${slots.date} || 'T' || ${slots.startTime}) > ${thresholdStr}`

// JS form for the write guard (confirmSale / reactivate): sellable ⟺ slot start > threshold.
const isSlotSellable = (
  date: string,
  startTime: string,
  nowSec: number,
  cutoffOffsetMin: number,
): boolean => slotEpoch(date, startTime) > nowSec + cutoffOffsetMin * 60

// Epoch (seconds) of a naive slot start — single-timezone model (UTC arithmetic, no tz math).
const slotEpoch = (date: string, time: string): number =>
  Math.floor(Date.parse(`${date}T${time}:00Z`) / 1000)

// US-AG07.1 AC1 — release timestamp = min(createdAt + holdDuration, slotStart − tourBuffer).
// Same-day tours use the org's tighter same-day buffer; otherwise a 24h pre-departure buffer.
function bookingExpiryDate(
  policy: BookingPolicy,
  nowSec: number,
  earliestSlotEpoch: number,
  isSameDay: boolean,
): Date {
  const holdDuration = policy.holdDays * 86_400
  // Same-day: use the org's grace offset (+ before / − after departure). Otherwise a 24h
  // pre-departure release. A negative grace pushes the expiry PAST departure (a grace window).
  const tourBuffer = isSameDay ? policy.bookingGraceOffsetMinutes * 60 : 86_400
  const expiry = Math.min(nowSec + holdDuration, earliestSlotEpoch - tourBuffer)
  return new Date(expiry * 1000)
}

// A dialable phone (US-AG07 D4): ≥ 8 digits after stripping formatting.
const isDialablePhone = (phone: string | null | undefined): boolean =>
  (phone ?? '').replace(/\D/g, '').length >= 8

interface SignableLine {
  id: string
  serviceId: string
  slotId: string
  quantity: number
  slotDate: string
}

// Sign one QR access ticket per line from a server-owned payload (org from context). Shared by
// the paid path of confirmSale and by settle (US-AG07) — returns the per-line token + UI echo.
async function signLineTickets(
  env: CloudflareBindings,
  org: string,
  folioId: string,
  identity: string,
  lines: SignableLine[],
): Promise<Map<string, { token: string; qr: ReturnType<typeof qrEcho> }>> {
  const orgKey = await deriveOrgKey(env.QR_SECRET, org)
  const out = new Map<string, { token: string; qr: ReturnType<typeof qrEcho> }>()
  for (const line of lines) {
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
    out.set(line.id, { token: await signTicket(payload, orgKey), qr: qrEcho(payload) })
  }
  return out
}

// Best-effort tourist-portal token (US-T01) — never fails the committed sale. Shared by both paths.
async function issuePortalLink(
  db: Db,
  env: CloudflareBindings,
  org: string,
  folioId: string,
  slotDates: string[],
): Promise<string | undefined> {
  try {
    const portalToken = generatePortalToken()
    await db.insert(folioAccessTokens).values({
      id: crypto.randomUUID(),
      organizationId: org,
      folioId,
      token: portalToken,
      expiresAt: portalTokenExpiry(slotDates),
    })
    return `${env.API_BASE_URL}/portal/${portalToken}`
  } catch (err) {
    console.error('[portal] token issuance failed', folioId, err)
    return undefined
  }
}

interface TicketEmailMeta {
  customerEmail: string | null
  customerName: string | null
  paymentMethod: 'cash' | 'card' | 'transfer' | 'link'
  total: number
  createdAt: Date
}

// Fire-and-forget ticket + QR email (waitUntil so a Resend failure never rolls back the sale).
// Shared by the paid path of confirmSale and by settle.
function dispatchTicketEmail(
  c: PosContext,
  orgName: string,
  folioId: string,
  meta: TicketEmailMeta,
  lines: TicketConfirmationEmailInput['lines'],
  portalLink: string | undefined,
): void {
  if (!meta.customerEmail || !c.env.RESEND_API_KEY) return
  const emailData: TicketConfirmationEmailInput = {
    to: meta.customerEmail,
    customerName: meta.customerName,
    orgName,
    folioId,
    createdAt: meta.createdAt,
    paymentMethod: meta.paymentMethod,
    total: meta.total,
    portalLink,
    lines,
  }
  c.executionCtx.waitUntil(
    sendTicketConfirmationEmail(c.env, emailData).catch((err) =>
      console.error('[email] confirmation send failed', folioId, err),
    ),
  )
}

// Booking-action access (US-AG07 D5): the owning agent reaches their OWN folio; an admin reaches
// ANY folio in their org. Cross-org is always denied (the org filter). Returns the WHERE clause.
const folioActionFilter = (id: string, user: UserPayload) =>
  user.role === 'admin'
    ? and(eq(folios.id, id), eq(folios.organizationId, user.organizationId))
    : and(
        eq(folios.id, id),
        eq(folios.organizationId, user.organizationId),
        eq(folios.agentId, user.userId),
      )

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

  // Org name (for the email) + booking policy (US-A46 / US-AG07.1) — read once up front.
  const orgRows = await db
    .select({
      name: organizations.name,
      bookingMinDownPaymentPct: organizations.bookingMinDownPaymentPct,
      bookingHoldDays: organizations.bookingHoldDays,
      salesCutoffOffsetMinutes: organizations.salesCutoffOffsetMinutes,
      bookingGraceOffsetMinutes: organizations.bookingGraceOffsetMinutes,
    })
    .from(organizations)
    .where(eq(organizations.id, org))
    .limit(1)
  const orgRow = orgRows[0]
  // US-A47 — the sales cutoff gates EVERY new folio (walk-in sale + booking creation): a slot
  // past its cutoff is no longer sellable. Evaluated once against the request's start instant.
  const saleNowSec = Math.floor(Date.now() / 1000)
  const salesCutoffOffset = orgRow?.salesCutoffOffsetMinutes ?? 0

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
        commissionType: services.commissionType,
        commissionValue: services.commissionValue,
        isFlexible: services.isFlexible,
        flexCapacityPct: services.flexCapacityPct,
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

    // US-A47 — refuse a slot whose departure has passed the sales cutoff (no selling a tour
    // that already left / is past the walk-in window). Closes the past-slot integrity hole for
    // both full sales and booking creation, regardless of a stale client.
    if (!isSlotSellable(slot.date, slot.startTime, saleNowSec, salesCutoffOffset)) {
      throw new ApiError(
        'SLOT_CLOSED',
        409,
        'This time slot is closed for sale (its departure has passed the cutoff)',
      )
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
      commissionType: slot.commissionType,
      commissionValue: slot.commissionValue,
      isFlexible: slot.isFlexible,
      flexCapacityPct: slot.flexCapacityPct,
      extras: preparedExtras,
    })
  }

  const subtotal = prepared.reduce((sum, l) => sum + l.lineTotal, 0)
  const discountTotal = prepared.reduce(
    (sum, l) => sum + (l.basePrice - l.unitPrice) * l.quantity,
    0,
  )
  const total = subtotal

  // COMMISSION (US-AG23 / US-A12 rev. — service-based, seller-independent), split into its
  // percent and fixed parts (US-AG07 D8): a booking accrues percent-on-collected now and fixed
  // ONLY at settlement. `percent` → basis points (1000 = 10%) of the line total; `fixed` → minor
  // units per spot (× quantity). Both are snapshotted onto each folio_line below so settle can
  // re-derive the full commission without re-reading a possibly-edited service.
  const fullPercentCommission = prepared.reduce(
    (sum, l) =>
      sum +
      (l.commissionType === 'percent'
        ? Math.round((l.lineTotal * l.commissionValue) / 10000)
        : 0),
    0,
  )
  const fullFixedCommission = prepared.reduce(
    (sum, l) => sum + (l.commissionType === 'fixed' ? l.commissionValue * l.quantity : 0),
    0,
  )

  // US-AG07 — BOOKING (apartado) mode when a deposit is supplied. Validate the deposit against
  // the org policy + total BEFORE any inventory decrement; the spots are then reserved exactly
  // like a paid sale (the decrement below is shared). A booking defers QR/portal/ticket-email.
  const policy = resolveBookingPolicy({
    bookingMinDownPaymentPct: orgRow?.bookingMinDownPaymentPct ?? 0,
    bookingHoldDays: orgRow?.bookingHoldDays ?? 7,
    bookingGraceOffsetMinutes: orgRow?.bookingGraceOffsetMinutes ?? 15,
  })
  const isBooking = input.down_payment != null
  let status: 'paid' | 'booking' = 'paid'
  let amountPaid = total
  let commissionAmount = fullPercentCommission + fullFixedCommission
  let bookingExpiresAt: Date | null = null

  if (isBooking) {
    const downPayment = input.down_payment as number
    if (!isDialablePhone(input.customer_phone)) {
      throw new ApiError(
        'VALIDATION_ERROR',
        400,
        'A dialable customer phone is required for a booking',
      )
    }
    if (downPayment >= total) {
      throw new ApiError('VALIDATION_ERROR', 400, 'A full payment is not a booking')
    }
    const minRequired = Math.ceil((total * policy.minDownPaymentPct) / 100)
    if (downPayment < minRequired) {
      throw new ApiError(
        'DOWN_PAYMENT_BELOW_MINIMUM',
        400,
        'Deposit is below the minimum for this organization',
      )
    }
    status = 'booking'
    amountPaid = downPayment
    // Percent on the amount collected; fixed accrues nothing until the folio reaches `paid` (D8).
    commissionAmount = Math.round((fullPercentCommission * downPayment) / total)
    const nowSec = Math.floor(Date.now() / 1000)
    const earliest = prepared.reduce(
      (min, l) => {
        const e = slotEpoch(l.slotDate, l.slotStartTime)
        return e < min.epoch ? { epoch: e, date: l.slotDate } : min
      },
      { epoch: Infinity, date: '' },
    )
    bookingExpiresAt = bookingExpiryDate(
      policy,
      nowSec,
      earliest.epoch,
      earliest.date === utcToday(),
    )
  }

  // 2. DECREMENT each slot atomically & conditionally; track successes.
  const applied: { slotId: string; qty: number }[] = []
  for (const line of prepared) {
    // US-A36 — guard against EFFECTIVE capacity, not the raw cap. For a Soft Cap service the
    // ceiling is capacity + floor(capacity × pct / 100); SQLite integer division truncates
    // toward zero, so `capacity * pct / 100` is exactly that floor (pct ≥ 0). Hard Cap
    // (isFlexible=false) adds 0 — byte-identical to the previous `capacity - booked` guard.
    const flexMargin =
      line.isFlexible && line.flexCapacityPct > 0
        ? sql`((${slots.capacity} * ${line.flexCapacityPct}) / 100)`
        : sql`0`
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
          gte(sql`${slots.capacity} + ${flexMargin} - ${slots.booked}`, line.quantity),
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

  // 4. SIGN one QR access ticket per line — ONLY for a paid sale. A booking has no scannable QR
  //    until it settles (the scanner refuses any non-`paid` folio); settle signs the tickets then.
  const folioId = crypto.randomUUID()
  if (!isBooking) {
    const identity = clientIdentity(input, folioId)
    const tickets = await signLineTickets(c.env, org, folioId, identity, prepared)
    for (const line of prepared) {
      const t = tickets.get(line.id)!
      line.qrToken = t.token
      line.qr = t.qr
    }
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
      status,
      paymentMethod: input.payment_method ?? 'cash',
      subtotal,
      discountTotal,
      total,
      amountPaid,
      commissionAmount,
      bookingExpiresAt,
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
        commissionType: line.commissionType,
        commissionValue: line.commissionValue,
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

  const orgName = orgRow?.name ?? 'GuideMe'

  // Post-commit side effects diverge by sale type. A booking gets the apartado email (no QR, no
  // portal token); the paid sale mints the portal token + sends the full ticket + QR email. Both
  // are best-effort (waitUntil / try-catch) — a failure here must never roll back the committed sale.
  if (isBooking) {
    if (input.customer_email && c.env.RESEND_API_KEY && bookingExpiresAt) {
      const expiresAt = bookingExpiresAt
      c.executionCtx.waitUntil(
        sendBookingConfirmationEmail(c.env, {
          to: input.customer_email,
          customerName: input.customer_name ?? null,
          orgName,
          folioId,
          createdAt: new Date(),
          amountPaid,
          total,
          pendingBalance: total - amountPaid,
          bookingExpiresAt: expiresAt,
          lines: prepared.map((l) => ({
            serviceName: l.serviceName,
            slotDate: l.slotDate,
            slotStartTime: l.slotStartTime,
            quantity: l.quantity,
          })),
        }).catch((err) =>
          console.error('[email] booking confirmation send failed', folioId, err),
        ),
      )
    }
  } else {
    const portalLink = await issuePortalLink(
      db,
      c.env,
      org,
      folioId,
      prepared.map((l) => l.slotDate),
    )
    dispatchTicketEmail(
      c,
      orgName,
      folioId,
      {
        customerEmail: input.customer_email ?? null,
        customerName: input.customer_name ?? null,
        paymentMethod: input.payment_method ?? 'cash',
        total,
        createdAt: new Date(),
      },
      prepared.map((line) => ({
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
      portalLink,
    )
  }

  return c.json(
    {
      folio: {
        id: folioId,
        status,
        payment_method: input.payment_method ?? 'cash',
        customer_name: input.customer_name ?? null,
        customer_email: input.customer_email ?? null,
        customer_phone: input.customer_phone ?? null,
        subtotal,
        discount_total: discountTotal,
        total,
        amount_paid: amountPaid,
        pending_balance: total - amountPaid,
        booking_expires_at: bookingExpiresAt
          ? Math.floor(bookingExpiresAt.getTime() / 1000)
          : null,
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

// US-AG07 — settle a booking (one-shot): collect the full balance, flip to `paid`, mint the
// per-line QR + portal token, send the ticket email, and top up the commission to its full value
// (percent on the full total + fixed, which only accrues at `paid`). Caller-scoped; inventory is
// untouched (the spots were reserved at booking time). Guards: foreign/unknown → 404; already
// paid → 409; cancelled → 409; past its expiry → 409.
export const settleBooking = async (c: PosContext) => {
  const agent = c.get('user')
  const id = c.req.param('id')
  const db = getDb(c.env)
  const org = agent.organizationId

  const folioRows = await db
    .select({
      id: folios.id,
      status: folios.status,
      total: folios.total,
      bookingExpiresAt: folios.bookingExpiresAt,
      customerName: folios.customerName,
      customerEmail: folios.customerEmail,
      paymentMethod: folios.paymentMethod,
    })
    .from(folios)
    .where(folioActionFilter(id, agent))
    .limit(1)

  const folio = folioRows[0]
  if (!folio) throw new ApiError('NOT_FOUND', 404, 'Folio not found')
  if (folio.status === 'paid') {
    throw new ApiError('ALREADY_SETTLED', 409, 'Folio is already paid')
  }
  if (folio.status === 'cancelled') {
    throw new ApiError('FOLIO_CANCELLED', 409, 'Folio is cancelled')
  }
  if (folio.bookingExpiresAt && folio.bookingExpiresAt.getTime() <= Date.now()) {
    throw new ApiError('BOOKING_EXPIRED', 409, 'Booking has expired')
  }

  const lineRows = await db
    .select({
      id: folioLines.id,
      serviceId: folioLines.serviceId,
      slotId: folioLines.slotId,
      serviceName: folioLines.serviceName,
      slotDate: folioLines.slotDate,
      slotStartTime: folioLines.slotStartTime,
      quantity: folioLines.quantity,
      unitPrice: folioLines.unitPrice,
      lineTotal: folioLines.lineTotal,
      commissionType: folioLines.commissionType,
      commissionValue: folioLines.commissionValue,
    })
    .from(folioLines)
    .where(and(eq(folioLines.folioId, id), eq(folioLines.organizationId, org)))

  // Full commission from the per-line snapshot: percent on the full line total + fixed (which
  // only accrues now that the folio reaches `paid`, US-AG07 D8). No re-read of the service.
  const commissionAmount = lineRows.reduce(
    (sum, l) =>
      sum +
      (l.commissionType === 'fixed'
        ? l.commissionValue * l.quantity
        : Math.round((l.lineTotal * l.commissionValue) / 10000)),
    0,
  )

  // Sign the per-line tickets now (the booking had none).
  const identity =
    folio.customerName?.trim() || folio.customerEmail?.trim() || `folio:${id}`
  const tickets = await signLineTickets(c.env, org, id, identity, lineRows)

  const statements: BatchItem<'sqlite'>[] = [
    db
      .update(folios)
      .set({
        status: 'paid',
        amountPaid: folio.total,
        commissionAmount,
        settledAt: new Date(),
        settledBy: agent.userId,
        updatedAt: new Date(),
      })
      .where(and(eq(folios.id, id), eq(folios.organizationId, org))),
  ]
  for (const line of lineRows) {
    statements.push(
      db
        .update(folioLines)
        .set({ qrToken: tickets.get(line.id)!.token })
        .where(and(eq(folioLines.id, line.id), eq(folioLines.organizationId, org))),
    )
  }
  await db.batch(statements as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]])

  // Best-effort portal token + ticket email (the deferred half of confirmSale).
  const portalLink = await issuePortalLink(
    db,
    c.env,
    org,
    id,
    lineRows.map((l) => l.slotDate),
  )

  const extraRows = await db
    .select({
      folioLineId: folioLineExtras.folioLineId,
      name: folioLineExtras.name,
      price: folioLineExtras.price,
      quantity: folioLineExtras.quantity,
    })
    .from(folioLineExtras)
    .where(and(eq(folioLineExtras.folioId, id), eq(folioLineExtras.organizationId, org)))
  const extrasByLine = new Map<string, typeof extraRows>()
  for (const ex of extraRows) {
    const list = extrasByLine.get(ex.folioLineId) ?? []
    list.push(ex)
    extrasByLine.set(ex.folioLineId, list)
  }

  const orgRows = await db
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, org))
    .limit(1)
  dispatchTicketEmail(
    c,
    orgRows[0]?.name ?? 'GuideMe',
    id,
    {
      customerEmail: folio.customerEmail,
      customerName: folio.customerName,
      paymentMethod: folio.paymentMethod,
      total: folio.total,
      createdAt: new Date(),
    },
    lineRows.map((line) => ({
      serviceName: line.serviceName,
      slotDate: line.slotDate,
      slotStartTime: line.slotStartTime,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      lineTotal: line.lineTotal,
      qrToken: tickets.get(line.id)!.token,
      extras: (extrasByLine.get(line.id) ?? []).map((ex) => ({
        name: ex.name,
        price: ex.price,
        quantity: ex.quantity,
      })),
    })),
    portalLink,
  )

  const settled = await readFolio(db, org, agent.userId, id, c.env.QR_SECRET)
  return c.json({ folio: settled })
}

// US-AG07.4 — manual cancellation of a booking: release the held spots immediately and close the
// folio. The collected deposit is NON-REFUNDABLE and retained (refund_status stays 'none', D7);
// the agent keeps the percent commission already accrued. Booking-only and distinct from the
// admin refunding cancellation (US-A21). Owner-or-admin scoped.
export const cancelBooking = async (c: PosContext) => {
  const agent = c.get('user')
  const id = c.req.param('id')
  const db = getDb(c.env)
  const org = agent.organizationId
  const body = (await c.req.json().catch(() => ({}))) as { reason?: string }

  const folioRows = await db
    .select({ status: folios.status })
    .from(folios)
    .where(folioActionFilter(id, agent))
    .limit(1)
  const folio = folioRows[0]
  if (!folio) throw new ApiError('NOT_FOUND', 404, 'Folio not found')
  if (folio.status !== 'booking') {
    throw new ApiError('NOT_A_BOOKING', 409, 'Only a live booking can be cancelled here')
  }

  const lineRows = await db
    .select({ slotId: folioLines.slotId, quantity: folioLines.quantity })
    .from(folioLines)
    .where(and(eq(folioLines.folioId, id), eq(folioLines.organizationId, org)))

  const statements: BatchItem<'sqlite'>[] = [
    db
      .update(folios)
      .set({
        status: 'cancelled',
        cancelledAt: new Date(),
        cancelledBy: agent.userId,
        cancellationReason: body.reason ?? null,
        refundStatus: 'none', // deposit retained (D7)
        updatedAt: new Date(),
      })
      .where(and(eq(folios.id, id), eq(folios.organizationId, org))),
  ]
  for (const line of lineRows) {
    statements.push(
      db
        .update(slots)
        .set({ booked: sql`${slots.booked} - ${line.quantity}`, updatedAt: new Date() })
        .where(and(eq(slots.id, line.slotId), eq(slots.organizationId, org))),
    )
  }
  await db.batch(statements as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]])

  const updated = await readFolio(db, org, agent.userId, id, c.env.QR_SECRET)
  return c.json({ folio: updated ?? { id, status: 'cancelled' } })
}

// US-AG07.3 — claim the WhatsApp reminder (D6). An ATOMIC conditional update so two viewers
// (owner agent ↔ admin) never both send: only the one whose UPDATE matches `reminder_status='none'`
// wins. A loser gets `claimed:false` + who/when (UI offers ¿Reenviar? via `force`). Booking-only.
export const claimReminder = async (c: PosContext) => {
  const agent = c.get('user')
  const id = c.req.param('id')
  const db = getDb(c.env)
  const org = agent.organizationId
  const body = (await c.req.json().catch(() => ({}))) as { force?: boolean }

  const folioRows = await db
    .select({
      status: folios.status,
      reminderSentAt: folios.reminderSentAt,
      reminderSentBy: folios.reminderSentBy,
    })
    .from(folios)
    .where(folioActionFilter(id, agent))
    .limit(1)
  const folio = folioRows[0]
  if (!folio) throw new ApiError('NOT_FOUND', 404, 'Folio not found')
  if (folio.status !== 'booking') {
    throw new ApiError('NOT_A_BOOKING', 409, 'Reminders apply to bookings only')
  }

  const now = new Date()
  const nowSec = Math.floor(now.getTime() / 1000)
  const claim = { reminderStatus: 'sent' as const, reminderSentAt: now, reminderSentBy: agent.userId, updatedAt: now }

  if (body.force) {
    await db
      .update(folios)
      .set(claim)
      .where(and(eq(folios.id, id), eq(folios.organizationId, org)))
    return c.json({ claimed: true, reminder_sent_at: nowSec, reminder_sent_by: agent.userId })
  }

  const won = await db
    .update(folios)
    .set(claim)
    .where(
      and(
        eq(folios.id, id),
        eq(folios.organizationId, org),
        eq(folios.reminderStatus, 'none'),
      ),
    )
    .returning({ id: folios.id })

  if (won.length > 0) {
    return c.json({ claimed: true, reminder_sent_at: nowSec, reminder_sent_by: agent.userId })
  }
  // Already claimed by someone else — surface who/when so the UI can offer ¿Reenviar?
  return c.json({
    claimed: false,
    reminder_sent_at: folio.reminderSentAt
      ? Math.floor(folio.reminderSentAt.getTime() / 1000)
      : null,
    reminder_sent_by: folio.reminderSentBy,
  })
}

// US-AG07.5 — reactivate an EXPIRED booking (late-arrival contingency, reactivation only this
// phase). Re-blocks the freed spots IFF effective capacity still allows it (same atomic,
// compensating decrement + flex margin as confirmSale), flips back to `booking` with a fresh
// expiry, and the client then settles. If the tour filled up → 409 NO_CAPACITY_AVAILABLE (the UI
// offers the deferred Reagendar/Cupón). Owner-or-admin scoped; booking-only (it had an expiry).
export const reactivateBooking = async (c: PosContext) => {
  const agent = c.get('user')
  const id = c.req.param('id')
  const db = getDb(c.env)
  const org = agent.organizationId

  const folioRows = await db
    .select({ status: folios.status, bookingExpiresAt: folios.bookingExpiresAt })
    .from(folios)
    .where(folioActionFilter(id, agent))
    .limit(1)
  const folio = folioRows[0]
  if (!folio) throw new ApiError('NOT_FOUND', 404, 'Folio not found')
  if (folio.status !== 'cancelled' || folio.bookingExpiresAt === null) {
    throw new ApiError('NOT_A_BOOKING', 409, 'Only a cancelled booking can be reactivated')
  }

  const lineRows = await db
    .select({
      slotId: folioLines.slotId,
      quantity: folioLines.quantity,
      slotDate: folioLines.slotDate,
      slotStartTime: folioLines.slotStartTime,
      isFlexible: services.isFlexible,
      flexCapacityPct: services.flexCapacityPct,
    })
    .from(folioLines)
    .innerJoin(slots, eq(folioLines.slotId, slots.id))
    .innerJoin(services, eq(slots.serviceId, services.id))
    .where(and(eq(folioLines.folioId, id), eq(folioLines.organizationId, org)))

  // Current org policy — drives both the US-A47 sales cutoff guard and the fresh expiry below.
  const orgRows = await db
    .select({
      bookingMinDownPaymentPct: organizations.bookingMinDownPaymentPct,
      bookingHoldDays: organizations.bookingHoldDays,
      salesCutoffOffsetMinutes: organizations.salesCutoffOffsetMinutes,
      bookingGraceOffsetMinutes: organizations.bookingGraceOffsetMinutes,
    })
    .from(organizations)
    .where(eq(organizations.id, org))
    .limit(1)
  const policy = resolveBookingPolicy({
    bookingMinDownPaymentPct: orgRows[0]?.bookingMinDownPaymentPct ?? 0,
    bookingHoldDays: orgRows[0]?.bookingHoldDays ?? 7,
    bookingGraceOffsetMinutes: orgRows[0]?.bookingGraceOffsetMinutes ?? 15,
  })

  // US-A47 — don't reactivate onto a slot whose departure has passed the sales cutoff (that
  // would re-create an already-expired booking). Guard BEFORE re-blocking any spots.
  const reactivateNowSec = Math.floor(Date.now() / 1000)
  const salesCutoffOffset = orgRows[0]?.salesCutoffOffsetMinutes ?? 0
  for (const line of lineRows) {
    if (!isSlotSellable(line.slotDate, line.slotStartTime, reactivateNowSec, salesCutoffOffset)) {
      throw new ApiError(
        'SLOT_CLOSED',
        409,
        'This booking’s departure has passed the sales cutoff and cannot be reactivated',
      )
    }
  }

  // Re-decrement each slot atomically with the effective-capacity guard; compensate on failure.
  const applied: { slotId: string; qty: number }[] = []
  for (const line of lineRows) {
    const flexMargin =
      line.isFlexible && line.flexCapacityPct > 0
        ? sql`((${slots.capacity} * ${line.flexCapacityPct}) / 100)`
        : sql`0`
    const decremented = await db
      .update(slots)
      .set({ booked: sql`${slots.booked} + ${line.quantity}`, updatedAt: new Date() })
      .where(
        and(
          eq(slots.id, line.slotId),
          eq(slots.organizationId, org),
          eq(slots.status, 'active'),
          gte(sql`${slots.capacity} + ${flexMargin} - ${slots.booked}`, line.quantity),
        ),
      )
      .returning({ id: slots.id })

    if (decremented.length === 0) {
      for (const a of applied) {
        await db
          .update(slots)
          .set({ booked: sql`${slots.booked} - ${a.qty}`, updatedAt: new Date() })
          .where(and(eq(slots.id, a.slotId), eq(slots.organizationId, org)))
      }
      throw new ApiError(
        'NO_CAPACITY_AVAILABLE',
        409,
        'No hay cupo disponible para reactivar este apartado',
      )
    }
    applied.push({ slotId: line.slotId, qty: line.quantity })
  }

  // Fresh expiry from the current org policy (read above) + earliest slot.
  const earliest = lineRows.reduce(
    (min, l) => {
      const e = slotEpoch(l.slotDate, l.slotStartTime)
      return e < min.epoch ? { epoch: e, date: l.slotDate } : min
    },
    { epoch: Infinity, date: '' },
  )
  const bookingExpiresAt = bookingExpiryDate(
    policy,
    reactivateNowSec,
    earliest.epoch,
    earliest.date === utcToday(),
  )

  await db
    .update(folios)
    .set({
      status: 'booking',
      bookingExpiresAt,
      cancelledAt: null,
      cancelledBy: null,
      cancellationReason: null,
      updatedAt: new Date(),
    })
    .where(and(eq(folios.id, id), eq(folios.organizationId, org)))

  const updated = await readFolio(db, org, agent.userId, id, c.env.QR_SECRET)
  return c.json({ folio: updated ?? { id, status: 'booking' } })
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
      customerPhone: folios.customerPhone,
      status: folios.status,
      total: folios.total,
      amountPaid: folios.amountPaid,
      createdAt: folios.createdAt,
      cancelledAt: folios.cancelledAt,
      bookingExpiresAt: folios.bookingExpiresAt,
      reminderStatus: folios.reminderStatus,
      reminderSentAt: folios.reminderSentAt,
      reminderSentBy: folios.reminderSentBy,
    })
    .from(folios)
    .where(and(...filters))
    .orderBy(desc(folios.createdAt))

  return c.json({
    folios: rows.map((r) => ({
      id: r.id,
      customer_name: r.customerName,
      // US-AG07.3 — phone surfaces here so the dashboard can build the WhatsApp deep link.
      customer_phone: r.customerPhone,
      status: r.status,
      total: r.total,
      amount_paid: r.amountPaid,
      // US-AG07.3 — derived pending balance + booking fields drive the Apartados dashboard.
      pending_balance: r.total - r.amountPaid,
      created_at: Math.floor(r.createdAt.getTime() / 1000),
      cancelled_at: r.cancelledAt
        ? Math.floor(r.cancelledAt.getTime() / 1000)
        : null,
      booking_expires_at: r.bookingExpiresAt
        ? Math.floor(r.bookingExpiresAt.getTime() / 1000)
        : null,
      reminder_status: r.reminderStatus,
      reminder_sent_at: r.reminderSentAt
        ? Math.floor(r.reminderSentAt.getTime() / 1000)
        : null,
      reminder_sent_by: r.reminderSentBy,
    })),
  })
}
