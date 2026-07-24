import type { Context } from 'hono'
import { and, desc, eq } from 'drizzle-orm'
import { getDb } from '../../db/client'
import { affiliateCompanies, affiliateOperators } from '../../db/schema'
import { hashPassword, verifyPassword } from '../../services/agnosticAuth'
import {
  clearOperatorSessionCookie,
  setOperatorSessionCookie,
} from '../../utils/cookies'
import { signOperatorSession } from '../../utils/operatorSession'
import { derivePinSecret } from '../../utils/pin'
import { normalizePhone } from '../../utils/phone'
import { ApiError } from '../../types/errors'
import type { AppVariables, OperatorPayload } from '../../types/context'
import type {
  ChangePinInput,
  CreateOperatorInput,
  LoginInput,
  SetPinInput,
} from './schema'

type OpContext = Context<{ Bindings: CloudflareBindings; Variables: AppVariables }>

const MAX_PIN_ATTEMPTS = 5

const newAccessToken = (): string =>
  (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, '')

const accessUrl = (env: CloudflareBindings, token: string): string =>
  `${env.APP_BASE_URL}/o/${token}`

type OperatorRow = typeof affiliateOperators.$inferSelect

// Manager-facing shape (never leaks pin_hash). `access_url` powers the WhatsApp button (US-AF11).
const serializeForManager = (env: CloudflareBindings, o: OperatorRow) => ({
  id: o.id,
  name: o.name,
  phone: o.phone,
  status: o.status,
  pin_set: o.pinHash != null,
  locked: o.pinAttempts >= MAX_PIN_ATTEMPTS,
  access_url: o.status === 'active' ? accessUrl(env, o.accessToken) : null,
  created_at: o.createdAt,
})

// ---- Manager surface (requireRole('affiliate'); a real manager session, never an operator) ----

// D6 — operators cannot manage operators. Reject a borrowed (operator) session on these routes.
const requireManager = (c: OpContext): { userId: string; companyId: string; orgId: string } => {
  if (c.get('operator')) {
    throw new ApiError('FORBIDDEN', 403, 'Operators cannot manage operators')
  }
  const user = c.get('user')
  if (!user.affiliateCompanyId) {
    throw new ApiError('FORBIDDEN', 403, 'Only an affiliate manager can manage operators')
  }
  return { userId: user.userId, companyId: user.affiliateCompanyId, orgId: user.organizationId }
}

export const listOperators = async (c: OpContext) => {
  const { companyId } = requireManager(c)
  const db = getDb(c.env)
  const rows = await db
    .select()
    .from(affiliateOperators)
    .where(eq(affiliateOperators.affiliateCompanyId, companyId))
    .orderBy(desc(affiliateOperators.createdAt))
  // Active first, then removed.
  const ordered = [...rows].sort((a, b) => Number(a.status === 'removed') - Number(b.status === 'removed'))
  return c.json({ operators: ordered.map((o) => serializeForManager(c.env, o)) })
}

export const createOperator = async (c: OpContext) => {
  const { userId, companyId, orgId } = requireManager(c)
  const input = (await c.req.json()) as CreateOperatorInput

  const { e164, valid } = normalizePhone(input.phone)
  if (!valid) {
    throw new ApiError('VALIDATION_ERROR', 400, 'Se requiere un teléfono válido (10 dígitos)')
  }

  const db = getDb(c.env)
  // Active-phone uniqueness within the company (D7). The DB partial index is the hard guard;
  // this pre-check yields a clean 409 instead of a constraint error.
  const clash = await db
    .select({ id: affiliateOperators.id })
    .from(affiliateOperators)
    .where(
      and(
        eq(affiliateOperators.affiliateCompanyId, companyId),
        eq(affiliateOperators.phone, e164),
        eq(affiliateOperators.status, 'active'),
      ),
    )
    .limit(1)
  if (clash.length > 0) {
    throw new ApiError('OPERATOR_PHONE_EXISTS', 409, 'Ya existe un operador activo con ese teléfono')
  }

  const id = crypto.randomUUID()
  await db.insert(affiliateOperators).values({
    id,
    organizationId: orgId,
    affiliateCompanyId: companyId,
    managerId: userId,
    name: input.name.trim(),
    phone: e164,
    accessToken: newAccessToken(),
    status: 'active',
  })

  const row = (
    await db.select().from(affiliateOperators).where(eq(affiliateOperators.id, id)).limit(1)
  )[0]
  return c.json({ operator: serializeForManager(c.env, row) }, 201)
}

