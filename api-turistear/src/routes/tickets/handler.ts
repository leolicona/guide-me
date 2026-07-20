import type { Context } from 'hono'
import { and, eq, sql } from 'drizzle-orm'
import { getDb } from '../../db/client'
import { folioLines, folios } from '../../db/schema'
import { deriveOrgKey, verifyTicket } from '../../utils/qr'
import type { AppVariables } from '../../types/context'

export type TicketsContext = Context<{
  Bindings: CloudflareBindings
  Variables: AppVariables
}>

// Why a 200-body result (not an ApiError): the ✓/✗ outcome of a scan is data the scanner
// renders as a result screen — an expired/forged/consumed ticket is a *successful*
// validation that returned "invalid", not a request error. HTTP 4xx/5xx is reserved for
// request-level problems (missing token, auth, role). See docs/scanner/online-qr-scanner.spec.md.
type ScanReason =
  | 'INVALID_SIGNATURE'
  | 'EXPIRED'
  | 'ALREADY_CONSUMED'
  | 'CANCELLED'
  | 'NOT_PAID'
  | 'NOT_FOUND'

interface TicketContext {
  client_identity: string
  service_name: string | null
  slot_date: string | null
  slot_start_time: string | null
  // US-A64 — the physical zone this pass is for (Turibus deck), shown on the scan result so the
  // staffer directs the tourist. Read from the line, NOT the signed payload — so every ticket
  // issued before this feature stays valid and simply shows no zone.
  zone_name: string | null
  passes_total: number | null
  redeemed_count: number | null
}

const invalid = (c: TicketsContext, reason: ScanReason, ticket: object | null = null) =>
  c.json({ result: 'invalid' as const, reason, ticket })

// US-AG15 / US-AG17 — verify a scanned token and redeem ONE pass, atomically.
//
// Deterministic order (each step short-circuits): verify signature → load line+folio
// (org-scoped) → folio status gates → expiry → atomic conditional redeem. The single
// `redeemed_count < quantity` guarded UPDATE is the race backstop (D1 has no interactive
// transactions, but one counter moving needs no batch/compensation — contrast POS confirm).
export const scanTicket = async (c: TicketsContext) => {
  const agent = c.get('user')
  const org = agent.organizationId
  const { token } = (await c.req.json()) as { token: string }
  const db = getDb(c.env)

  // 1. VERIFY under the caller-org derived key. A forged/tampered token — or a valid token
  //    minted for another org (different derived key) — fails here and reads as "fake",
  //    leaking nothing about other orgs.
  const orgKey = await deriveOrgKey(c.env.QR_SECRET, org)
  const payload = await verifyTicket(token, orgKey)
  if (!payload) {
    return invalid(c, 'INVALID_SIGNATURE')
  }

  // 2. LOAD the folio line + its folio status, org-scoped (Rules 2 & 4).
  const rows = await db
    .select({
      id: folioLines.id,
      quantity: folioLines.quantity,
      redeemedCount: folioLines.redeemedCount,
      serviceName: folioLines.serviceName,
      slotDate: folioLines.slotDate,
      slotStartTime: folioLines.slotStartTime,
      zoneName: folioLines.zoneName,
      folioStatus: folios.status,
    })
    .from(folioLines)
    .innerJoin(folios, eq(folioLines.folioId, folios.id))
    .where(
      and(
        eq(folioLines.id, payload.folio_line_id),
        eq(folioLines.organizationId, org),
      ),
    )
    .limit(1)

  const row = rows[0]
  if (!row) {
    return invalid(c, 'NOT_FOUND', { client_identity: payload.client_identity })
  }

  // Display context reused by every branch below (US-AG17 result screen).
  const ctx: TicketContext = {
    client_identity: payload.client_identity,
    service_name: row.serviceName,
    slot_date: row.slotDate,
    slot_start_time: row.slotStartTime,
    zone_name: row.zoneName,
    passes_total: row.quantity,
    redeemed_count: row.redeemedCount,
  }

  // 3. STATUS gates — only a paid, non-cancelled folio admits (forward-safe for bookings).
  if (row.folioStatus === 'cancelled') {
    return invalid(c, 'CANCELLED', ctx)
  }
  if (row.folioStatus !== 'paid') {
    return invalid(c, 'NOT_PAID', ctx)
  }

  // 4. EXPIRY — enforced from the signed payload.
  if (Math.floor(Date.now() / 1000) > payload.expires_at) {
    return invalid(c, 'EXPIRED', ctx)
  }

  // 5. ATOMIC redeem — one pass, guarded so it can never exceed `quantity`.
  const redeemed = await db
    .update(folioLines)
    .set({ redeemedCount: sql`${folioLines.redeemedCount} + 1` })
    .where(
      and(
        eq(folioLines.id, row.id),
        eq(folioLines.organizationId, org),
        sql`${folioLines.redeemedCount} < ${folioLines.quantity}`,
      ),
    )
    .returning({ redeemedCount: folioLines.redeemedCount })

  if (redeemed.length === 0) {
    // All passes already used (redeemed_count == quantity).
    return invalid(c, 'ALREADY_CONSUMED', { ...ctx, redeemed_count: row.quantity })
  }

  const newCount = redeemed[0].redeemedCount
  return c.json({
    result: 'valid' as const,
    ticket: { ...ctx, redeemed_count: newCount, pass_number: newCount },
  })
}
