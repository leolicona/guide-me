import type { Context } from 'hono'
import type { BatchItem } from 'drizzle-orm/batch'
import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm'
import { getDb, type Db } from '../../db/client'
import {
  accommodationReservations,
  accommodationSeasons,
  accommodationUnitTypes,
  affiliateCommissions,
  folioAccessTokens,
  folioLineExtras,
  folioLines,
  folios,
  organizations,
  serviceExtras,
  serviceZones,
  services,
  slots,
  slotZones,
} from '../../db/schema'
import { reconcileSlotTotals } from '../services/zones.reconcile'
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
import { naiveEpoch, orgToday, orgWallClockMinute } from '../../utils/tz'
import {
  nightsBetween,
  parseCsvInts,
  quoteStay,
  type SeasonRate,
} from '../../utils/lodging'
import { lodgingAvailableDays, lodgingTypeCards } from './lodging.handler'
import type { ConfirmSaleInput } from './schema'

export type PosContext = Context<{
  Bindings: CloudflareBindings
  Variables: AppVariables
}>

// US-A66 — the org's scheduling clock, loaded once per request: its IANA `tz` anchors "today" and
// the sales-cutoff threshold math; `cutoffOffsetMin` (US-A47) is the signed sales-cutoff offset.
// Falls back to the schema default zone if the row is somehow absent (an FK invariant).
async function loadOrgTiming(
  db: Db,
  orgId: string,
): Promise<{ tz: string; cutoffOffsetMin: number }> {
  const rows = await db
    .select({ tz: organizations.timezone, cutoff: organizations.salesCutoffOffsetMinutes })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1)
  return { tz: rows[0]?.tz ?? 'America/Mexico_City', cutoffOffsetMin: rows[0]?.cutoff ?? 0 }
}

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

// US-A66 — a ticket is valid through the end of the day AFTER the slot date (a deliberate grace for
// late/next-morning scans), measured from the slot's org-local midnight in the org's time zone.
const ticketExpiry = (slotDate: string, tz: string): number =>
  naiveEpoch(slotDate, '00:00', tz) + 48 * 3600

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

