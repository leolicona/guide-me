import { and, asc, eq, gte, lte, ne } from 'drizzle-orm'
import { getDb } from '../../db/client'
import { schedules, slots } from '../../db/schema'
import { ApiError } from '../../types/errors'
import { datesInRangeMatchingWeekdays } from './slots.dates'
import { requireService, type ServicesContext } from './handler'
import type {
  CreateScheduleInput,
  CreateSlotInput,
  UpdateSlotInput,
} from './slots.schema'

// --- Serializers: DB columns → API shape (snake_case, derived `remaining`) ---

interface SlotRow {
  id: string
  serviceId: string
  scheduleId: string | null
  date: string
  startTime: string
  capacity: number
  booked: number
  status: string
}

interface ScheduleRow {
  id: string
  serviceId: string
  recurrence: string
  weekdays: string
  startTime: string
  capacity: number
  startDate: string
  endDate: string
  status: string
}

const serializeSlot = (row: SlotRow) => ({
  id: row.id,
  service_id: row.serviceId,
  schedule_id: row.scheduleId,
  date: row.date,
  start_time: row.startTime,
  capacity: row.capacity,
  booked: row.booked,
  remaining: row.capacity - row.booked,
  status: row.status,
})

const serializeSchedule = (row: ScheduleRow) => ({
  id: row.id,
  service_id: row.serviceId,
  recurrence: row.recurrence,
  weekdays: row.weekdays.split(',').map(Number),
  start_time: row.startTime,
  capacity: row.capacity,
  start_date: row.startDate,
  end_date: row.endDate,
  status: row.status,
})

const slotColumns = {
  id: slots.id,
  serviceId: slots.serviceId,
  scheduleId: slots.scheduleId,
  date: slots.date,
  startTime: slots.startTime,
  capacity: slots.capacity,
  booked: slots.booked,
  status: slots.status,
} as const

const scheduleColumns = {
  id: schedules.id,
  serviceId: schedules.serviceId,
  recurrence: schedules.recurrence,
  weekdays: schedules.weekdays,
  startTime: schedules.startTime,
  capacity: schedules.capacity,
  startDate: schedules.startDate,
  endDate: schedules.endDate,
  status: schedules.status,
} as const

// D1 caps bound parameters per statement (~100). Each materialized slot row
// binds 7 columns, so keep bulk inserts well under the limit.
const INSERT_CHUNK = 12

// Is there already an ACTIVE slot for this service at this date/time?
// `excludeSlotId` lets an edit/reactivate ignore the row being changed.
const activeSlotExists = async (
  db: ReturnType<typeof getDb>,
  organizationId: string,
  serviceId: string,
  date: string,
  startTime: string,
  excludeSlotId?: string,
): Promise<boolean> => {
  const filters = [
    eq(slots.organizationId, organizationId),
    eq(slots.serviceId, serviceId),
    eq(slots.date, date),
    eq(slots.startTime, startTime),
    eq(slots.status, 'active'),
  ]
  if (excludeSlotId) {
    filters.push(ne(slots.id, excludeSlotId))
  }

  const rows = await db
    .select({ id: slots.id })
    .from(slots)
    .where(and(...filters))
    .limit(1)

  return rows.length > 0
}

// --- Specific-date slots ---

// US-A10 — create one one-off slot (schedule_id = null). organizationId from
// context (Rule 3); capacity defaults to the parent service's default_capacity.
export const createSlot = async (c: ServicesContext) => {
  const admin = c.get('user')
  const serviceId = c.req.param('id')
  const input = (await c.req.json()) as CreateSlotInput
  const db = getDb(c.env)

  const service = await requireService(db, admin.organizationId, serviceId)
  const capacity = input.capacity ?? service.defaultCapacity

  if (
    await activeSlotExists(
      db,
      admin.organizationId,
      serviceId,
      input.date,
      input.start_time,
    )
  ) {
    throw new ApiError(
      'CONFLICT',
      409,
      'A slot already exists for this service at that date and time',
    )
  }

  const result = await db
    .insert(slots)
    .values({
      id: crypto.randomUUID(),
      organizationId: admin.organizationId,
      serviceId,
      scheduleId: null,
      date: input.date,
      startTime: input.start_time,
      capacity,
      booked: 0,
      status: 'active',
    })
    .returning(slotColumns)

  return c.json({ slot: serializeSlot(result[0]) }, 201)
}

