import type { Context } from 'hono'
import { and, asc, eq } from 'drizzle-orm'
import { getDb } from '../../db/client'
import { serviceExtras, services } from '../../db/schema'
import { ApiError } from '../../types/errors'
import type { AppVariables } from '../../types/context'
import type {
  CreateExtraInput,
  CreateServiceInput,
  UpdateExtraInput,
  UpdateServiceInput,
} from './schema'

export type ServicesContext = Context<{
  Bindings: CloudflareBindings
  Variables: AppVariables
}>

// --- Serializers: DB columns → API shape (snake_case money/capacity fields).
// commission_value is basis points when commission_type='percent', minor units per spot when
// 'fixed' — see services schema / docs/commissions/service-based-commission.spec.md. ---

interface ServiceRow {
  id: string
  name: string
  description: string | null
  basePrice: number
  minimumPrice: number
  defaultCapacity: number
  commissionType: 'percent' | 'fixed'
  commissionValue: number
  isFlexible: boolean
  flexCapacityPct: number
  category: 'lodging' | 'tours' | 'dining' | 'adventure' | 'culture' | null
  status: string
}

interface ExtraRow {
  id: string
  name: string
  price: number
  status: string
}

const serializeExtra = (row: ExtraRow) => ({
  id: row.id,
  name: row.name,
  price: row.price,
  status: row.status,
})

const serializeService = (
  row: ServiceRow,
  extras?: ExtraRow[],
) => ({
  id: row.id,
  name: row.name,
  description: row.description,
  base_price: row.basePrice,
  minimum_price: row.minimumPrice,
  default_capacity: row.defaultCapacity,
  commission_type: row.commissionType,
  commission_value: row.commissionValue,
  is_flexible: row.isFlexible,
  flex_capacity_pct: row.flexCapacityPct,
  category: row.category,
  status: row.status,
  ...(extras !== undefined ? { extras: extras.map(serializeExtra) } : {}),
})

const serviceColumns = {
  id: services.id,
  name: services.name,
  description: services.description,
  basePrice: services.basePrice,
  minimumPrice: services.minimumPrice,
  defaultCapacity: services.defaultCapacity,
  commissionType: services.commissionType,
  commissionValue: services.commissionValue,
  isFlexible: services.isFlexible,
  flexCapacityPct: services.flexCapacityPct,
  category: services.category,
  status: services.status,
} as const

const extraColumns = {
  id: serviceExtras.id,
  name: serviceExtras.name,
  price: serviceExtras.price,
  status: serviceExtras.status,
} as const

// Re-read a service's extras (org-scoped, ordered by name) for the detail shape.
const readExtras = (db: ReturnType<typeof getDb>, organizationId: string, serviceId: string) =>
  db
    .select(extraColumns)
    .from(serviceExtras)
    .where(
      and(
        eq(serviceExtras.serviceId, serviceId),
        eq(serviceExtras.organizationId, organizationId),
      ),
    )
    .orderBy(asc(serviceExtras.name))

// US-A09 — create a service. organizationId + status come from context (Rule 3),
// never the body.
export const createService = async (c: ServicesContext) => {
  const admin = c.get('user')
  const input = (await c.req.json()) as CreateServiceInput
  const db = getDb(c.env)

  const result = await db
    .insert(services)
    .values({
      id: crypto.randomUUID(),
      organizationId: admin.organizationId,
      name: input.name,
      description: input.description ?? null,
      basePrice: input.base_price,
      minimumPrice: input.minimum_price,
      defaultCapacity: input.default_capacity,
      commissionType: input.commission_type ?? 'percent',
      commissionValue: input.commission_value ?? 0,
      isFlexible: input.is_flexible ?? false,
      // US-A36 — a Hard Cap service stores 0 tolerance regardless of any value sent.
      flexCapacityPct: input.is_flexible ? (input.flex_capacity_pct ?? 0) : 0,
      // US-A37 — required category (the schema rejects a category-less create).
      category: input.category,
      status: 'active',
    })
    .returning(serviceColumns)

  return c.json({ service: serializeService(result[0], []) }, 201)
}

// List the caller org's services, ordered by name. Optional ?status filter.
// Returns no `extras` key (list view).
export const listServices = async (c: ServicesContext) => {
  const admin = c.get('user')
  const status = c.req.query('status')
  const db = getDb(c.env)

  const filters = [eq(services.organizationId, admin.organizationId)]
  if (status === 'active' || status === 'inactive') {
    filters.push(eq(services.status, status))
  }

  const rows = await db
    .select(serviceColumns)
    .from(services)
    .where(and(...filters))
    .orderBy(asc(services.name))

  return c.json({ services: rows.map((row) => serializeService(row)) })
}

// US-A13 — service detail with its extras. The org filter makes unknown /
// foreign-org ids resolve to 404 without leaking existence.
export const getService = async (c: ServicesContext) => {
  const admin = c.get('user')
  const id = c.req.param('id')
  const db = getDb(c.env)

  const result = await db
    .select(serviceColumns)
    .from(services)
    .where(
      and(eq(services.id, id), eq(services.organizationId, admin.organizationId)),
    )
    .limit(1)

  const service = result[0]
  if (!service) {
    throw new ApiError('NOT_FOUND', 404, 'Service not found')
  }

  const extras = await readExtras(db, admin.organizationId, id)
  return c.json({ service: serializeService(service, extras) })
}

