import type { Context } from 'hono'
import { and, eq, gte, inArray, lte, sql } from 'drizzle-orm'
import { getDb } from '../../db/client'
import {
  affiliateOperators,
  folioLines,
  folioPayments,
  folios,
  organizations,
  services,
  slots,
} from '../../db/schema'
import { users } from '../../db/schema'
import type { AppVariables } from '../../types/context'
import { naiveEpoch, orgToday } from '../../utils/tz'
import type { DashboardDayQuery } from './schema'

export type DashboardContext = Context<{
  Bindings: CloudflareBindings
  Variables: AppVariables
}>

// A line is counted by its OWN money state (line-autonomy): the sum of its allocations against
// its line_total. Outer columns are written raw inside the correlated subquery — an interpolated
// `${folioLines.id}` would resolve in the subquery's scope and correlate to nothing
// (utils/folioStatus.ts:4-7).
const lineAllocated = `coalesce((select sum(a.amount) from folio_payment_allocations a where a.folio_line_id = folio_lines.id), 0)`

// GET /api/dashboard/day — US-A14/A15/A16/A90 (docs/dashboard/occupancy-dashboard.spec.md).
// One org-scoped read for the admin's Hoy: the day's departures with the vendidos/apartados seat
// split, today's departed slots with their boarding, and the day's money as the ledger stamped it.
export const getDashboardDay = async (c: DashboardContext) => {
  const admin = c.get('user')
  const org = admin.organizationId
  const db = getDb(c.env)
  const { date } = c.req.valid('query' as never) as DashboardDayQuery

  const [orgRow] = await db
    .select({ tz: organizations.timezone })
    .from(organizations)
    .where(eq(organizations.id, org))
    .limit(1)
  const tz = orgRow?.tz ?? 'America/Mexico_City'
  const today = orgToday(tz)
  const day = date ?? today
  const isToday = day === today

  // Rule 2 — the day's active departures, chronological (D15). The service row is joined for the
  // name and the flex-cap config; a paused service's slot still departs today, so no status filter.
  const slotRows = await db
    .select({
      slotId: slots.id,
      serviceId: slots.serviceId,
      serviceName: services.name,
      startTime: slots.startTime,
      capacity: slots.capacity,
      booked: slots.booked,
      isFlexible: services.isFlexible,
      flexPct: services.flexCapacityPct,
    })
    .from(slots)
    .innerJoin(services, eq(slots.serviceId, services.id))
    .where(and(eq(slots.organizationId, org), eq(slots.date, day), eq(slots.status, 'active')))
    .orderBy(slots.startTime)

  // Rule 3 — seats by the lines' derived money state; rule 4's boarding rides the same pass.
  const slotIds = slotRows.map((r) => r.slotId)
  const lineAgg = slotIds.length
    ? await db
        .select({
          slotId: folioLines.slotId,
          vendidos: sql<number>`coalesce(sum(case when folio_lines.cancelled_at is null and ${sql.raw(lineAllocated)} >= folio_lines.line_total then folio_lines.quantity else 0 end), 0)`,
          apartados: sql<number>`coalesce(sum(case when folio_lines.cancelled_at is null and ${sql.raw(lineAllocated)} < folio_lines.line_total then folio_lines.quantity else 0 end), 0)`,
          abordaron: sql<number>`coalesce(sum(case when folio_lines.cancelled_at is null and ${sql.raw(lineAllocated)} >= folio_lines.line_total then folio_lines.redeemed_count else 0 end), 0)`,
        })
        .from(folioLines)
        .where(and(eq(folioLines.organizationId, org), inArray(folioLines.slotId, slotIds)))
        .groupBy(folioLines.slotId)
    : []
  const bySlot = new Map(lineAgg.map((r) => [r.slotId, r]))

  const nowMs = Date.now()
  const occupancy: Array<Record<string, unknown>> = []
  const departed: Array<Record<string, unknown>> = []
  for (const r of slotRows) {
    const agg = bySlot.get(r.slotId)
    const vendidos = Number(agg?.vendidos ?? 0)
    const apartados = Number(agg?.apartados ?? 0)
    // Rule 4 — departed only exists for the org's today; sales-cutoff offsets are display-irrelevant.
    if (isToday && naiveEpoch(day, r.startTime, tz) * 1000 <= nowMs) {
      const abordaron = Number(agg?.abordaron ?? 0)
      departed.push({
        slot_id: r.slotId,
        service_name: r.serviceName,
        start_time: r.startTime,
        vendidos,
        abordaron,
        sin_usar: Math.max(0, vendidos - abordaron),
      })
    } else {
      const flexMargin = Math.floor((r.capacity * (r.flexPct ?? 0)) / 100)
      occupancy.push({
        slot_id: r.slotId,
        service_id: r.serviceId,
        service_name: r.serviceName,
        start_time: r.startTime,
        capacity: r.capacity,
        booked: r.booked,
        remaining: Math.max(0, r.capacity - r.booked),
        vendidos,
        apartados,
        is_flexible: Boolean(r.isFlexible),
        flex_extra: r.isFlexible ? Math.max(0, flexMargin - Math.max(0, r.booked - r.capacity)) : 0,
      })
    }
  }

  // Rules 5–7 — the day's money by the ledger's own dates (D10): net payment/refund rows stamped
  // inside the org-tz day. Commission accruals are excluded; verification state is ignored (D16).
  const nextDay = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
  const windowStart = new Date(naiveEpoch(day, '00:00', tz) * 1000)
  const windowEnd = new Date(naiveEpoch(nextDay, '00:00', tz) * 1000 - 1000)
  const moneyWhere = and(
    eq(folioPayments.organizationId, org),
    inArray(folioPayments.entryType, ['payment', 'refund']),
    gte(folioPayments.createdAt, windowStart),
    lte(folioPayments.createdAt, windowEnd),
  )

  const [collectedRows, foliosRows, sellerRows] = await Promise.all([
    db
      .select({ total: sql<number>`coalesce(sum(${folioPayments.amount}), 0)` })
      .from(folioPayments)
      .where(moneyWhere),
    db
      .select({ n: sql<number>`count(*)` })
      .from(folios)
      .where(
        and(
          eq(folios.organizationId, org),
          gte(folios.createdAt, windowStart),
          lte(folios.createdAt, windowEnd),
        ),
      ),
    db
      .select({
        userId: folioPayments.collectedBy,
        name: users.name,
        operatorName: affiliateOperators.name,
        total: sql<number>`coalesce(sum(${folioPayments.amount}), 0)`,
      })
      .from(folioPayments)
      .leftJoin(users, eq(users.id, folioPayments.collectedBy))
      .leftJoin(affiliateOperators, eq(affiliateOperators.id, folioPayments.operatorId))
      .where(moneyWhere)
      .groupBy(folioPayments.collectedBy, folioPayments.operatorId),
  ])

  const perSeller = sellerRows
    .map((r) => ({
      user_id: r.userId,
      name: r.name ?? 'Desconocido',
      operator_name: r.operatorName ?? null,
      collected_cents: Number(r.total ?? 0),
    }))
    .filter((r) => r.collected_cents !== 0)
    .sort((a, b) => b.collected_cents - a.collected_cents)

  return c.json({
    date: day,
    occupancy,
    departed,
    sales: {
      collected_cents: Number(collectedRows[0]?.total ?? 0),
      folios_created: Number(foliosRows[0]?.n ?? 0),
      per_seller: perSeller,
    },
  })
}