// US-A10 — list a service's slots, ordered by date then time. Default active;
// ?status=inactive|all widens; optional ?from / ?to date-range filter.
export const listSlots = async (c: ServicesContext) => {
  const admin = c.get('user')
  const serviceId = c.req.param('id')
  const db = getDb(c.env)

  await requireService(db, admin.organizationId, serviceId)

  const filters = [
    eq(slots.organizationId, admin.organizationId),
    eq(slots.serviceId, serviceId),
  ]

  const statusParam = c.req.query('status')
  if (statusParam === 'all') {
    // no status filter
  } else if (statusParam === 'inactive') {
    filters.push(eq(slots.status, 'inactive'))
  } else {
    filters.push(eq(slots.status, 'active'))
  }

  const from = c.req.query('from')
  if (from) filters.push(gte(slots.date, from))
  const to = c.req.query('to')
  if (to) filters.push(lte(slots.date, to))

  const rows = await db
    .select(slotColumns)
    .from(slots)
    .where(and(...filters))
    .orderBy(asc(slots.date), asc(slots.startTime))

  return c.json({ slots: rows.map(serializeSlot) })
}

// US-A10 — edit a slot (full replace of date/time/capacity). Triple filter
// (slotId + serviceId + org) → 404. Guards capacity ≥ booked and time collisions.
export const updateSlot = async (c: ServicesContext) => {
  const admin = c.get('user')
  const serviceId = c.req.param('id')
  const slotId = c.req.param('slotId')
  const input = (await c.req.json()) as UpdateSlotInput
  const db = getDb(c.env)

  const existing = await db
    .select(slotColumns)
    .from(slots)
    .where(
      and(
        eq(slots.id, slotId),
        eq(slots.serviceId, serviceId),
        eq(slots.organizationId, admin.organizationId),
      ),
    )
    .limit(1)

  const slot = existing[0]
  if (!slot) {
    throw new ApiError('NOT_FOUND', 404, 'Slot not found')
  }

  if (input.capacity < slot.booked) {
    throw new ApiError(
      'CONFLICT',
      409,
      'Capacity may not be lower than already-booked spots',
    )
  }

  if (
    await activeSlotExists(
      db,
      admin.organizationId,
      serviceId,
      input.date,
      input.start_time,
      slotId,
    )
  ) {
    throw new ApiError(
      'CONFLICT',
      409,
      'Another slot already occupies that date and time',
    )
  }

  const result = await db
    .update(slots)
    .set({
      date: input.date,
      startTime: input.start_time,
      capacity: input.capacity,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(slots.id, slotId),
        eq(slots.serviceId, serviceId),
        eq(slots.organizationId, admin.organizationId),
      ),
    )
    .returning(slotColumns)

  return c.json({ slot: serializeSlot(result[0]) })
}

// Soft (de)activation. Triple filter → 404; reactivate is rejected if another
// active slot already occupies the same date/time. Idempotent.
const setSlotStatus = async (
  c: ServicesContext,
  status: 'active' | 'inactive',
) => {
  const admin = c.get('user')
  const serviceId = c.req.param('id')
  const slotId = c.req.param('slotId')
  const db = getDb(c.env)

  const existing = await db
    .select(slotColumns)
    .from(slots)
    .where(
      and(
        eq(slots.id, slotId),
        eq(slots.serviceId, serviceId),
        eq(slots.organizationId, admin.organizationId),
      ),
    )
    .limit(1)

  const slot = existing[0]
  if (!slot) {
    throw new ApiError('NOT_FOUND', 404, 'Slot not found')
  }

  if (
    status === 'active' &&
    (await activeSlotExists(
      db,
      admin.organizationId,
      serviceId,
      slot.date,
      slot.startTime,
      slotId,
    ))
  ) {
    throw new ApiError(
      'CONFLICT',
      409,
      'Another active slot already occupies that date and time',
    )
  }

  const result = await db
    .update(slots)
    .set({ status, updatedAt: new Date() })
    .where(
      and(
        eq(slots.id, slotId),
        eq(slots.serviceId, serviceId),
        eq(slots.organizationId, admin.organizationId),
      ),
    )
    .returning(slotColumns)

  return c.json({ slot: serializeSlot(result[0]) })
}

export const deactivateSlot = (c: ServicesContext) =>
  setSlotStatus(c, 'inactive')