// Load one of the caller company's operators or 404 (also the cross-org isolation guard — B3).
const loadOwnedOperator = async (c: OpContext, companyId: string, id: string): Promise<OperatorRow> => {
  const db = getDb(c.env)
  const rows = await db
    .select()
    .from(affiliateOperators)
    .where(and(eq(affiliateOperators.id, id), eq(affiliateOperators.affiliateCompanyId, companyId)))
    .limit(1)
  if (!rows[0]) throw new ApiError('NOT_FOUND', 404, 'Operator not found')
  return rows[0]
}

// US-AF12 — clear the PIN + attempts and ROTATE the token (the old link dies) so the operator
// re-sets a PIN on next open. Used for a forgotten PIN or a lockout.
export const resetOperatorPin = async (c: OpContext) => {
  const { companyId } = requireManager(c)
  const op = await loadOwnedOperator(c, companyId, c.req.param('id'))
  if (op.status !== 'active') {
    throw new ApiError('OPERATOR_REMOVED', 409, 'Operator has been removed')
  }
  const db = getDb(c.env)
  await db
    .update(affiliateOperators)
    .set({
      pinHash: null,
      pinSalt: null,
      pinAttempts: 0,
      accessToken: newAccessToken(),
      updatedAt: new Date(),
    })
    .where(eq(affiliateOperators.id, op.id))
  const row = (
    await db.select().from(affiliateOperators).where(eq(affiliateOperators.id, op.id)).limit(1)
  )[0]
  return c.json({ operator: serializeForManager(c.env, row) })
}

// US-AF12 — soft remove: void the link + PIN so the operator can never unlock again, but keep the
// row so historical folios still read "Vendido por: {name}". Idempotent.
export const removeOperator = async (c: OpContext) => {
  const { companyId } = requireManager(c)
  const op = await loadOwnedOperator(c, companyId, c.req.param('id'))
  const db = getDb(c.env)
  await db
    .update(affiliateOperators)
    .set({
      status: 'removed',
      pinHash: null,
      pinSalt: null,
      accessToken: newAccessToken(), // void the saved link
      updatedAt: new Date(),
    })
    .where(eq(affiliateOperators.id, op.id))
  return c.json({ ok: true })
}

// ---- Operator access surface (token-based; no auth middleware) ----

const loadByToken = async (c: OpContext, token: string): Promise<OperatorRow> => {
  const db = getDb(c.env)
  const rows = await db
    .select()
    .from(affiliateOperators)
    .where(eq(affiliateOperators.accessToken, token))
    .limit(1)
  const op = rows[0]
  if (!op || op.status !== 'active') {
    throw new ApiError('NOT_FOUND', 404, 'Invalid or revoked access link')
  }
  return op
}

const mintShift = async (c: OpContext, op: OperatorRow) => {
  const token = await signOperatorSession(c.env.QR_SECRET, op.id)
  setOperatorSessionCookie(c, token)
}

// GET /:token — resolve the saved link (US-OP01/OP02). Tells the client first-run vs returning.
export const resolveAccess = async (c: OpContext) => {
  const op = await loadByToken(c, c.req.param('token'))
  const db = getDb(c.env)
  const co = await db
    .select({ name: affiliateCompanies.name })
    .from(affiliateCompanies)
    .where(eq(affiliateCompanies.id, op.affiliateCompanyId))
    .limit(1)
  return c.json({
    operator: {
      name: op.name,
      hotel_name: co[0]?.name ?? '',
      pin_set: op.pinHash != null,
      locked: op.pinAttempts >= MAX_PIN_ATTEMPTS,
    },
  })
}