// US-A13 — full replace of the editable fields. status / organizationId are
// preserved (not in the SET). 0 rows matched → 404.
export const updateService = async (c: ServicesContext) => {
  const admin = c.get('user')
  const id = c.req.param('id')
  const input = (await c.req.json()) as UpdateServiceInput
  const db = getDb(c.env)

  const result = await db
    .update(services)
    .set({
      name: input.name,
      description: input.description ?? null,
      basePrice: input.base_price,
      minimumPrice: input.minimum_price,
      defaultCapacity: input.default_capacity,
      commissionType: input.commission_type ?? 'percent',
      commissionValue: input.commission_value ?? 0,
      isFlexible: input.is_flexible ?? false,
      // US-A36 — toggling back to Hard Cap clears the margin.
      flexCapacityPct: input.is_flexible ? (input.flex_capacity_pct ?? 0) : 0,
      // US-A37 — full-replace edit always re-sets the (required) category.
      category: input.category,
      updatedAt: new Date(),
    })
    .where(
      and(eq(services.id, id), eq(services.organizationId, admin.organizationId)),
    )
    .returning(serviceColumns)

  const service = result[0]
  if (!service) {
    throw new ApiError('NOT_FOUND', 404, 'Service not found')
  }

  const extras = await readExtras(db, admin.organizationId, id)
  return c.json({ service: serializeService(service, extras) })
}

// Soft (de)activation. The org filter makes unknown / foreign ids → 404;
// idempotent (re-applying the same status still matches the row).
const setServiceStatus = async (
  c: ServicesContext,
  status: 'active' | 'inactive',
) => {
  const admin = c.get('user')
  const id = c.req.param('id')
  const db = getDb(c.env)

  const result = await db
    .update(services)
    .set({ status, updatedAt: new Date() })
    .where(
      and(eq(services.id, id), eq(services.organizationId, admin.organizationId)),
    )
    .returning({ id: services.id, name: services.name, status: services.status })

  const service = result[0]
  if (!service) {
    throw new ApiError('NOT_FOUND', 404, 'Service not found')
  }

  return c.json({ service })
}

export const deactivateService = (c: ServicesContext) =>
  setServiceStatus(c, 'inactive')

export const reactivateService = (c: ServicesContext) =>
  setServiceStatus(c, 'active')

// Verify the parent service exists in the caller's org. Throws 404 otherwise.
// Returns the row's id + defaultCapacity so callers (e.g. slots) can seed
// per-slot capacity without a second query.
export const requireService = async (
  db: ReturnType<typeof getDb>,
  organizationId: string,
  serviceId: string,
) => {
  const result = await db
    .select({ id: services.id, defaultCapacity: services.defaultCapacity })
    .from(services)
    .where(
      and(
        eq(services.id, serviceId),
        eq(services.organizationId, organizationId),
      ),
    )
    .limit(1)

  if (!result[0]) {
    throw new ApiError('NOT_FOUND', 404, 'Service not found')
  }

  return result[0]
}

// The triple filter (extraId + serviceId + organizationId) — a wrong parent or
// foreign org resolves to 404.
const extraScope = (organizationId: string, serviceId: string, extraId: string) =>
  and(
    eq(serviceExtras.id, extraId),
    eq(serviceExtras.serviceId, serviceId),
    eq(serviceExtras.organizationId, organizationId),
  )

// US-A11 — add an extra to a service.
export const addExtra = async (c: ServicesContext) => {
  const admin = c.get('user')
  const serviceId = c.req.param('id')
  const input = (await c.req.json()) as CreateExtraInput
  const db = getDb(c.env)

  await requireService(db, admin.organizationId, serviceId)

  const result = await db
    .insert(serviceExtras)
    .values({
      id: crypto.randomUUID(),
      organizationId: admin.organizationId,
      serviceId,
      name: input.name,
      price: input.price,
      status: 'active',
    })
    .returning(extraColumns)

  return c.json({ extra: serializeExtra(result[0]) }, 201)
}

// US-A11 — edit an extra. The triple filter → 404 on wrong parent / unknown.
export const updateExtra = async (c: ServicesContext) => {
  const admin = c.get('user')
  const serviceId = c.req.param('id')
  const extraId = c.req.param('extraId')
  const input = (await c.req.json()) as UpdateExtraInput
  const db = getDb(c.env)

  const result = await db
    .update(serviceExtras)
    .set({ name: input.name, price: input.price, updatedAt: new Date() })
    .where(extraScope(admin.organizationId, serviceId, extraId))
    .returning(extraColumns)

  const extra = result[0]
  if (!extra) {
    throw new ApiError('NOT_FOUND', 404, 'Extra not found')
  }

  return c.json({ extra: serializeExtra(extra) })
}

// US-A11 — soft delete: flip status to inactive. Idempotent; row stays present.
export const deleteExtra = async (c: ServicesContext) => {
  const admin = c.get('user')
  const serviceId = c.req.param('id')
  const extraId = c.req.param('extraId')
  const db = getDb(c.env)

  const result = await db
    .update(serviceExtras)
    .set({ status: 'inactive', updatedAt: new Date() })
    .where(extraScope(admin.organizationId, serviceId, extraId))
    .returning(extraColumns)

  const extra = result[0]
  if (!extra) {
    throw new ApiError('NOT_FOUND', 404, 'Extra not found')
  }

  return c.json({ extra: serializeExtra(extra) })
}
