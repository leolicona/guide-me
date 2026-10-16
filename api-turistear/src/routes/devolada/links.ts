import { and, eq, isNull } from 'drizzle-orm'
import type { Db } from '../../db/client'
import {
  devoladaLinks,
  folioLines,
  organizations,
  type DevoladaBrokenReason,
  type DevoladaLink,
  type DevoladaLinkKind,
} from '../../db/schema'
import { devoladaClient } from '../../services/devolada'
import { folioEventRow } from '../../utils/folioEvents'
import { toPaymentLinkView, type PaymentLinkView } from '../../utils/devoladaLinkView'
import { naiveEpoch } from '../../utils/tz'
import { brokenReasonOf, loadCurrentCredential, markConnectionBroken } from './connection'

// devolada-transfer-verification D6, D7 — issuing the payment link of a transfer.
//
// A link is issued AFTER the sale's money write commits (constitution VIII): the sale is the fact,
// and the link is a call outside its batch. Our row is written before Devolada is called, so an
// orphan link is impossible — a create that timed out is replayed with the same key (D12). When no
// call can succeed, the row is written straight as `failed`, without calling Devolada: the sale
// shows «Sin enlace de pago — verificar a mano», and a deposit's row keeps its apartado waiting for
// the admin (D8). Whatever happens here, the sale stays on today's manual path and the request
// never answers 500 after it committed.

/**
 * D7 — a link that would stay open less than this is not issued. The organization's own settings
 * can put a sale after its service starts (a negative sales cutoff, a negative booking grace); a
 * link capped at the service start would then be born expired. Fifteen minutes is a working
 * minimum, tuned here and nowhere else.
 */
export const MIN_LINK_LIFETIME = 15 * 60

const LINK_MAX_LIFETIME = 24 * 60 * 60

export type PaymentLinkError =
  | 'DEVOLADA_UNAVAILABLE'
  | 'DEVOLADA_CREDENTIAL_REJECTED'
  | 'DEVOLADA_BUSINESS_SUSPENDED'
  | 'DEVOLADA_CHANNEL_UNAVAILABLE'
  | 'PAYMENT_LINK_TOO_SHORT'

export interface ExpiryLine {
  lineType: 'slot' | 'stay'
  slotDate: string | null
  slotStartTime: string | null
  checkIn: string | null
  /** The line's own clock (US-AG54 D5): the deadline to pay an apartado's balance. */
  bookingExpiresAt: number | null
}

const nextDay = (date: string): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)

/** When a line's service starts: a slot at its date and time; a stay at the end of its check-in day. */
const lineStart = (line: ExpiryLine, timezone: string): number | null => {
  if (line.lineType === 'stay') {
    // D7 — a stay has no start time. The end of its check-in day lets a guest who arrives that day
    // pay by transfer; its start would make every same-day stay's link born expired.
    return line.checkIn ? naiveEpoch(nextDay(line.checkIn), '00:00', timezone) : null
  }
  return line.slotDate && line.slotStartTime ? naiveEpoch(line.slotDate, line.slotStartTime, timezone) : null
}

/**
 * D7 — the link expires at the earliest of: 24 h after it is issued; the first start among the
 * lines it collects for; and, for a deposit or a settlement, the earliest clock among those lines.
 * `lines` are the LIVE lines the link collects for: every live line of the sale, except for a
 * settlement of one line, which passes that line alone — each line runs its own clock.
 */
export function computeLinkExpiry({
  issuedAt,
  lines,
  timezone,
  kind,
}: {
  issuedAt: number
  lines: ExpiryLine[]
  timezone: string
  kind: DevoladaLinkKind
}): number {
  let expiry = issuedAt + LINK_MAX_LIFETIME
  for (const line of lines) {
    const start = lineStart(line, timezone)
    if (start !== null) expiry = Math.min(expiry, start)
    if (kind !== 'sale' && line.bookingExpiresAt !== null) expiry = Math.min(expiry, line.bookingExpiresAt)
  }
  return expiry
}

export interface IssueLinkDeps {
  db: Db
  env: CloudflareBindings
}

export interface IssueLinkInput {
  organizationId: string
  folioId: string
  /** The pending ledger row a sale or deposit link collects; null for a settlement (D8). */
  folioPaymentId: string | null
  /** A settlement of one line; null for every other link. */
  folioLineId: string | null
  kind: DevoladaLinkKind
  amount: number
  /** The seller who issues it; a settlement recorded under D8 is collected by them. */
  requestedBy: string
  customerName: string | null
  concept: string | null
}

export type IssueLinkResult =
  | { link: PaymentLinkView; error: null }
  | { link: null; error: PaymentLinkError }
  /** The organization has no current credential (never connected, or disconnected meanwhile). */
  | { link: null; error: null }

const errorOf = (reason: DevoladaBrokenReason | null): PaymentLinkError => reason ?? 'DEVOLADA_UNAVAILABLE'

async function liveLinesOf(db: Db, input: IssueLinkInput): Promise<ExpiryLine[]> {
  const rows = await db
    .select({
      lineType: folioLines.lineType,
      slotDate: folioLines.slotDate,
      slotStartTime: folioLines.slotStartTime,
      checkIn: folioLines.checkIn,
      bookingExpiresAt: folioLines.bookingExpiresAt,
    })
    .from(folioLines)
    .where(
      and(
        eq(folioLines.folioId, input.folioId),
        eq(folioLines.organizationId, input.organizationId),
        isNull(folioLines.cancelledAt),
        ...(input.folioLineId ? [eq(folioLines.id, input.folioLineId)] : []),
      ),
    )
  return rows.map((r) => ({
    ...r,
    bookingExpiresAt: r.bookingExpiresAt ? Math.floor(r.bookingExpiresAt.getTime() / 1000) : null,
  }))
}