// US-A64 — a slot's per-zone availability (from `slot_zones` + the zone's name). `remaining` is the
// zone's own sellable count; `status` surfaces a closed-for-this-departure zone to the POS.
const serializeSlotZone = (row: {
  zoneId: string
  name: string
  capacity: number
  booked: number
  status: string
}) => ({
  zone_id: row.zoneId,
  name: row.name,
  capacity: row.capacity,
  booked: row.booked,
  remaining: row.capacity - row.booked,
  status: row.status,
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

// US-AG03 / US-AG10 / US-AG30 / US-AG35 — POS catalog: active services with a LIGHTWEIGHT,
// windowed availability flag (no slot details, no spot count). `has_availability` is
// true when the service has ≥ 1 active slot with effective remaining > 0 inside the
// availability window; `next_slot_date` = earliest active slot date in that window
// (or null). The window is the SEMANTIC DATE RANGE the agent selected — `from`/`to`
// (US-AG35's context pills or a calendar range) — or a single `date` (legacy single-day
// pick), or a rolling 3-day span (today … today + 2) by default (US-AG30).
export const listPosServices = async (c: PosContext) => {
  const agent = c.get('user')
  const db = getDb(c.env)
  const { tz, cutoffOffsetMin } = await loadOrgTiming(db, agent.organizationId)
  // US-A66 — "today" is the org-local calendar day; the client pins it via `?today=`, else fall
  // back to the org's time zone (no longer the server's UTC date, which rolled over early).
  const today = c.req.query('today') ?? orgToday(tz)
  // US-AG35 — the selected range `[from, to]` bounds availability. A bare `from` (or the
  // legacy single `date`) collapses the window to that one day; absent both, the window is
  // today … today + AVAILABILITY_WINDOW_DAYS (the default "next 3 days").
  const from = c.req.query('from') ?? c.req.query('date') ?? null
  const windowFrom = from ?? today
  const windowTo = from
    ? (c.req.query('to') ?? from)
    : addDays(today, AVAILABILITY_WINDOW_DAYS)

  // Curated catalog (affiliate-portal.spec.md §4.2): for an `affiliate` caller, INNER JOIN the
  // allow-list so the list collapses to exactly the services the admin enabled for their company
  // (a non-enabled service has no row and is absent). Agent/admin skip the join — full active
  // catalog, unchanged. Single source of truth; no view.
  const serviceCols = {
    id: services.id,
    name: services.name,
    description: services.description,
    basePrice: services.basePrice,
    minimumPrice: services.minimumPrice,
    isFlexible: services.isFlexible,
    flexCapacityPct: services.flexCapacityPct,
    category: services.category,
  }
  const baseWhere = and(
    eq(services.organizationId, agent.organizationId),
    eq(services.status, 'active'),
  )
  const serviceRows =
    agent.role === 'affiliate'
      ? await db
          .select(serviceCols)
          .from(services)
          .innerJoin(
            affiliateCommissions,
            and(
              eq(affiliateCommissions.serviceId, services.id),
              eq(affiliateCommissions.affiliateCompanyId, agent.affiliateCompanyId ?? ''),
            ),
          )
          .where(baseWhere)
          .orderBy(asc(services.name))
      : await db.select(serviceCols).from(services).where(baseWhere).orderBy(asc(services.name))

  // US-A36 — availability is the Σ EFFECTIVE remaining: each slot's raw remaining plus its
  // flexible margin (floor(capacity × pct / 100)) for a Soft Cap service. pct is constant per
  // service and we group per service, so SQLite's per-row integer division yields each slot's
  // floored margin and the sum is exact — a fully-booked-but-flexible service still advertises
  // its sellable last-minute spots instead of reading "Agotado".
  // US-A47 — exclude slots already past the sales cutoff so `has_availability` / `next_slot_date`
  // never advertise a departed time (e.g. a service whose only "remaining" slot today is over).
  const sellableThreshold = salesThresholdStr(
    Math.floor(Date.now() / 1000),
    cutoffOffsetMin,
    tz,
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

  // Lodging (spec §4.3, D14 — FLATTENED catalog): the parent lodging service is never a card;
  // it contributes one `unit_type` card per active type, each with its exact nightly rate,
  // per-night-windowed availability, and the `remaining` count ("Quedan N"). Tours are unchanged
  // apart from the `item_type` discriminator.
  const lodgingServices = serviceRows.filter((s) => s.category === 'lodging')
  const typeCards = await lodgingTypeCards(
    db,
    agent.organizationId,
    lodgingServices.map((s) => s.id),
    windowFrom,
    windowTo,
  )
  const lodgingServiceById = new Map(lodgingServices.map((s) => [s.id, s]))

  const tourCards = serviceRows
    .filter((s) => s.category !== 'lodging')
    .map((s) => {
      const a = availability.get(s.id)
      return {
        item_type: 'tour' as const,
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
        // US-AG30 — lightweight boolean (no count): ≥ 1 in-window slot is sellable.
        has_availability: a ? Number(a.availableSpots) > 0 : false,
        next_slot_date: a ? a.nextSlotDate : null,
      }
    })

  const unitTypeCards = typeCards.map((t) => {
    const parent = lodgingServiceById.get(t.serviceId)
    return {
      item_type: 'unit_type' as const,
      // Stable id = the unit type's id (frontend keys / folio deep-links / filters hang on it).
      id: t.id,
      service_id: t.serviceId,
      name: t.name,
      // The parent property, for card context ("Habitación Estándar · Hotel Centro").
      property_name: parent?.name ?? '',
      description: parent?.description ?? null,
      unit_type: t.unitType,
      category: 'lodging' as const,
      // Exact per-night price (the type's own base rate) — no aggregated "Desde $X".
      nightly_rate: t.nightlyRate,
      // Hard guest cap per room (D12) — the stay sheet caps guests at max_capacity × rooms
      // before the first quote, so an over-capacity request can never be formed.
      max_capacity: t.maxCapacity,
      // Per-night min remaining ≥ 1 over the selected window (§3.3).
      has_availability: t.hasAvailability,
      // Drives the "Quedan N" low-inventory badge.
      remaining: t.remaining,
      next_slot_date: null,
    }
  })

  // One mixed list, alphabetical like the v1 catalog (tour names + type names interleaved).
  const result = [...tourCards, ...unitTypeCards].sort((x, y) =>
    x.name.localeCompare(y.name),
  )

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
  const { month, today: todayParam, categories } = c.req.valid('query')
  const db = getDb(c.env)
  const { tz, cutoffOffsetMin } = await loadOrgTiming(db, agent.organizationId)
  const today = todayParam ?? orgToday(tz)

  const monthStart = `${month}-01`
  const monthEnd = lastOfMonth(month)
  // Floor the scan at `today` for the current month (no past days surface). For a fully-past
  // month `windowFrom` exceeds `windowEnd`; short-circuit rather than issue a no-row query.
  const windowFrom = today > monthStart ? today : monthStart
  if (windowFrom > monthEnd) {
    return c.json({ days: [] })
  }

  // US-A47 — drop days whose only slots have passed the sales cutoff (no past times in the picker).
  const sellableThreshold = salesThresholdStr(
    Math.floor(Date.now() / 1000),
    cutoffOffsetMin,
    tz,
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
        // US-A37 — scope the dots to the agent's selected category filter (when any).
        ...(categories ? [inArray(services.category, categories)] : []),
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

  // Lodging (spec §4.3, v2): REAL availability dots from per-night counts — a day lights up when
  // any active unit type of an active lodging service has remaining ≥ 1 that night. Included when
  // the category filter is absent or names 'lodging' (this retires the frontend lodgingInScope hack).
  const days = new Set(rows.map((r) => r.date))
  if (!categories || categories.includes('lodging')) {
    const lodgingDays = await lodgingAvailableDays(
      db,
      agent.organizationId,
      windowFrom,
      monthEnd,
    )
    for (const d of lodgingDays) days.add(d)
  }

  return c.json({ days: [...days].sort() })
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
      zonesEnabled: services.zonesEnabled,
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

  // Defense in depth (affiliate-portal.spec.md §4.2): an affiliate may only open a service on
  // their allow-list. A hand-crafted request for a non-curated id → 404, even though it never
  // appeared in their catalog.
  if (agent.role === 'affiliate') {
    const allowed = await db
      .select({ id: affiliateCommissions.id })
      .from(affiliateCommissions)
      .where(
        and(
          eq(affiliateCommissions.affiliateCompanyId, agent.affiliateCompanyId ?? ''),
          eq(affiliateCommissions.serviceId, id),
        ),
      )
      .limit(1)
    if (allowed.length === 0) {
      throw new ApiError('NOT_FOUND', 404, 'Service not found')
    }
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

  const { tz, cutoffOffsetMin } = await loadOrgTiming(db, agent.organizationId)
  const from = c.req.query('from') ?? orgToday(tz)
  const to = c.req.query('to')

  // US-A47 — never surface a slot that's no longer sellable (its departure passed the cutoff),
  // so the matrix shows only the times an agent can actually sell today.
  const threshold = salesThresholdStr(Math.floor(Date.now() / 1000), cutoffOffsetMin, tz)

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

  // US-A64 — for a zoned service, attach each slot's per-zone availability (from `slot_zones`,
  // so `capacity` is the frozen per-departure snapshot and a closed zone appears as inactive).
  // The agent picks a zone; the POS bounds the quantity by that zone's remaining.
  const zonesBySlot = new Map<string, ReturnType<typeof serializeSlotZone>[]>()
  if (service.zonesEnabled && slotRows.length > 0) {
    const zoneRows = await db
      .select({
        slotId: slotZones.slotId,
        zoneId: slotZones.zoneId,
        name: serviceZones.name,
        sortOrder: serviceZones.sortOrder,
        capacity: slotZones.capacity,
        booked: slotZones.booked,
        status: slotZones.status,
      })
      .from(slotZones)
      .innerJoin(serviceZones, eq(serviceZones.id, slotZones.zoneId))
      .where(
        and(
          eq(slotZones.organizationId, agent.organizationId),
          inArray(
            slotZones.slotId,
            slotRows.map((s) => s.id),
          ),
        ),
      )
      .orderBy(asc(serviceZones.sortOrder))
    for (const z of zoneRows) {
      const list = zonesBySlot.get(z.slotId) ?? []
      list.push(serializeSlotZone(z))
      zonesBySlot.set(z.slotId, list)
    }
  }

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
      // US-A64 — false ⇒ no `zones` on any slot (today's clients unaffected).
      zones_enabled: service.zonesEnabled,
      // US-A37 — echoed for a consistent service shape (the detail screen doesn't filter).
      category: service.category,
      extras: extras.map(serializeExtra),
      slots: slotRows.map((s) => ({
        ...serializeSlot(s),
        ...(service.zonesEnabled ? { zones: zonesBySlot.get(s.id) ?? [] } : {}),
      })),
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
  // 'slot' = tour line (slotId set); 'stay' = lodging line (unitTypeId/checkIn/checkOut set, slotId null).
  lineType: 'slot' | 'stay'
  slotId: string | null
  serviceId: string
  serviceName: string
  slotDate: string | null
  slotStartTime: string | null
  quantity: number
  basePrice: number
  minimumPrice: number
  unitPrice: number
  lineTotal: number
  // Service-based commission snapshot (US-A12 rev.): percent → value is basis points of the
  // line total; fixed → value is minor units per spot (× quantity; for a stay quantity = rooms,
  // so a fixed commission counts per room-stay — D13).
  commissionType: 'percent' | 'fixed'
  commissionValue: number
  // US-A36 — capacity mode, used to build the effective-capacity guard at decrement time (slot only).
  isFlexible: boolean
  flexCapacityPct: number
  // US-A64 — the physical zone this slot line sells into (null on an unzoned service). When set,
  // inventory is guarded/released against `slot_zones`, not the raw slot.
  zoneId?: string | null
  zoneName?: string | null
  extras: PreparedExtra[]
  // Lodging stay fields (lineType === 'stay').
  unitTypeId?: string
  checkIn?: string
  checkOut?: string
  guests?: number
  nights?: number
  // Signed at confirm time, once all decrements succeed (below). Stay lines have no QR.
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

// US-A47/A66 — a slot is sellable only while its start is beyond the org's sales cutoff. SIGNED
// offset: positive closes sales N min BEFORE departure; negative keeps them open until N min AFTER
// (a walk-up grace). Threshold instant = now + offset; a slot is sellable ⟺ its start is strictly
// after the threshold. Rendered as the org-local wall-clock of that instant so it is lexicographi-
// cally comparable to the slot's naive `date||'T'||time` — resolving the comparison in the org's
// time zone (this is what closes BUG-007).
const salesThresholdStr = (nowSec: number, cutoffOffsetMin: number, tz: string): string =>
  orgWallClockMinute((nowSec + cutoffOffsetMin * 60) * 1000, tz)

// SQL predicate form for the read filters (matrix / availability): keep only future-of-cutoff
// slots. `slots.date` is 'YYYY-MM-DD' and `slots.startTime` is 'HH:MM', so `date||'T'||time` is a
// fixed-width minute string, lexicographically comparable to the org-local threshold string.
const sellableSlotSql = (thresholdStr: string) =>
  sql`(${slots.date} || 'T' || ${slots.startTime}) > ${thresholdStr}`

// JS form for the write guard (confirmSale / reactivate): sellable ⟺ slot start > threshold.
const isSlotSellable = (
  date: string,
  startTime: string,
  nowSec: number,
  cutoffOffsetMin: number,
  tz: string,
): boolean => slotEpoch(date, startTime, tz) > nowSec + cutoffOffsetMin * 60

// Epoch (seconds) of a naive slot start, resolved in the org's time zone (US-A66).
const slotEpoch = (date: string, time: string, tz: string): number =>
  naiveEpoch(date, time, tz)

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
  tz: string,
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
      expires_at: ticketExpiry(line.slotDate, tz),
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

// Look up an already-issued portal link for a folio (whatsapp-qr-delivery). Returns the newest
// token's URL, or null when none exists yet (unpaid booking / pre-feature sale). Drives the
// receipt/folio-detail "Enviar por WhatsApp" affordance and the delivery badge.
async function folioPortalLink(
  db: Db,
  org: string,
  folioId: string,
  apiBaseUrl: string,
): Promise<string | null> {
  const rows = await db
    .select({ token: folioAccessTokens.token })
    .from(folioAccessTokens)
    .where(
      and(eq(folioAccessTokens.folioId, folioId), eq(folioAccessTokens.organizationId, org)),
    )
    .orderBy(desc(folioAccessTokens.createdAt))
    .limit(1)
  const row = rows[0]
  return row ? `${apiBaseUrl}/portal/${row.token}` : null
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

  // Affiliate sale (affiliate-portal.spec.md D2/D3): the seller may only sell allow-list
  // services, and the commission resolves from the per-affiliate rate — NOT services.commission_*.
  // Pre-fetch the company's allow-list once (serviceId → rate) so the validate loop both guards
  // membership (SERVICE_NOT_ALLOWED) and overrides each line's commission snapshot.
  const isAffiliate = agent.role === 'affiliate'
  const affiliateCompanyId = isAffiliate ? agent.affiliateCompanyId : null

  // D2 (whatsapp-qr-delivery) — email is no longer a required delivery channel. WhatsApp (the
  // agent-sent portal link, name + phone required by the schema) is now primary; email is an
  // optional copy for any role. The schema still validates the address format when present.
  const affiliateRates = new Map<string, { type: 'percent' | 'fixed'; value: number }>()
  if (isAffiliate) {
    if (!affiliateCompanyId) {
      throw new ApiError('FORBIDDEN', 403, 'Affiliate is not linked to a company')
    }
    const rateRows = await db
      .select({
        serviceId: affiliateCommissions.serviceId,
        commissionType: affiliateCommissions.commissionType,
        commissionValue: affiliateCommissions.commissionValue,
      })
      .from(affiliateCommissions)
      .where(
        and(
          eq(affiliateCommissions.organizationId, org),
          eq(affiliateCommissions.affiliateCompanyId, affiliateCompanyId),
        ),
      )
    for (const r of rateRows) {
      affiliateRates.set(r.serviceId, { type: r.commissionType, value: r.commissionValue })
    }
  }

  // Org name (for the email) + booking policy (US-A46 / US-AG07.1) — read once up front.
  const orgRows = await db
    .select({
      name: organizations.name,
      bookingMinDownPaymentPct: organizations.bookingMinDownPaymentPct,
      bookingHoldDays: organizations.bookingHoldDays,
      salesCutoffOffsetMinutes: organizations.salesCutoffOffsetMinutes,
      bookingGraceOffsetMinutes: organizations.bookingGraceOffsetMinutes,
      lodgingWeekendDays: organizations.lodgingWeekendDays,
      timezone: organizations.timezone,
    })
    .from(organizations)
    .where(eq(organizations.id, org))
    .limit(1)
  const orgRow = orgRows[0]
  const weekendDays = parseCsvInts(orgRow?.lodgingWeekendDays ?? '5,6')
  // US-A66 — every wall-clock comparison below (cutoff, same-day booking grace, ticket expiry)
  // resolves in the org's time zone.
  const tz = orgRow?.timezone ?? 'America/Mexico_City'
  // US-A47 — the sales cutoff gates EVERY new folio (walk-in sale + booking creation): a slot
  // past its cutoff is no longer sellable. Evaluated once against the request's start instant.
  const saleNowSec = Math.floor(Date.now() / 1000)
  const salesCutoffOffset = orgRow?.salesCutoffOffsetMinutes ?? 0

  // 1. VALIDATE (reads only) — snapshot prices/names from active, in-org inventory.
  const prepared: PreparedLine[] = []
  for (const line of input.lines) {
    // --- Lodging STAY line (docs/lodging v2 — has unit_type_id): `quantity` rooms of a type.
    // Re-quote via the shared engine (D12) and snapshot the total; the atomic per-night count
    // guard (D10) runs at the reservation insert below. ---
    if ('unit_type_id' in line) {
      const typeRows = await db
        .select({
          id: accommodationUnitTypes.id,
          serviceId: accommodationUnitTypes.serviceId,
          name: accommodationUnitTypes.name,
          inventoryCount: accommodationUnitTypes.inventoryCount,
          baseRate: accommodationUnitTypes.baseRate,
          weekendRate: accommodationUnitTypes.weekendRate,
          extraPersonFee: accommodationUnitTypes.extraPersonFee,
          baseOccupancy: accommodationUnitTypes.baseOccupancy,
          maxCapacity: accommodationUnitTypes.maxCapacity,
          minNights: accommodationUnitTypes.minNights,
          // Waterfall commission inputs: the type's own override (nullable) + the service base.
          typeCommissionType: accommodationUnitTypes.commissionType,
          typeCommissionValue: accommodationUnitTypes.commissionValue,
          svcCommissionType: services.commissionType,
          svcCommissionValue: services.commissionValue,
        })
        .from(accommodationUnitTypes)
        .innerJoin(services, eq(accommodationUnitTypes.serviceId, services.id))
        .where(
          and(
            eq(accommodationUnitTypes.id, line.unit_type_id),
            eq(accommodationUnitTypes.organizationId, org),
            eq(accommodationUnitTypes.status, 'active'),
            eq(services.status, 'active'),
            eq(services.category, 'lodging'),
          ),
        )
        .limit(1)
      const unitType = typeRows[0]
      if (!unitType) {
        throw new ApiError('NOT_FOUND', 404, 'Unit type not found or unavailable')
      }

      if (!(line.check_out > line.check_in)) {
        throw new ApiError('VALIDATION_ERROR', 400, 'check_out must be after check_in')
      }
      const nights = nightsBetween(line.check_in, line.check_out)
      if (nights < unitType.minNights) {
        throw new ApiError(
          'MIN_STAY_NOT_MET',
          400,
          `Minimum stay is ${unitType.minNights} night(s)`,
        )
      }
      if (line.quantity > unitType.inventoryCount) {
        throw new ApiError(
          'VALIDATION_ERROR',
          400,
          `quantity exceeds this type's inventory (${unitType.inventoryCount})`,
        )
      }
      // D12 — capacity is per room × rooms (guests split evenly at quote time).
      if (line.guests < 1 || line.guests > unitType.maxCapacity * line.quantity) {
        throw new ApiError('VALIDATION_ERROR', 400, 'guests exceeds the capacity of the rooms')
      }

      // Active seasons overlapping the stay → the rate engine.
      const seasonRows = await db
        .select({
          startDate: accommodationSeasons.startDate,
          endDate: accommodationSeasons.endDate,
          nightlyRate: accommodationSeasons.nightlyRate,
        })
        .from(accommodationSeasons)
        .where(
          and(
            eq(accommodationSeasons.organizationId, org),
            eq(accommodationSeasons.unitTypeId, unitType.id),
            eq(accommodationSeasons.status, 'active'),
            lte(accommodationSeasons.startDate, line.check_out),
            gte(accommodationSeasons.endDate, line.check_in),
          ),
        )
      const seasons: SeasonRate[] = seasonRows.map((s) => ({
        startDate: s.startDate,
        endDate: s.endDate,
        nightlyRate: s.nightlyRate,
      }))
      const quote = quoteStay(
        {
          baseRate: unitType.baseRate,
          weekendRate: unitType.weekendRate,
          extraPersonFee: unitType.extraPersonFee,
          baseOccupancy: unitType.baseOccupancy,
          maxCapacity: unitType.maxCapacity,
          minNights: unitType.minNights,
        },
        line.check_in,
        line.check_out,
        line.guests,
        line.quantity,
        seasons,
        weekendDays,
      )

      // Commission waterfall (US-A12): type override ?? service base; affiliate's per-affiliate
      // rate still wins over both (its own allow-list-gated system, unchanged).
      let stayCommType = unitType.typeCommissionType ?? unitType.svcCommissionType
      let stayCommValue =
        unitType.typeCommissionType != null
          ? (unitType.typeCommissionValue ?? 0)
          : unitType.svcCommissionValue
      if (isAffiliate) {
        const rate = affiliateRates.get(unitType.serviceId)
        if (!rate) {
          throw new ApiError(
            'SERVICE_NOT_ALLOWED',
            403,
            'This service is not enabled for your affiliate account',
          )
        }
        stayCommType = rate.type
        stayCommValue = rate.value
      }

      prepared.push({
        id: crypto.randomUUID(),
        lineType: 'stay',
        slotId: null,
        serviceId: unitType.serviceId,
        serviceName: unitType.name, // type name snapshot
        slotDate: null,
        slotStartTime: null,
        quantity: line.quantity, // rooms — a fixed commission counts per room-stay (D13)
        basePrice: quote.total, // no per-night discounting → base == sold (whole line)
        minimumPrice: 0,
        unitPrice: quote.total,
        lineTotal: quote.total,
        commissionType: stayCommType,
        commissionValue: stayCommValue,
        isFlexible: false,
        flexCapacityPct: 0,
        extras: [],
        unitTypeId: unitType.id,
        checkIn: line.check_in,
        checkOut: line.check_out,
        guests: line.guests,
        nights,
      })
      continue
    }

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
        zonesEnabled: services.zonesEnabled,
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
    if (!isSlotSellable(slot.date, slot.startTime, saleNowSec, salesCutoffOffset, tz)) {
      throw new ApiError(
        'SLOT_CLOSED',
        409,
        'This time slot is closed for sale (its departure has passed the cutoff)',
      )
    }

    // US-A64 — resolve the physical zone. Required on a zoned service, refused on an unzoned one;
    // the id must belong to this slot's service + the caller's org (a foreign zone → 404, never
    // revealed). The name is snapshotted onto the line so a later rename can't rewrite this ticket.
    let zoneId: string | null = null
    let zoneName: string | null = null
    if (slot.zonesEnabled) {
      if (!line.zone_id) {
        throw new ApiError('VALIDATION_ERROR', 400, 'A zone is required for this service')
      }
      const zoneRows = await db
        .select({ id: serviceZones.id, name: serviceZones.name })
        .from(serviceZones)
        .where(
          and(
            eq(serviceZones.id, line.zone_id),
            eq(serviceZones.organizationId, org),
            eq(serviceZones.serviceId, slot.serviceId),
            eq(serviceZones.status, 'active'),
          ),
        )
        .limit(1)
      if (!zoneRows[0]) {
        throw new ApiError('NOT_FOUND', 404, 'Zone not found for this service')
      }
      zoneId = zoneRows[0].id
      zoneName = zoneRows[0].name
    } else if (line.zone_id) {
      throw new ApiError('VALIDATION_ERROR', 400, 'This service does not use zones')
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

    // Commission source (D3): an affiliate line snapshots the per-affiliate rate (and must be on
    // the allow-list — defense in depth even though the catalog never showed a non-curated id);
    // an agent/admin line keeps the service's seller-independent rate.
    let commissionType = slot.commissionType
    let commissionValue = slot.commissionValue
    if (isAffiliate) {
      const rate = affiliateRates.get(slot.serviceId)
      if (!rate) {
        throw new ApiError(
          'SERVICE_NOT_ALLOWED',
          403,
          'This service is not enabled for your affiliate account',
        )
      }
      commissionType = rate.type
      commissionValue = rate.value
    }

    const lineTotal = line.unit_price * line.quantity + extrasTotal
    prepared.push({
      id: crypto.randomUUID(),
      lineType: 'slot',
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
      commissionType,
      commissionValue,
      isFlexible: slot.isFlexible,
      flexCapacityPct: slot.flexCapacityPct,
      zoneId,
      zoneName,
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
    // Earliest "departure" across the cart: a slot's start, or a stay's check-in (midnight). Drives
    // the release timestamp (US-AG07.1). A stay uses its check-in date as the protected instant.
    const earliest = prepared.reduce(
      (min, l) => {
        const date = l.lineType === 'stay' ? l.checkIn! : l.slotDate!
        const time = l.lineType === 'stay' ? '00:00' : l.slotStartTime!
        const e = slotEpoch(date, time, tz)
        return e < min.epoch ? { epoch: e, date } : min
      },
      { epoch: Infinity, date: '' },
    )
    bookingExpiresAt = bookingExpiryDate(
      policy,
      nowSec,
      earliest.epoch,
      earliest.date === orgToday(tz),
    )
  }

  // A stay reservation FK-references the folio, so the folio row must exist BEFORE the reserve
  // step. Insert it now; compensation deletes it if any line fails (mirrors the slot re-increment).
  const folioId = crypto.randomUUID()
  await db.insert(folios).values({
    id: folioId,
    organizationId: org,
    agentId: agent.userId,
    // D5 — stamp the seller's company on an affiliate sale; null for in-house (agent/admin).
    affiliateCompanyId,
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
  })

  // 2. RESERVE INVENTORY — per line, conditionally & atomically, tracking successes so a later
  //    failure can be compensated. Slot lines decrement booked (effective-capacity guard); stay
  //    lines insert a reservation guarded by a half-open overlap probe (the lodging analogue).
  const applied: { slotId: string; qty: number; zoneId?: string | null }[] = []
  const appliedReservations: string[] = []
  const compensate = async () => {
    for (const a of applied) {
      if (a.zoneId) {
        // US-A64 — hand the seats back to the zone counter, then re-derive the slot totals.
        await db
          .update(slotZones)
          .set({ booked: sql`${slotZones.booked} - ${a.qty}`, updatedAt: new Date() })
          .where(
            and(
              eq(slotZones.slotId, a.slotId),
              eq(slotZones.zoneId, a.zoneId),
              eq(slotZones.organizationId, org),
            ),
          )
        await reconcileSlotTotals(db, a.slotId)
      } else {
        await db
          .update(slots)
          .set({ booked: sql`${slots.booked} - ${a.qty}`, updatedAt: new Date() })
          .where(and(eq(slots.id, a.slotId), eq(slots.organizationId, org)))
      }
    }
    for (const rid of appliedReservations) {
      await db
        .delete(accommodationReservations)
        .where(and(eq(accommodationReservations.id, rid), eq(accommodationReservations.organizationId, org)))
    }
    await db.delete(folios).where(and(eq(folios.id, folioId), eq(folios.organizationId, org)))
  }

  for (const line of prepared) {
    if (line.lineType === 'stay') {
      // Atomic conditional INSERT — the PER-NIGHT COUNT GUARD (spec §2.4, D10): create the
      // reservation only if, for EVERY night of [check_in, check_out) (recursive-CTE expansion),
      // reserved(night) + blocked(night) + requested ≤ inventory_count. A naive SUM over all
      // overlapping reservations would over-count non-mutually-overlapping stays → false 409s.
      // 0 rows written ⟺ insufficient → 409 INSUFFICIENT_INVENTORY. Raw D1 for exact rows-written.
      const reservationId = crypto.randomUUID()
      const ins = await c.env.DB.prepare(
        `INSERT INTO accommodation_reservations
           (id, organization_id, service_id, unit_type_id, folio_id, check_in, check_out, guests, quantity, status)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active'
         WHERE NOT EXISTS (
           WITH RECURSIVE nights(d) AS (
             SELECT ?
             UNION ALL
             SELECT date(d, '+1 day') FROM nights WHERE date(d, '+1 day') < ?
           )
           SELECT 1 FROM nights n
           WHERE COALESCE((SELECT SUM(r.quantity) FROM accommodation_reservations r
                           WHERE r.unit_type_id = ? AND r.status = 'active'
                             AND r.check_in <= n.d AND n.d < r.check_out), 0)
               + COALESCE((SELECT SUM(b.quantity) FROM accommodation_blockouts b
                           WHERE b.unit_type_id = ?
                             AND b.start_date <= n.d AND n.d < b.end_date), 0)
               + ?
               > (SELECT t.inventory_count FROM accommodation_unit_types t WHERE t.id = ?)
         )`,
      )
        .bind(
          reservationId,
          org,
          line.serviceId,
          line.unitTypeId!,
          folioId,
          line.checkIn!,
          line.checkOut!,
          line.guests!,
          line.quantity,
          line.checkIn!,
          line.checkOut!,
          line.unitTypeId!,
          line.unitTypeId!,
          line.quantity,
          line.unitTypeId!,
        )
        .run()
      if (!ins.meta.changes) {
        await compensate()
        throw new ApiError(
          'INSUFFICIENT_INVENTORY',
          409,
          'Not enough rooms of this type are available for those dates',
        )
      }
      appliedReservations.push(reservationId)
      continue
    }

    // US-A64 — a zoned line is guarded against its OWN zone's snapshotted seats (single-statement
    // atomic UPDATE, mirroring the slot guard). A zoned service is never Soft Cap, so no flex here.
    if (line.zoneId) {
      const decremented = await db
        .update(slotZones)
        .set({ booked: sql`${slotZones.booked} + ${line.quantity}`, updatedAt: new Date() })
        .where(
          and(
            eq(slotZones.slotId, line.slotId!),
            eq(slotZones.zoneId, line.zoneId),
            eq(slotZones.organizationId, org),
            eq(slotZones.status, 'active'),
            gte(sql`${slotZones.capacity} - ${slotZones.booked}`, line.quantity),
          ),
        )
        .returning({ id: slotZones.id })

      if (decremented.length === 0) {
        await compensate()
        throw new ApiError(
          'ZONE_UNAVAILABLE',
          409,
          'That zone just sold out — please review your cart',
        )
      }
      // Re-derive the slot's headline totals from its zones (idempotent).
      await reconcileSlotTotals(db, line.slotId!)
      applied.push({ slotId: line.slotId!, qty: line.quantity, zoneId: line.zoneId })
      continue
    }

    // US-A36 — guard against EFFECTIVE capacity, not the raw cap (Soft Cap adds floor(cap×pct/100);
    // Hard Cap adds 0). SQLite integer division truncates → exactly that floor.
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
          eq(slots.id, line.slotId!),
          eq(slots.organizationId, org),
          eq(slots.status, 'active'),
          gte(sql`${slots.capacity} + ${flexMargin} - ${slots.booked}`, line.quantity),
        ),
      )
      .returning({ id: slots.id })

    if (decremented.length === 0) {
      await compensate()
      throw new ApiError(
        'SLOT_UNAVAILABLE',
        409,
        'A selected time just sold out — please review your cart',
      )
    }
    applied.push({ slotId: line.slotId!, qty: line.quantity })
  }

  // 4. SIGN one QR access ticket per SLOT line — ONLY for a paid sale. A booking has no scannable
  //    QR until it settles; a lodging stay line has no slot QR (its access is the reservation).
  const slotLines = prepared.filter((l) => l.lineType === 'slot' && l.slotId && l.slotDate)
  if (!isBooking) {
    // The folio + holds are already committed (the reservation FK needs the folio first), so a
    // signing failure must compensate too — otherwise it would orphan the folio.
    try {
      const identity = clientIdentity(input, folioId)
      const tickets = await signLineTickets(
        c.env,
        org,
        folioId,
        identity,
        slotLines.map((l) => ({
          id: l.id,
          serviceId: l.serviceId,
          slotId: l.slotId!,
          quantity: l.quantity,
          slotDate: l.slotDate!,
        })),
        tz,
      )
      for (const line of slotLines) {
        const t = tickets.get(line.id)!
        line.qrToken = t.token
        line.qr = t.qr
      }
    } catch (err) {
      await compensate()
      throw err
    }
  }

  // 5. PERSIST — lines + extras in one atomic batch (the folio row was inserted above).
  const statements: BatchItem<'sqlite'>[] = []

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
        lineType: line.lineType,
        unitTypeId: line.unitTypeId ?? null,
        checkIn: line.checkIn ?? null,
        checkOut: line.checkOut ?? null,
        guests: line.guests ?? null,
        nights: line.nights ?? null,
        zoneId: line.zoneId ?? null,
        zoneName: line.zoneName ?? null,
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

  // The folio + its inventory holds were committed above (the folio must precede the reservation
  // FK). If persisting the lines fails, compensate everything (re-increment slots, drop the
  // reservations + the folio) so no orphaned folio is left behind — restoring the all-or-nothing
  // guarantee D1's lack of interactive transactions can't give us directly.
  try {
    await db.batch(statements as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]])
  } catch (err) {
    await compensate()
    throw err
  }

  const orgName = orgRow?.name ?? 'Turistear Ya!'

  // Ticket/QR delivery is customer-direct for EVERY role now (whatsapp-qr-delivery D9): the tourist
  // (name + phone captured) gets the WhatsApp portal link, and email — when a customer email was
  // captured — is an optional copy. An affiliate no longer receives a self-addressed copy; they
  // re-open the sale from their own /history.
  const ticketRecipients = [
    ...new Set([input.customer_email].filter((e): e is string => !!e)),
  ]

  // The portal link is surfaced to the client (receipt CTA + folio detail) so the agent can send it
  // over WhatsApp. Minted on the paid path only (a booking has no QR/portal token yet).
  let portalLink: string | undefined

  // Post-commit side effects diverge by sale type. A booking gets the apartado email (no QR, no
  // portal token); the paid sale mints the portal token + sends the full ticket + QR email. Both
  // are best-effort (waitUntil / try-catch) — a failure here must never roll back the committed sale.
  if (isBooking) {
    if (c.env.RESEND_API_KEY && bookingExpiresAt) {
      const expiresAt = bookingExpiresAt
      for (const to of ticketRecipients) {
        c.executionCtx.waitUntil(
          sendBookingConfirmationEmail(c.env, {
            to,
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
              // A stay line shows its check-in date in place of a slot date/time.
              slotDate: l.slotDate ?? l.checkIn ?? '',
              slotStartTime: l.slotStartTime ?? '',
              quantity: l.quantity,
            })),
          }).catch((err) =>
            console.error('[email] booking confirmation send failed', folioId, err),
          ),
        )
      }
    }
  } else {
    portalLink = await issuePortalLink(
      db,
      c.env,
      org,
      folioId,
      // Portal validity spans the trip: slot dates, plus a stay's checkout as its last date.
      prepared.map((l) => l.slotDate ?? l.checkOut ?? l.checkIn!).filter((d): d is string => !!d),
    )
    // Only slot lines carry a QR ticket; a stay line's access is its reservation (no per-line QR).
    const ticketLines = slotLines.map((line) => ({
      serviceName: line.serviceName,
      slotDate: line.slotDate!,
      slotStartTime: line.slotStartTime!,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      lineTotal: line.lineTotal,
      qrToken: line.qrToken!,
      extras: line.extras.map((ex) => ({
        name: ex.name,
        price: ex.price,
        quantity: ex.quantity,
      })),
    }))
    for (const to of ticketRecipients) {
      dispatchTicketEmail(
        c,
        orgName,
        folioId,
        {
          customerEmail: to,
          customerName: input.customer_name ?? null,
          paymentMethod: input.payment_method ?? 'cash',
          total,
          createdAt: new Date(),
        },
        ticketLines,
        portalLink,
      )
    }
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
        // Delivery axis (whatsapp-qr-delivery) — the receipt CTA sends this portal link; a fresh
        // sale is "pendiente de enviar" (nothing sent/viewed yet).
        portal_link: portalLink ?? null,
        tickets_sent_at: null,
        tickets_viewed_at: null,
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
          line_type: line.lineType,
          service_id: line.serviceId,
          slot_id: line.slotId,
          service_name: line.serviceName,
          slot_date: line.slotDate,
          slot_start_time: line.slotStartTime,
          // Lodging stay fields (null for a tour line).
          unit_type_id: line.unitTypeId ?? null,
          check_in: line.checkIn ?? null,
          check_out: line.checkOut ?? null,
          guests: line.guests ?? null,
          nights: line.nights ?? null,
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
  apiBaseUrl: string,
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
      ticketsSentAt: folios.ticketsSentAt,
      ticketsViewedAt: folios.ticketsViewedAt,
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
      zoneName: folioLines.zoneName,
      quantity: folioLines.quantity,
      basePrice: folioLines.basePrice,
      minimumPrice: folioLines.minimumPrice,
      unitPrice: folioLines.unitPrice,
      lineTotal: folioLines.lineTotal,
      qrToken: folioLines.qrToken,
      lineType: folioLines.lineType,
      unitTypeId: folioLines.unitTypeId,
      checkIn: folioLines.checkIn,
      checkOut: folioLines.checkOut,
      guests: folioLines.guests,
      nights: folioLines.nights,
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
        line_type: line.lineType,
        service_id: line.serviceId,
        slot_id: line.slotId,
        service_name: line.serviceName,
        slot_date: line.slotDate,
        slot_start_time: line.slotStartTime,
        // US-A64 — the physical zone (null for an unzoned or lodging line).
        zone_name: line.zoneName,
        // Lodging stay fields (null for a tour line).
        unit_type_id: line.unitTypeId,
        check_in: line.checkIn,
        check_out: line.checkOut,
        guests: line.guests,
        nights: line.nights,
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

  const portalLink = await folioPortalLink(db, org, folioId, apiBaseUrl)

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
    // Delivery axis (whatsapp-qr-delivery) — portal_link drives the WhatsApp send; sent/viewed
    // stamps drive the Pendiente → Enviado → Visto badge.
    portal_link: portalLink,
    tickets_sent_at: folio.ticketsSentAt ? Math.floor(folio.ticketsSentAt.getTime() / 1000) : null,
    tickets_viewed_at: folio.ticketsViewedAt
      ? Math.floor(folio.ticketsViewedAt.getTime() / 1000)
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
    c.env.API_BASE_URL,
  )
  if (!folio) {
    throw new ApiError('NOT_FOUND', 404, 'Folio not found')
  }

  return c.json({ folio })
}

// POST /pos/folios/:id/ticket-delivery — the seller records that they sent the tickets over
// WhatsApp (whatsapp-qr-delivery D4). Clears "Pendiente de enviar". D13 — simple idempotent mark
// (last-write-wins: a re-send restamps who/when, no atomic claim). Scoped to the caller's own folio.
export const markTicketsSent = async (c: PosContext) => {
  const agent = c.get('user')
  const id = c.req.param('id')
  const db = getDb(c.env)
  const now = new Date()

  const updated = await db
    .update(folios)
    .set({ ticketsSentAt: now, ticketsSentBy: agent.userId, updatedAt: now })
    .where(
      and(
        eq(folios.id, id),
        eq(folios.organizationId, agent.organizationId),
        eq(folios.agentId, agent.userId),
      ),
    )
    .returning({ sentAt: folios.ticketsSentAt, viewedAt: folios.ticketsViewedAt })

  const row = updated[0]
  if (!row) throw new ApiError('NOT_FOUND', 404, 'Folio not found')
  return c.json({
    tickets_sent_at: row.sentAt ? Math.floor(row.sentAt.getTime() / 1000) : null,
    tickets_viewed_at: row.viewedAt ? Math.floor(row.viewedAt.getTime() / 1000) : null,
  })
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
  // US-A66 — ticket expiry below is measured in the org's time zone.
  const { tz } = await loadOrgTiming(db, org)

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
      checkIn: folioLines.checkIn,
      checkOut: folioLines.checkOut,
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

  // Sign the per-line tickets now (the booking had none) — SLOT lines only; a lodging stay line
  // has no scannable QR (its access is the reservation).
  const slotLineRows = lineRows.filter((l) => l.slotId && l.slotDate)
  const identity =
    folio.customerName?.trim() || folio.customerEmail?.trim() || `folio:${id}`
  const tickets = await signLineTickets(
    c.env,
    org,
    id,
    identity,
    slotLineRows.map((l) => ({
      id: l.id,
      serviceId: l.serviceId,
      slotId: l.slotId!,
      quantity: l.quantity,
      slotDate: l.slotDate!,
    })),
    tz,
  )

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
  for (const line of slotLineRows) {
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
    // Slot dates, plus a stay's checkout as its last date; drop nulls.
    lineRows.map((l) => l.slotDate ?? l.checkOut ?? l.checkIn).filter((d): d is string => !!d),
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
    orgRows[0]?.name ?? 'Turistear Ya!',
    id,
    {
      customerEmail: folio.customerEmail,
      customerName: folio.customerName,
      paymentMethod: folio.paymentMethod,
      total: folio.total,
      createdAt: new Date(),
    },
    // Access-ticket lines are slot lines only (a stay has no per-line QR).
    slotLineRows.map((line) => ({
      serviceName: line.serviceName,
      slotDate: line.slotDate!,
      slotStartTime: line.slotStartTime!,
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

  const settled = await readFolio(db, org, agent.userId, id, c.env.QR_SECRET, c.env.API_BASE_URL)
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
    .select({
      slotId: folioLines.slotId,
      quantity: folioLines.quantity,
      zoneId: folioLines.zoneId,
    })
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
    if (!line.slotId) continue
    if (line.zoneId) {
      // US-A64 — release the seats to the zone counter, then reconcile the slot totals.
      statements.push(
        db
          .update(slotZones)
          .set({ booked: sql`${slotZones.booked} - ${line.quantity}`, updatedAt: new Date() })
          .where(
            and(
              eq(slotZones.slotId, line.slotId),
              eq(slotZones.zoneId, line.zoneId),
              eq(slotZones.organizationId, org),
            ),
          ),
        reconcileSlotTotals(db, line.slotId),
      )
    } else {
      statements.push(
        db
          .update(slots)
          .set({ booked: sql`${slots.booked} - ${line.quantity}`, updatedAt: new Date() })
          .where(and(eq(slots.id, line.slotId), eq(slots.organizationId, org))),
      )
    }
  }
  // Lodging: release the stay's dates by cancelling its active reservations (frees inventory,
  // mirroring the slot re-increment). Deposit stays non-refundable (D7), set above.
  statements.push(
    db
      .update(accommodationReservations)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(
        and(
          eq(accommodationReservations.folioId, id),
          eq(accommodationReservations.organizationId, org),
          eq(accommodationReservations.status, 'active'),
        ),
      ),
  )
  await db.batch(statements as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]])

  const updated = await readFolio(db, org, agent.userId, id, c.env.QR_SECRET, c.env.API_BASE_URL)
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
      zoneId: folioLines.zoneId,
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
      timezone: organizations.timezone,
    })
    .from(organizations)
    .where(eq(organizations.id, org))
    .limit(1)
  const policy = resolveBookingPolicy({
    bookingMinDownPaymentPct: orgRows[0]?.bookingMinDownPaymentPct ?? 0,
    bookingHoldDays: orgRows[0]?.bookingHoldDays ?? 7,
    bookingGraceOffsetMinutes: orgRows[0]?.bookingGraceOffsetMinutes ?? 15,
  })
  // US-A66 — the cutoff guard + fresh same-day expiry below resolve in the org's time zone.
  const tz = orgRows[0]?.timezone ?? 'America/Mexico_City'

  // US-A47 — don't reactivate onto a slot whose departure has passed the sales cutoff (that
  // would re-create an already-expired booking). Guard BEFORE re-blocking any spots.
  const reactivateNowSec = Math.floor(Date.now() / 1000)
  const salesCutoffOffset = orgRows[0]?.salesCutoffOffsetMinutes ?? 0
  for (const line of lineRows) {
    if (
      !isSlotSellable(line.slotDate, line.slotStartTime, reactivateNowSec, salesCutoffOffset, tz)
    ) {
      throw new ApiError(
        'SLOT_CLOSED',
        409,
        'This booking’s departure has passed the sales cutoff and cannot be reactivated',
      )
    }
  }

  // Re-decrement each slot atomically with the effective-capacity guard; compensate on failure.
  // US-A64 — a zoned line re-blocks its OWN zone counter (a competing sale may have filled it while
  // this booking was cancelled → 409, same as a filled tour); others re-block the raw slot.
  const applied: { slotId: string; qty: number; zoneId?: string | null }[] = []
  const revertApplied = async () => {
    for (const a of applied) {
      if (a.zoneId) {
        await db
          .update(slotZones)
          .set({ booked: sql`${slotZones.booked} - ${a.qty}`, updatedAt: new Date() })
          .where(
            and(
              eq(slotZones.slotId, a.slotId),
              eq(slotZones.zoneId, a.zoneId),
              eq(slotZones.organizationId, org),
            ),
          )
        await reconcileSlotTotals(db, a.slotId)
      } else {
        await db
          .update(slots)
          .set({ booked: sql`${slots.booked} - ${a.qty}`, updatedAt: new Date() })
          .where(and(eq(slots.id, a.slotId), eq(slots.organizationId, org)))
      }
    }
  }
  for (const line of lineRows) {
    if (line.zoneId) {
      const decremented = await db
        .update(slotZones)
        .set({ booked: sql`${slotZones.booked} + ${line.quantity}`, updatedAt: new Date() })
        .where(
          and(
            eq(slotZones.slotId, line.slotId),
            eq(slotZones.zoneId, line.zoneId),
            eq(slotZones.organizationId, org),
            eq(slotZones.status, 'active'),
            gte(sql`${slotZones.capacity} - ${slotZones.booked}`, line.quantity),
          ),
        )
        .returning({ id: slotZones.id })
      if (decremented.length === 0) {
        await revertApplied()
        throw new ApiError(
          'NO_CAPACITY_AVAILABLE',
          409,
          'No hay cupo disponible para reactivar este apartado',
        )
      }
      await reconcileSlotTotals(db, line.slotId)
      applied.push({ slotId: line.slotId, qty: line.quantity, zoneId: line.zoneId })
      continue
    }

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
      await revertApplied()
      throw new ApiError(
        'NO_CAPACITY_AVAILABLE',
        409,
        'No hay cupo disponible para reactivar este apartado',
      )
    }
    applied.push({ slotId: line.slotId, qty: line.quantity })
  }

  // Lodging: re-claim each cancelled stay reservation under the SAME per-night count guard as
  // the sale (D10 — competing bookings may have consumed the inventory while this one was
  // expired). The lineRows above inner-join slots, so stays are queried separately here. The
  // guard excludes the row being revived (o.id != ?) and re-checks every night of its range.
  // On conflict → compensate (revert slots + re-cancel any already-reactivated stays) and 409.
  const stayReservations = await db
    .select({
      id: accommodationReservations.id,
      unitTypeId: accommodationReservations.unitTypeId,
      quantity: accommodationReservations.quantity,
      checkIn: accommodationReservations.checkIn,
      checkOut: accommodationReservations.checkOut,
    })
    .from(accommodationReservations)
    .where(
      and(
        eq(accommodationReservations.folioId, id),
        eq(accommodationReservations.organizationId, org),
        eq(accommodationReservations.status, 'cancelled'),
      ),
    )
  const reactivatedReservations: string[] = []
  for (const r of stayReservations) {
    const upd = await c.env.DB.prepare(
      `UPDATE accommodation_reservations
         SET status = 'active', updated_at = unixepoch()
       WHERE id = ? AND organization_id = ? AND status = 'cancelled'
         AND NOT EXISTS (
           WITH RECURSIVE nights(d) AS (
             SELECT ?
             UNION ALL
             SELECT date(d, '+1 day') FROM nights WHERE date(d, '+1 day') < ?
           )
           SELECT 1 FROM nights n
           WHERE COALESCE((SELECT SUM(o.quantity) FROM accommodation_reservations o
                           WHERE o.unit_type_id = ? AND o.status = 'active' AND o.id != ?
                             AND o.check_in <= n.d AND n.d < o.check_out), 0)
               + COALESCE((SELECT SUM(b.quantity) FROM accommodation_blockouts b
                           WHERE b.unit_type_id = ?
                             AND b.start_date <= n.d AND n.d < b.end_date), 0)
               + ?
               > (SELECT t.inventory_count FROM accommodation_unit_types t WHERE t.id = ?)
         )`,
    )
      .bind(
        r.id,
        org,
        r.checkIn,
        r.checkOut,
        r.unitTypeId,
        r.id,
        r.unitTypeId,
        r.quantity,
        r.unitTypeId,
      )
      .run()
    if (!upd.meta.changes) {
      await revertApplied()
      for (const rid of reactivatedReservations) {
        await db
          .update(accommodationReservations)
          .set({ status: 'cancelled', updatedAt: new Date() })
          .where(and(eq(accommodationReservations.id, rid), eq(accommodationReservations.organizationId, org)))
      }
      throw new ApiError(
        'INSUFFICIENT_INVENTORY',
        409,
        'Esas fechas ya no están disponibles para reactivar el apartado',
      )
    }
    reactivatedReservations.push(r.id)
  }

  // Fresh expiry from the current org policy (read above) + earliest departure — a slot start or a
  // stay check-in (midnight), whichever comes first across the cart.
  const departures: { epoch: number; date: string }[] = [
    ...lineRows.map((l) => ({ epoch: slotEpoch(l.slotDate, l.slotStartTime, tz), date: l.slotDate })),
    ...stayReservations.map((r) => ({ epoch: slotEpoch(r.checkIn!, '00:00', tz), date: r.checkIn! })),
  ]
  const earliest = departures.reduce(
    (min, d) => (d.epoch < min.epoch ? d : min),
    { epoch: Infinity, date: '' },
  )
  const bookingExpiresAt = bookingExpiryDate(
    policy,
    reactivateNowSec,
    earliest.epoch,
    earliest.date === orgToday(tz),
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

  const updated = await readFolio(db, org, agent.userId, id, c.env.QR_SECRET, c.env.API_BASE_URL)
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
      ticketsSentAt: folios.ticketsSentAt,
      ticketsViewedAt: folios.ticketsViewedAt,
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
      // Delivery axis (whatsapp-qr-delivery) — a paid folio is "deliverable" (a portal token
      // exists); the sent/viewed stamps drive the Pendiente → Enviado → Visto list badge.
      deliverable: r.status === 'paid',
      tickets_sent_at: r.ticketsSentAt ? Math.floor(r.ticketsSentAt.getTime() / 1000) : null,
      tickets_viewed_at: r.ticketsViewedAt ? Math.floor(r.ticketsViewedAt.getTime() / 1000) : null,
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
