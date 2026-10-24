import { and, eq, inArray, isNull, ne, or, sql, type SQL } from 'drizzle-orm'
import type { Db } from '../../db/client'
import {
  devoladaLinks,
  folioLines,
  organizations,
  type DevoladaBrokenReason,
  type DevoladaLink,
  type DevoladaLinkClosedReason,
  type DevoladaLinkKind,
} from '../../db/schema'
import { devoladaClient } from '../../services/devolada'
import { folioEventRow } from '../../utils/folioEvents'
import { toPaymentLinkView, type PaymentLinkView } from '../../utils/devoladaLinkView'
import { currentPaymentStatusSql, linkMoneyAppliedSql } from '../../utils/devoladaSql'
import { naiveEpoch } from '../../utils/tz'
import {
  brokenReasonOf,
  fallBackLinkCredential,
  loadCurrentCredential,
  loadLinkCredential,
  markConnectionBroken,
} from './connection'

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

/**
 * D13, D21 — closes one of our links at Devolada (`PATCH {close: true}`), with the link's own
 * credential, so the customer can no longer pay a sale that stopped taking that money. Fail-soft:
 * it never throws, and whatever keeps the close from happening leaves a `closing` link `closing`,
 * for the sweep to retry (D12 step 3):
 * - Devolada's answer, or `LINK_CLOSED`, means the link is closed: a `closing` row becomes `closed`.
 *   A row in another state keeps it — D11's own link ends `expired`, with no reason (D13);
 * - a link whose create never recorded Devolada's id is not closed here: the create's outcome, or
 *   the sweep's replay with the same key, learns the id first;
 * - a rejected RETIRED credential takes D21's fallback: the link moves to the current credential,
 *   and the next run closes it with that one, or becomes `failed` when no credential can read it;
 * - a rejected or suspended CURRENT credential breaks the connection, and the link waits for the
 *   admin's new key.
 */
export async function closePaymentLinkRemote(
  deps: IssueLinkDeps,
  link: Pick<DevoladaLink, 'id' | 'organizationId' | 'credentialId' | 'devoladaLinkId'>,
): Promise<'closed' | 'pending' | 'failed' | 'rate_limited'> {
  const { db, env } = deps
  if (!link.devoladaLinkId) return 'pending'
  try {
    const credential = await loadLinkCredential(deps, link)
    if (!credential) {
      // Erased while the link was still unresolved: nothing can reach it any more (D21).
      console.error('[devolada] cannot close a link whose credential was erased', link.id)
      return 'pending'
    }
    if (!credential.apiKey) {
      console.error('[devolada] link not closed: its credential is unreadable here', link.id)
      return 'pending'
    }
    const res = await devoladaClient(env, credential.apiKey).closePaymentLink(link.devoladaLinkId, {
      idempotencyKey: `close:${link.id}`,
    })
    if (res.ok || (res.kind === 'refused' && res.code === 'LINK_CLOSED')) {
      await db
        .update(devoladaLinks)
        .set({ state: 'closed', updatedAt: new Date() })
        .where(
          and(
            eq(devoladaLinks.id, link.id),
            eq(devoladaLinks.organizationId, link.organizationId),
            eq(devoladaLinks.state, 'closing'),
          ),
        )
      return 'closed'
    }
    const reason = brokenReasonOf(res)
    if (reason === 'DEVOLADA_CREDENTIAL_REJECTED' && !credential.isCurrent) {
      return (await fallBackLinkCredential(deps, link)) === 'failed' ? 'failed' : 'pending'
    }
    if (reason === 'DEVOLADA_CREDENTIAL_REJECTED' || reason === 'DEVOLADA_BUSINESS_SUSPENDED') {
      if (credential.isCurrent) await markConnectionBroken(db, link.organizationId, reason, credential.credentialId)
      return 'pending'
    }
    if (res.code === 'RATE_LIMITED') return 'rate_limited'
    if (res.kind === 'refused') console.error('[devolada] link close refused', link.id, res.code, res.message)
    return 'pending'
  } catch (err) {
    console.error('[devolada] link close failed', link.id, err)
    return 'pending'
  }
}

export const SETTLEMENT_IN_PROGRESS_MESSAGE = 'The sale already has a payment link to settle it; wait for its result'

// ─── D13 — a sale that stops taking money closes its links ──────────────────────────────────────
//
// Every write that stops a sale from taking a payment marks the links it touches `closing` IN ITS
// OWN BATCH, with the reason, so a link's state never disagrees with the money; after the write,
// `closeOpenLinksAfterWrite` closes them at Devolada under `waitUntil`, and the sweep retries what
// it could not (D12 step 3). A link whose money already reached the sale is never closed while its
// payment is in flight: closing it would turn that payment `unapplied` — money to return that the
// sale already holds, verified by hand or accepted (D13, D15). Its verdict ends it (apply).