/**
 * D6, D7 — issue the link of one transfer, for an organization whose connection has a current
 * credential (`connected` or `broken`). Returns the link, or why there is none.
 */
export async function issuePaymentLink(deps: IssueLinkDeps, input: IssueLinkInput): Promise<IssueLinkResult> {
  const { db, env } = deps
  const org = input.organizationId
  const current = await loadCurrentCredential(deps, org)
  if (!current) return { link: null, error: null }

  const now = new Date()
  const nowSec = Math.floor(now.getTime() / 1000)
  const tz =
    (await db.select({ tz: organizations.timezone }).from(organizations).where(eq(organizations.id, org)).limit(1))[0]
      ?.tz ?? 'America/Mexico_City'
  const expiresAt = computeLinkExpiry({
    issuedAt: nowSec,
    lines: await liveLinesOf(db, input),
    timezone: tz,
    kind: input.kind,
  })

  const id = crypto.randomUUID()
  const row = {
    id,
    organizationId: org,
    folioId: input.folioId,
    folioLineId: input.folioLineId,
    folioPaymentId: input.folioPaymentId,
    kind: input.kind,
    credentialId: current.credentialId,
    mode: current.mode,
    amount: input.amount,
    expiresAt: new Date(expiresAt * 1000),
    requestedBy: input.requestedBy,
    createdAt: now,
    updatedAt: now,
  }
  // D6 — when no call can succeed, the row is written straight as `failed`: the sale shows it, and
  // a deposit's apartado waits for the admin (D8).
  const recordFailed = async (error: PaymentLinkError): Promise<IssueLinkResult> => {
    await db.insert(devoladaLinks).values({ ...row, state: 'failed' })
    return { link: null, error }
  }

  // 0. D7 — too little time: the payment takes the manual path.
  if (expiresAt - nowSec < MIN_LINK_LIFETIME) return recordFailed('PAYMENT_LINK_TOO_SHORT')
  // 1. A broken connection (FR-010), or a key this environment cannot read (D17).
  if (current.connection.status !== 'connected') return recordFailed(errorOf(current.connection.brokenReason))
  if (!current.apiKey) {
    console.error('[devolada] link not issued: the current credential is unreadable here', org)
    return recordFailed('DEVOLADA_UNAVAILABLE')
  }

  // 2. Our row first, so the link can never exist at Devolada without it.
  await db.insert(devoladaLinks).values({ ...row, state: 'creating' })

  // 3. Devolada, on the seller's clock (3 s).
  const res = await devoladaClient(env, current.apiKey).createPaymentLink(
    {
      customerRef: input.folioId,
      askCents: input.amount,
      mode: 'one_time',
      expiresAt,
      ...(input.customerName?.trim() ? { label: input.customerName.trim() } : {}),
      ...(input.concept?.trim() ? { concept: input.concept.trim() } : {}),
    },
    { idempotencyKey: id, fast: true },
  )

  const scope = and(eq(devoladaLinks.id, id), eq(devoladaLinks.organizationId, org))
  if (res.ok) {
    // 4. Devolada's id and URL are stored whatever the state: a cancellation may already have
    //    marked the row `closing` (D13), and the close needs the id. Only a row still `creating`
    //    becomes `open`.
    const [stored] = await db
      .update(devoladaLinks)
      .set({ devoladaLinkId: res.data.id, url: res.data.url, updatedAt: new Date() })
      .where(scope)
      .returning()
    const [opened] = await db
      .update(devoladaLinks)
      .set({ state: 'open', updatedAt: new Date() })
      .where(and(scope, eq(devoladaLinks.state, 'creating')))
      .returning()
    const link: DevoladaLink = opened ?? stored!
    if (opened) {
      await folioEventRow(db, {
        organizationId: org,
        folioId: input.folioId,
        type: 'payment_link_issued',
        actorId: input.requestedBy,
        folioLineId: input.folioLineId,
        payload: { link_id: id, kind: input.kind, amount: input.amount, expires_at: expiresAt },
        at: now,
      })
    }
    return { link: toPaymentLinkView(link, [], false), error: null }
  }

  if (res.kind === 'refused') {
    // 5. Refused: the link is `failed`; a refusal the admin must fix breaks the connection.
    await db
      .update(devoladaLinks)
      .set({ state: 'failed', updatedAt: new Date() })
      .where(and(scope, eq(devoladaLinks.state, 'creating')))
    const reason = brokenReasonOf(res)
    if (reason) await markConnectionBroken(db, org, reason, current.credentialId)
    else console.error('[devolada] link refused', res.code, res.message)
    return { link: null, error: errorOf(reason) }
  }

  // 6. Timeout or a retryable answer: `abandoned`, through a guarded update — a row a cancellation
  //    already marked `closing` stays `closing`, and the sweep replays the create with the same key
  //    to learn whether the link exists (D12).
  await db
    .update(devoladaLinks)
    .set({ state: 'abandoned', updatedAt: new Date() })
    .where(and(scope, eq(devoladaLinks.state, 'creating')))
  return { link: null, error: 'DEVOLADA_UNAVAILABLE' }
}