export const reactivateSlot = (c: ServicesContext) => setSlotStatus(c, 'active')

// --- Recurring schedules ---

// US-A10 — create a weekly schedule and materialize its slots over the bounded
// window, skipping dates already holding an active slot at that time.
export const createSchedule = async (c: ServicesContext) => {
  const admin = c.get('user')
  const serviceId = c.req.param('id')
  const input = (await c.req.json()) as CreateScheduleInput
  const db = getDb(c.env)

  const service = await requireService(db, admin.organizationId, serviceId)
  const capacity = input.capacity ?? service.defaultCapacity

  const scheduleId = crypto.randomUUID()
  const scheduleResult = await db
    .insert(schedules)
    .values({
      id: scheduleId,
      organizationId: admin.organizationId,
      serviceId,
      recurrence: 'weekly',
      weekdays: input.weekdays.join(','),
      startTime: input.start_time,
      capacity,
      startDate: input.start_date,
      endDate: input.end_date,
      status: 'active',
    })
    .returning(scheduleColumns)

  // Candidate dates, minus those already occupied by an active slot at this time.
  const candidates = datesInRangeMatchingWeekdays(
    input.start_date,
    input.end_date,
    input.weekdays,
  )

  const occupied = new Set(
    (
      await db
        .select({ date: slots.date })
        .from(slots)
        .where(
          and(
            eq(slots.organizationId, admin.organizationId),
            eq(slots.serviceId, serviceId),
            eq(slots.startTime, input.start_time),
            eq(slots.status, 'active'),
          ),
        )
    ).map((r) => r.date),
  )

  const rows = candidates
    .filter((date) => !occupied.has(date))
    .map((date) => ({
      id: crypto.randomUUID(),
      organizationId: admin.organizationId,
      serviceId,
      scheduleId,
      date,
      startTime: input.start_time,
      capacity,
      booked: 0,
      status: 'active' as const,
    }))

  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    await db.insert(slots).values(rows.slice(i, i + INSERT_CHUNK))
  }

  return c.json(
    {
      schedule: serializeSchedule(scheduleResult[0]),
      slots_generated: rows.length,
    },
    201,
  )
}

// US-A10 — list a service's schedules, ordered by start_date. Optional ?status.
export const listSchedules = async (c: ServicesContext) => {
  const admin = c.get('user')
  const serviceId = c.req.param('id')
  const db = getDb(c.env)

  await requireService(db, admin.organizationId, serviceId)

  const filters = [
    eq(schedules.organizationId, admin.organizationId),
    eq(schedules.serviceId, serviceId),
  ]

  const status = c.req.query('status')
  if (status === 'active' || status === 'inactive') {
    filters.push(eq(schedules.status, status))
  }

  const rows = await db
    .select(scheduleColumns)
    .from(schedules)
    .where(and(...filters))
    .orderBy(asc(schedules.startDate))

  return c.json({ schedules: rows.map(serializeSchedule) })
}

// US-A10 — deactivate a schedule and cascade-close only its unbooked slots.
// Triple filter (scheduleId + serviceId + org) → 404. Idempotent.
export const deactivateSchedule = async (c: ServicesContext) => {
  const admin = c.get('user')
  const serviceId = c.req.param('id')
  const scheduleId = c.req.param('scheduleId')
  const db = getDb(c.env)

  const result = await db
    .update(schedules)
    .set({ status: 'inactive', updatedAt: new Date() })
    .where(
      and(
        eq(schedules.id, scheduleId),
        eq(schedules.serviceId, serviceId),
        eq(schedules.organizationId, admin.organizationId),
      ),
    )
    .returning({ id: schedules.id, status: schedules.status })

  const schedule = result[0]
  if (!schedule) {
    throw new ApiError('NOT_FOUND', 404, 'Schedule not found')
  }

  // Close only slots with no bookings; booked slots stay active so their folios
  // remain honorable (spec business rule 4).
  const closed = await db
    .update(slots)
    .set({ status: 'inactive', updatedAt: new Date() })
    .where(
      and(
        eq(slots.organizationId, admin.organizationId),
        eq(slots.serviceId, serviceId),
        eq(slots.scheduleId, scheduleId),
        eq(slots.status, 'active'),
        eq(slots.booked, 0),
      ),
    )
    .returning({ id: slots.id })

  return c.json({ schedule, slots_closed: closed.length })
}
