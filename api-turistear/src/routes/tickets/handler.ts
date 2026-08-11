import type { Context } from 'hono'
import { and, eq, sql } from 'drizzle-orm'
import { getDb } from '../../db/client'
import { folioLines, folios, organizations } from '../../db/schema'
import { deriveOrgKey, stripTicketUrl, verifyTicket } from '../../utils/qr'
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
  // US-AG52 (D16) — the ticket was REPLACED by a reschedule. Its signature is still genuine and
  // its own expiry may still be ahead, so nothing else here would catch it.
  | 'SUPERSEDED'

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
  const { token: scanned } = (await c.req.json()) as { token: string }
  // express-sale D9 — QRs now encode the `/t/<token>` URL form so a tourist's camera resolves
  // to their ticket page. Strip the wrapper back to the raw token; a bare pre-feature token
  // passes through untouched, so every QR already issued keeps scanning.
  const token = stripTicketUrl(scanned ?? '')
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
      // US-AG52 (D16) — the line's CURRENT ticket, to reject a superseded one.
      qrToken: folioLines.qrToken,
      serviceName: folioLines.serviceName,
      slotDate: folioLines.slotDate,
      slotStartTime: folioLines.slotStartTime,
      zoneName: folioLines.zoneName,
      // US-A22 — the line's own cancellation, gated below ahead of F4's full line migration.
      lineCancelledAt: folioLines.cancelledAt,
      lineTotal: folioLines.lineTotal,
      // US-A89 (F4, PR-7) — the line's own money: NULL = no allocations at all (a legacy row;
      // production was backfilled by 0062), else its net allocated sum. Raw outer-column
      // correlation — the displayMethodSql trick.
      lineAllocated: sql<number | null>`(select sum(a.amount) from folio_payment_allocations a where a.folio_line_id = folio_lines.id)`,
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
  // US-A22 (line-autonomy F2) — the LINE's own cancellation refuses identically: a half-cancelled
  // folio stays `paid`, and without this the cancelled line's genuine, unexpired token would
  // still admit a passenger whose seat already went back to the pool.
  if (row.lineCancelledAt) {
    return invalid(c, 'CANCELLED', ctx)
  }
  // US-A89 (F4, PR-7 — S-13) — the paid gate answers from the LINE's money: a line settled per
  // line admits even while its siblings keep the folio a `booking`, and an unpaid line refuses
  // whatever the folio's roll-up says. A line with no allocations at all (legacy fixture; never
  // a production row) keeps the folio-status answer — the same fallback deriveStatusSql uses,
  // and it dies with the column in PR-9.
  const linePaid =
    row.lineAllocated === null
      ? row.folioStatus === 'paid'
      : Math.max(0, Number(row.lineAllocated)) >= row.lineTotal
  if (!linePaid) {
    return invalid(c, 'NOT_PAID', ctx)
  }

  // 3b. SUPERSEDED — US-AG52 (D16). A reschedule RE-SIGNS the line's ticket, and until this check
  // existed the replaced one still admitted: its signature is genuine, the line still resolves, the
  // folio is still paid, and its `expires_at` came from the OLD departure — which on a move to a
  // later date is still in the future. So the customer we told "tu boleto anterior deja de
  // funcionar" could walk up on the ORIGINAL date, be admitted to a departure whose seat we had
  // already returned to the pool, and BURN a pass belonging to the new one — leaving the correct
  // date reading ALREADY_CONSUMED.
  //
  // Compared against the line's own column rather than a revocation list: `qr_token` is already
  // the single record of which ticket is current, and the reschedule is the ONLY path that
  // overwrites it (every other minting call site — confirmSale, settle, verifyPayment — writes a
  // token where there was none). A line with no token at all is left alone: pre-feature rows keep
  // whatever validity they had, exactly as the zone_name note above.
  if (row.qrToken && row.qrToken !== token) {
    return invalid(c, 'SUPERSEDED', ctx)
  }

  // 4. EXPIRY — enforced from the signed payload.
  if (Math.floor(Date.now() / 1000) > payload.expires_at) {
    return invalid(c, 'EXPIRED', ctx)
  }

  // US-A81 (docs/scanner/group-redemption.spec.md) — how a scan consumes passes is the SCANNING
  // org's choice (D3), read live at scan time, never snapshotted onto the ticket (S-5).
  const [modeRow] = await db
    .select({ mode: organizations.qrRedemptionMode })
    .from(organizations)
    .where(eq(organizations.id, org))
    .limit(1)
  const allPasses = modeRow?.mode === 'all_passes'

  // 5. ATOMIC redeem — the SAME single guarded UPDATE in both modes; only the SET expression
  //    branches (D4). `per_pass` takes one pass; `all_passes` takes everything left (a partially
  //    redeemed ticket completes, S-3). The `redeemed_count < quantity` guard is identical, so a
  //    rescan is ALREADY_CONSUMED and a concurrent double-scan admits exactly one winner (S-6).
  const redeemed = await db
    .update(folioLines)
    .set({
      redeemedCount: allPasses
        ? sql`${folioLines.quantity}`
        : sql`${folioLines.redeemedCount} + 1`,
    })
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
  // D6 — the response branches: a pass ordinal is meaningless when the party redeems as one, so
  // `all_passes` reports how many THIS scan took (`redeemed_now`) instead of a `pass_number`.
  return c.json({
    result: 'valid' as const,
    ticket: allPasses
      ? { ...ctx, redeemed_count: newCount, redeemed_now: newCount - row.redeemedCount }
      : { ...ctx, redeemed_count: newCount, pass_number: newCount },
  })
}