// POST /:token/set-pin — first-run only (US-OP01).
export const setPin = async (c: OpContext) => {
  const op = await loadByToken(c, c.req.param('token'))
  if (op.pinHash != null) {
    throw new ApiError('PIN_ALREADY_SET', 409, 'El PIN ya fue configurado')
  }
  const input = (await c.req.json()) as SetPinInput
  const { hash, salt } = await hashPassword(c.env, await derivePinSecret(c.env, input.pin))
  const db = getDb(c.env)
  await db
    .update(affiliateOperators)
    .set({ pinHash: hash, pinSalt: salt, pinAttempts: 0, updatedAt: new Date() })
    .where(eq(affiliateOperators.id, op.id))
  await mintShift(c, op)
  return c.json({ operator: { name: op.name } }, 201)
}

// POST /:token/login — daily unlock (US-OP02). Wrong PIN increments; 5 → locked (423).
export const login = async (c: OpContext) => {
  const op = await loadByToken(c, c.req.param('token'))
  if (op.pinHash == null || op.pinSalt == null) {
    throw new ApiError('PIN_NOT_SET', 409, 'Configura tu PIN primero')
  }
  if (op.pinAttempts >= MAX_PIN_ATTEMPTS) {
    throw new ApiError('OPERATOR_LOCKED', 423, 'Cuenta bloqueada. Pide a tu gerente que la restablezca.')
  }
  const input = (await c.req.json()) as LoginInput
  const db = getDb(c.env)

  let ok = true
  try {
    await verifyPassword(c.env, {
      password: await derivePinSecret(c.env, input.pin),
      hash: op.pinHash,
      salt: op.pinSalt,
      identity: op.id,
    })
  } catch {
    ok = false
  }

  if (!ok) {
    const attempts = op.pinAttempts + 1
    await db
      .update(affiliateOperators)
      .set({ pinAttempts: attempts, updatedAt: new Date() })
      .where(eq(affiliateOperators.id, op.id))
    if (attempts >= MAX_PIN_ATTEMPTS) {
      throw new ApiError('OPERATOR_LOCKED', 423, 'Cuenta bloqueada. Pide a tu gerente que la restablezca.')
    }
    throw new ApiError('INVALID_PIN', 401, 'PIN incorrecto')
  }

  if (op.pinAttempts !== 0) {
    await db
      .update(affiliateOperators)
      .set({ pinAttempts: 0, updatedAt: new Date() })
      .where(eq(affiliateOperators.id, op.id))
  }
  await mintShift(c, op)
  return c.json({ operator: { name: op.name } })
}

// POST /change-pin — from within an active shift (US-OP02). Session-guarded by the router.
export const changePin = async (c: OpContext) => {
  const operator = c.get('operator') as OperatorPayload | undefined
  if (!operator) {
    throw new ApiError('UNAUTHORIZED', 401, 'No hay una sesión de operador activa')
  }
  const input = (await c.req.json()) as ChangePinInput
  const db = getDb(c.env)
  const op = (
    await db.select().from(affiliateOperators).where(eq(affiliateOperators.id, operator.operatorId)).limit(1)
  )[0]
  if (!op || op.status !== 'active' || op.pinHash == null || op.pinSalt == null) {
    throw new ApiError('UNAUTHORIZED', 401, 'Sesión inválida')
  }

  try {
    await verifyPassword(c.env, {
      password: await derivePinSecret(c.env, input.current),
      hash: op.pinHash,
      salt: op.pinSalt,
      identity: op.id,
    })
  } catch {
    throw new ApiError('INVALID_PIN', 401, 'El PIN actual es incorrecto')
  }

  const { hash, salt } = await hashPassword(c.env, await derivePinSecret(c.env, input.new))
  await db
    .update(affiliateOperators)
    .set({ pinHash: hash, pinSalt: salt, updatedAt: new Date() })
    .where(eq(affiliateOperators.id, op.id))
  return c.json({ ok: true })
}

// POST /logout — end the shift.
export const logoutOperator = async (c: OpContext) => {
  clearOperatorSessionCookie(c)
  return c.json({ ok: true })
}