/** Which open links a write touches. Omitted, every open link of the sale. */
export interface LinkClosingScope {
  kinds?: DevoladaLinkKind[]
  /**
   * A write about these lines only: settlement links are limited to the whole-sale ones and these
   * lines' own. Another line's link still asks exactly what its line owes, so it stays open (D13).
   */
  forLines?: string[]
  /**
   * Only the links that collect a row verified at this instant by this actor: the rows the admin's
   * Verificar flipped in the same batch (D13). A settlement link collects no row while open.
   */
  rowsVerified?: { at: Date; actorId: string | null }
}

// `coalesce`: a link with no payment yet has no current status, and NULL must read as "not in flight".
const IN_FLIGHT_SQL = sql`coalesce(${currentPaymentStatusSql(sql`devolada_links.id`)}, '') in ('validating', 'queued_for_credit')`
/** Never closed by a write: the link's money reached the sale, and its payment is in flight. */
const KEPT_UNTIL_VERDICT_SQL = sql`(${linkMoneyAppliedSql('devolada_links')} and ${IN_FLIGHT_SQL})`

function closingScopeSql(organizationId: string, folioId: string, scope: LinkClosingScope): (SQL | undefined)[] {
  const { kinds, forLines, rowsVerified } = scope
  return [
    eq(devoladaLinks.organizationId, organizationId),
    eq(devoladaLinks.folioId, folioId),
    inArray(devoladaLinks.state, ['creating', 'open']),
    kinds ? inArray(devoladaLinks.kind, kinds) : undefined,
    forLines
      ? or(
          ne(devoladaLinks.kind, 'settlement'),
          isNull(devoladaLinks.folioLineId),
          forLines.length ? inArray(devoladaLinks.folioLineId, forLines) : undefined,
        )
      : undefined,
    rowsVerified
      ? sql`exists (select 1 from folio_payments vp
          where vp.id = devolada_links.folio_payment_id and vp.organization_id = devolada_links.organization_id
            and vp.verification = 'verified' and vp.verified_at = ${Math.floor(rowsVerified.at.getTime() / 1000)}
            and vp.verified_by is ${rowsVerified.actorId})`
      : undefined,
    sql`not ${KEPT_UNTIL_VERDICT_SQL}`,
  ]
}

/** A link a write marked `closing`, as `markLinksClosingStatement` returns it. */
export interface ClosedLink {
  id: string
  kind: DevoladaLinkKind
  folioLineId: string | null
  closedReason: DevoladaLinkClosedReason | null
  requestedBy: string
}

/**
 * D13 — the statement that marks the links a write touches `closing`, with the reason, for that
 * write's own `db.batch`. Un-awaited; it returns the links it marked (`ClosedLink`). `gate` is the
 * batch's own transition (constitution V): without it, the statement runs for whoever reaches it.
 */
export function markLinksClosingStatement(
  db: Db,
  organizationId: string,
  folioId: string,
  reason: DevoladaLinkClosedReason | SQL,
  { at, gate, ...scope }: LinkClosingScope & { at: Date; gate?: SQL },
) {
  return db
    .update(devoladaLinks)
    .set({ state: 'closing', closedReason: reason, updatedAt: at })
    .where(and(...closingScopeSql(organizationId, folioId, scope), gate))
    .returning({
      id: devoladaLinks.id,
      kind: devoladaLinks.kind,
      folioLineId: devoladaLinks.folioLineId,
      closedReason: devoladaLinks.closedReason,
      requestedBy: devoladaLinks.requestedBy,
    })
}

/**
 * D13 — why a line cancellation closes a link, read at the statement's turn in the batch, after the
 * folio's own flip: a whole-sale link no longer matches the balance (`amount_changed`) while the
 * sale keeps a live line; a cancelled line's own link, and every link once the last line goes,
 * `cancelled`.
 */
export const lineCancellationReasonSql = (organizationId: string, folioId: string): SQL =>
  sql`case when devolada_links.folio_line_id is null and exists (
    select 1 from folios rf where rf.id = ${folioId} and rf.organization_id = ${organizationId} and rf.cancelled_at is null
  ) then 'amount_changed' else 'cancelled' end`

/**
 * FR-011, D13 — whether a write of this scope would close a link whose payment is in flight. While
 * the sale lives, that write answers 409 `SETTLEMENT_IN_PROGRESS`, and the seller waits for the
 * verdict: closing the link would turn the customer's payment `unapplied`, money to return.
 */
export async function closesLinkInFlight(
  db: Db,
  organizationId: string,
  folioId: string,
  scope: LinkClosingScope,
): Promise<boolean> {
  const [row] = await db
    .select({ id: devoladaLinks.id })
    .from(devoladaLinks)
    .where(and(...closingScopeSql(organizationId, folioId, scope), IN_FLIGHT_SQL))
    .limit(1)
  return !!row
}

/**
 * D13 — after the write that marked them, closes the sale's `closing` links at Devolada, each with
 * its own credential (D21). For `waitUntil`: it never throws, and a link it cannot close stays
 * `closing` for the sweep (D12 step 3).
 */
export async function closeOpenLinksAfterWrite(
  deps: IssueLinkDeps,
  organizationId: string,
  folioId: string,
): Promise<void> {
  try {
    const closing = await deps.db
      .select()
      .from(devoladaLinks)
      .where(
        and(
          eq(devoladaLinks.organizationId, organizationId),
          eq(devoladaLinks.folioId, folioId),
          eq(devoladaLinks.state, 'closing'),
        ),
      )
    for (const link of closing) await closePaymentLinkRemote(deps, link)
  } catch (err) {
    console.error('[devolada] closing the links of a sale failed', folioId, err)
  }
}

/**
 * D8 — the sale's settlement link still taking money (`creating` or `open`): one per sale, by the
 * partial unique index. A transfer settlement of its scope gets it back; one of another scope waits
 * for it (contracts § settle).
 */
export async function openSettlementLink(
  db: Db,
  organizationId: string,
  folioId: string,
): Promise<{ id: string; folioLineId: string | null } | null> {
  const [open] = await db
    .select({ id: devoladaLinks.id, folioLineId: devoladaLinks.folioLineId })
    .from(devoladaLinks)
    .where(
      and(
        eq(devoladaLinks.organizationId, organizationId),
        eq(devoladaLinks.folioId, folioId),
        eq(devoladaLinks.kind, 'settlement'),
        inArray(devoladaLinks.state, ['creating', 'open']),
      ),
    )
    .limit(1)
  return open ?? null
}

/** D5 — the create's Idempotency-Key: the row's id, suffixed `#<n>` after a refusal. */
export const createKeyOf = (link: Pick<DevoladaLink, 'id' | 'createAttempts'>): string =>
  link.createAttempts > 1 ? `${link.id}#${link.createAttempts}` : link.id

/**
 * D12 step 3 — learns Devolada's id for a link whose create never recorded an outcome, by sending
 * the same create again with the same key: Devolada answers the first request's link when it
 * reached Devolada, and creates it now when it did not. Either way the id is stored. A refusal
 * means Devolada never created it, and the link becomes `failed`. Fail-soft, like the close.
 */
export async function replayPaymentLinkCreate(
  deps: IssueLinkDeps,
  link: Pick<
    DevoladaLink,
    'id' | 'organizationId' | 'folioId' | 'credentialId' | 'devoladaLinkId' | 'amount' | 'expiresAt' | 'createAttempts'
  >,
): Promise<{ devoladaLinkId: string } | 'pending' | 'failed' | 'rate_limited'> {
  const { db, env } = deps
  const scope = and(eq(devoladaLinks.id, link.id), eq(devoladaLinks.organizationId, link.organizationId))
  try {
    const credential = await loadLinkCredential(deps, link)
    if (!credential?.apiKey) {
      console.error('[devolada] link create not replayed: its credential is unreadable here', link.id)
      return 'pending'
    }
    const res = await devoladaClient(env, credential.apiKey).createPaymentLink(
      {
        customerRef: link.folioId,
        askCents: link.amount,
        mode: 'one_time',
        expiresAt: Math.floor(link.expiresAt.getTime() / 1000),
      },
      { idempotencyKey: createKeyOf(link) },
    )
    if (res.ok) {
      await db
        .update(devoladaLinks)
        .set({ devoladaLinkId: res.data.id, url: res.data.url, updatedAt: new Date() })
        .where(and(scope, isNull(devoladaLinks.devoladaLinkId)))
      return { devoladaLinkId: res.data.id }
    }
    if (res.code === 'RATE_LIMITED') return 'rate_limited'
    const reason = brokenReasonOf(res)
    if (reason === 'DEVOLADA_CREDENTIAL_REJECTED' || reason === 'DEVOLADA_BUSINESS_SUSPENDED') {
      // D21 — a retired key's rejection: with no Devolada id, no other key can find the link.
      if (reason === 'DEVOLADA_CREDENTIAL_REJECTED' && !credential.isCurrent) {
        return (await fallBackLinkCredential(deps, link)) === 'failed' ? 'failed' : 'pending'
      }
      if (credential.isCurrent) await markConnectionBroken(db, link.organizationId, reason, credential.credentialId)
      return 'pending'
    }
    if (res.kind !== 'refused') return 'pending'
    console.error('[devolada] link create replay refused', link.id, res.code, res.message)
    await db
      .update(devoladaLinks)
      .set({ state: 'failed', updatedAt: new Date() })
      .where(and(scope, isNull(devoladaLinks.devoladaLinkId), inArray(devoladaLinks.state, ['closing', 'abandoned'])))
    return 'failed'
  } catch (err) {
    console.error('[devolada] link create replay failed', link.id, err)
    return 'pending'
  }
}
