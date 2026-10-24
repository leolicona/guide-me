import { and, asc, eq, isNotNull, isNull, lte, or, sql } from 'drizzle-orm'
import { getDb, type Db } from '../../db/client'
import { devoladaCredentials, devoladaLinks, type DevoladaLink } from '../../db/schema'
import { devoladaClient, type DevoladaPaymentRead } from '../../services/devolada'
import { currentPaymentOf } from '../../utils/devoladaLinkView'
import { currentPaymentStatusSql, IN_FLIGHT_STATUSES, unresolvedLinkSql } from '../../utils/devoladaSql'
import { cancelForUnreceivedTransfer } from '../pos/unreceivedTransfer'
import { applyDevoladaPayment } from './apply'
import {
  brokenReasonOf,
  fallBackLinkCredential,
  loadLinkCredential,
  markConnectionBroken,
  type LinkCredential,
} from './connection'
import { closePaymentLinkRemote, replayPaymentLinkCreate } from './links'

// devolada-transfer-verification D12 — the recovery sweep, a third independent run on the API's
// cron (every 15 minutes, dev and production; a preview has none).
//
// It follows every open link to its verdict, whatever its organization's connection status, each
// with the link's own credential (D21): a notification Devolada could not deliver is applied at
// most 25 minutes later (SC-003). Like `sweepExpiredBookings` it has no actor: it selects due rows
// across organizations, then acts on each with that row's own `organization_id` (constitution III).
// It is fail-soft per organization and per sale, and it never cancels anything on the clock alone.
//
// A link past its expiry is acted on only after a successful re-read: with no payment, or an expired
// one, D9's unpaid branch cancels its sale (D11); with a payment in flight it stays open; with any
// other verdict it only expires, and the admin decides (FR-016). A link closed under a payment in
// flight is re-read too, until that payment's verdict (FR-012). Links left `closing` are closed at
// Devolada until it acknowledges, and abandoned ones are replayed with the same key and closed.

/** A link nothing has reported on for this long is re-read. */
const RECHECK_AFTER_SECONDS = 10 * 60
/** Devolada allows 120 calls a minute per business, shared with live traffic. */
const CALL_BUDGET_PER_ORG = 50
/** A row left `creating` this long belongs to a request that died before recording an outcome. */
const CREATING_TIMEOUT_SECONDS = 5 * 60

export interface DevoladaSweepResult {
  checked: number
  applied: number
  failed: number
}

class OrgStop extends Error {}

const IN_FLIGHT: ReadonlySet<string> = new Set(IN_FLIGHT_STATUSES)

export async function sweepDevoladaPayments(env: CloudflareBindings, now: Date): Promise<DevoladaSweepResult> {
  const db = getDb(env)
  const nowSec = Math.floor(now.getTime() / 1000)
  const result: DevoladaSweepResult = { checked: 0, applied: 0, failed: 0 }
  // The ticket email of a sale this run clears is awaited before the run ends.
  const pending: Promise<unknown>[] = []
  const deps = { db, env, waitUntil: (p: Promise<unknown>) => void pending.push(p) }

  // D12 step 3 — a row left `creating` for more than 5 minutes: the request that wrote it died.
  await db
    .update(devoladaLinks)
    .set({ state: 'abandoned', updatedAt: now })
    .where(
      and(
        eq(devoladaLinks.state, 'creating'),
        lte(devoladaLinks.createdAt, new Date((nowSec - CREATING_TIMEOUT_SECONDS) * 1000)),
      ),
    )

  // D12 step 1 — open links unchecked for 10 minutes, or past their expiry: past expiry first,
  // then never checked, then the oldest check, so the budget never starves a sale.
  const due = await db
    .select()
    .from(devoladaLinks)
    .where(
      and(
        eq(devoladaLinks.state, 'open'),
        or(
          isNull(devoladaLinks.lastCheckedAt),
          lte(devoladaLinks.lastCheckedAt, new Date((nowSec - RECHECK_AFTER_SECONDS) * 1000)),
          lte(devoladaLinks.expiresAt, now),
        ),
      ),
    )
    .orderBy(
      sql`case when ${devoladaLinks.expiresAt} <= ${nowSec} then 0 else 1 end`,
      sql`case when ${devoladaLinks.lastCheckedAt} is null then 0 else 1 end`,
      asc(devoladaLinks.lastCheckedAt),
      asc(devoladaLinks.createdAt),
    )

  // D12 step 1 — and closed links whose current payment is still in flight, unchecked for 10 minutes:
  // a cancellation or Rechazar closed them under that payment, whose verdict is money to return.
  const followed = await closedInFlightLinksQuery(db, nowSec)

  // D12 step 3 — links left `closing`: the sale stopped taking that money, and Devolada has not
  // acknowledged the close yet. Read now, so a link this run marks `closing` is closed once, by the
  // write that marked it.
  const closing = await db
    .select()
    .from(devoladaLinks)
    .where(eq(devoladaLinks.state, 'closing'))
    .orderBy(asc(devoladaLinks.updatedAt), asc(devoladaLinks.createdAt))

  // D12 step 3 — abandoned links whose create is surely over: the request timed out, or died.
  const abandoned = await db
    .select()
    .from(devoladaLinks)
    .where(
      and(
        eq(devoladaLinks.state, 'abandoned'),
        lte(devoladaLinks.createdAt, new Date((nowSec - CREATING_TIMEOUT_SECONDS) * 1000)),
      ),
    )
    .orderBy(asc(devoladaLinks.createdAt))

  const byOrg = new Map<string, OrgLinks>()
  const bucketOf = (org: string) => {
    let bucket = byOrg.get(org)
    if (!bucket) byOrg.set(org, (bucket = { due: [], closing: [], abandoned: [] }))
    return bucket
  }
  for (const link of [...due, ...followed]) bucketOf(link.organizationId).due.push(link)
  for (const link of closing) bucketOf(link.organizationId).closing.push(link)
  for (const link of abandoned) bucketOf(link.organizationId).abandoned.push(link)

  for (const [org, links] of byOrg) {
    try {
      await sweepOrganization(deps, org, links, nowSec, result)
    } catch (err) {
      // Fail-soft: one organization never stops another.
      if (!(err instanceof OrgStop)) console.error('[devolada] sweep failed for an organization', org, err)
      result.failed += 1
    }
  }

  await eraseRetiredCredentials(db, now)
  await Promise.allSettled(pending)
  return result
}

/**
 * D12 step 1, FR-012 — closed links whose CURRENT payment is still in flight and nothing reported on
 * for 10 minutes, across organizations. The candidates come from devolada_payments (status, link_id),
 * each link by its primary key, and its current payment through devolada_payments (link_id).
 */
export const closedInFlightLinksQuery = (db: Db, nowSec: number) =>
  db
    .select()
    .from(devoladaLinks)
    .where(
      and(
        sql`${devoladaLinks.id} in (
          select dp.link_id from devolada_payments dp where dp.status in ('validating', 'queued_for_credit'))`,
        // Unary `+` keeps the planner off (state, expires_at): closed links only grow, while the
        // payments in flight are a handful.
        sql`+${devoladaLinks.state} = 'closed'`,
        sql`${currentPaymentStatusSql(sql`devolada_links.id`)} in ('validating', 'queued_for_credit')`,
        or(
          isNull(devoladaLinks.lastCheckedAt),
          lte(devoladaLinks.lastCheckedAt, new Date((nowSec - RECHECK_AFTER_SECONDS) * 1000)),
        ),
      ),
    )
    .orderBy(asc(devoladaLinks.lastCheckedAt), asc(devoladaLinks.createdAt))

interface OrgLinks {
  due: DevoladaLink[]
  closing: DevoladaLink[]
  abandoned: DevoladaLink[]
}

async function sweepOrganization(
  deps: { db: Db; env: CloudflareBindings; waitUntil: (p: Promise<unknown>) => void },
  org: string,
  { due: links, closing, abandoned }: OrgLinks,
  nowSec: number,
  result: DevoladaSweepResult,
): Promise<void> {
  const { db, env } = deps
  let calls = 0
  const spend = () => {
    if (calls >= CALL_BUDGET_PER_ORG) throw new OrgStop()
    calls += 1
  }
  // Credentials this run stopped using: a rejected or suspended key, or one unreadable here.
  const skipped = new Set<string>()
  const credentials = new Map<string, LinkCredential | null>()
  const credentialOf = async (link: DevoladaLink) => {
    if (!credentials.has(link.credentialId)) {
      credentials.set(link.credentialId, await loadLinkCredential(deps, link))
    }
    return credentials.get(link.credentialId) ?? null
  }

  // Grouped by sale, then by credential: one read of the sale's payments by customer reference
  // answers every link of the sale that credential can see. Groups keep the order the selection gave.
  const groups = new Map<string, DevoladaLink[]>()
  for (const link of links) {
    const key = `${link.folioId}|${link.credentialId}`
    const list = groups.get(key) ?? []
    list.push(link)
    groups.set(key, list)
  }

  for (const group of groups.values()) {
    const [first] = group
    if (!first || skipped.has(first.credentialId)) continue
    try {
      const credential = await credentialOf(first)
      if (!credential) continue // erased: nothing about these links is left to read
      if (!credential.apiKey) {
        // D17 — this environment cannot read the key: skip its links, and say so.
        console.error('[devolada] sweep skips links whose credential is unreadable here', first.credentialId)
        skipped.add(first.credentialId)
        result.failed += 1
        continue
      }
      spend()
      const read = await devoladaClient(env, credential.apiKey).listPaymentsByCustomer(first.folioId)
      if (!read.ok) {
        if (read.code === 'RATE_LIMITED') throw new OrgStop()
        const reason = brokenReasonOf(read)
        if (reason === 'DEVOLADA_CREDENTIAL_REJECTED' && !credential.isCurrent) {
          // D21 — a retired key Devolada rejects: the current key may read its links.
          skipped.add(first.credentialId)
          for (const link of links.filter((l) => l.credentialId === first.credentialId)) {
            spend()
            await fallBackLinkCredential(deps, link)
          }
          continue
        }
        if (reason === 'DEVOLADA_CREDENTIAL_REJECTED' || reason === 'DEVOLADA_BUSINESS_SUSPENDED') {
          // The current key's rejection breaks the connection, and its links wait, unchanged, for
          // the admin's new key; a retired key's suspended business is retried at the next run.
          if (credential.isCurrent) await markConnectionBroken(db, org, reason, credential.credentialId)
          skipped.add(first.credentialId)
          continue
        }
        result.failed += 1
        continue
      }
      await applySaleRead(deps, org, first.folioId, group, read.data, nowSec, result)
    } catch (err) {
      if (err instanceof OrgStop) throw err
      console.error('[devolada] sweep failed for a sale', first.folioId, err)
      result.failed += 1
    }
  }

  // D12 step 3 — close each `closing` link at Devolada with its own credential (D21), until Devolada
  // acknowledges. One whose create never recorded Devolada's id is first replayed with the same key,
  // once that create is surely over; one whose current credential is rejected waits for the new key.
  for (const link of closing) {
    if (skipped.has(link.credentialId)) continue
    try {
      const credential = await credentialOf(link)
      if (!credential?.apiKey) continue
      let target = link
      if (!link.devoladaLinkId) {
        if (link.createdAt.getTime() > (nowSec - CREATING_TIMEOUT_SECONDS) * 1000) continue
        spend()
        const replayed = await replayPaymentLinkCreate(deps, link)
        if (replayed === 'rate_limited') throw new OrgStop()
        if (typeof replayed === 'string') continue
        target = { ...link, devoladaLinkId: replayed.devoladaLinkId }
      }
      spend()
      // A retired credential may need D21's fallback read on top of the close.
      if (!credential.isCurrent) spend()
      const closed = await closePaymentLinkRemote(deps, target)
      if (closed === 'rate_limited') throw new OrgStop()
      if (closed === 'pending') result.failed += 1
    } catch (err) {
      if (err instanceof OrgStop) throw err
      console.error('[devolada] sweep failed to close a link', link.id, err)
      result.failed += 1
    }
  }

  // D12 step 3 — an abandoned link is replayed with the same key and its own credential (D21): the
  // link Devolada created then, or creates now, is closed as `abandoned`, since its sale took the
  // manual path. A refused replay means Devolada never created it: the link is `failed`. A rejected
  // retired key takes D21's fallback; a rejected current one breaks the connection, and the link
  // stays `abandoned` until the admin's new key.
  for (const link of abandoned) {
    if (skipped.has(link.credentialId)) continue
    try {
      const credential = await credentialOf(link)
      if (!credential?.apiKey) continue
      spend()
      const replayed = await replayPaymentLinkCreate(deps, link)
      if (replayed === 'rate_limited') throw new OrgStop()
      if (replayed === 'pending') result.failed += 1
      if (typeof replayed === 'string') continue
      const [marked] = await db
        .update(devoladaLinks)
        .set({ state: 'closing', closedReason: 'abandoned', updatedAt: new Date(nowSec * 1000) })
        .where(and(eq(devoladaLinks.id, link.id), eq(devoladaLinks.organizationId, org), eq(devoladaLinks.state, 'abandoned')))
        .returning()
      if (!marked) continue
      spend()
      if (!credential.isCurrent) spend()
      const closed = await closePaymentLinkRemote(deps, marked)
      if (closed === 'rate_limited') throw new OrgStop()
      if (closed === 'pending') result.failed += 1
    } catch (err) {
      if (err instanceof OrgStop) throw err
      console.error('[devolada] sweep failed to replay an abandoned link', link.id, err)
      result.failed += 1
    }
  }
}

/**
 * Applies one sale's re-read to every link of ours it names, then acts on the due links past their
 * expiry, by each link's current payment (D9, D12 step 2).
 */
async function applySaleRead(
  deps: { db: Db; env: CloudflareBindings; waitUntil: (p: Promise<unknown>) => void },
  org: string,
  folioId: string,
  dueLinks: DevoladaLink[],
  payments: DevoladaPaymentRead[],
  nowSec: number,
  result: DevoladaSweepResult,
): Promise<void> {
  const { db } = deps
  const now = new Date(nowSec * 1000)
  const ours = await db
    .select()
    .from(devoladaLinks)
    .where(and(eq(devoladaLinks.organizationId, org), eq(devoladaLinks.folioId, folioId)))
  const byDevoladaId = new Map(ours.filter((l) => l.devoladaLinkId).map((l) => [l.devoladaLinkId!, l]))

  // Oldest first, so a correction is applied after the payment it superseded.
  for (const payment of [...payments].sort((a, b) => a.createdAt - b.createdAt)) {
    const link = byDevoladaId.get(payment.paymentLinkId)
    if (!link) continue
    if ((await applyDevoladaPayment(deps, { link, payment })) === 'applied') result.applied += 1
  }

  for (const link of dueLinks) {
    result.checked += 1
    await db
      .update(devoladaLinks)
      .set({ lastCheckedAt: now })
      .where(and(eq(devoladaLinks.id, link.id), eq(devoladaLinks.organizationId, org)))
    // A closed link is followed for its payment's verdict only, applied above (FR-012).
    if (link.state !== 'open') continue
    if (link.expiresAt.getTime() > now.getTime()) continue
    const current = currentPaymentOf(
      payments
        .filter((p) => p.paymentLinkId === link.devoladaLinkId)
        .map((p) => ({ status: p.status, devoladaCreatedAt: new Date(p.createdAt * 1000) })),
    )
    // In flight: the customer paid in time and Banxico has not answered; the link stays open.
    // Confirmed: applied above, and nothing is cancelled.
    if (current && (IN_FLIGHT.has(current.status) || current.status === 'confirmed')) continue
    if (!current || current.status === 'expired') {
      // D9's unpaid branch: a sale or deposit link cancels its sale through D11, which keeps a sale
      // that holds other money or another payment in flight. An unpaid settlement link only
      // expires, and the apartado continues (D8).
      if (link.kind !== 'settlement') {
        await cancelForUnreceivedTransfer(deps, { organizationId: org, folioId, linkId: link.id, at: now })
        continue
      }
    }
    // A partial, invalid or unapplied verdict, or an unpaid settlement link: the link expires and
    // nothing else happens. The admin decides (FR-016), and the next run stops re-reading it.
    await db
      .update(devoladaLinks)
      .set({ state: 'expired', updatedAt: now })
      .where(
        and(eq(devoladaLinks.id, link.id), eq(devoladaLinks.organizationId, org), eq(devoladaLinks.state, 'open')),
      )
  }
}

/**
 * D12 step 4, D21 — a retired credential with no unresolved link is erased: its ciphertext goes,
 * the row stays for audit. Disconnecting retires the current one, so a disconnected organization's
 * key goes once its last link resolves and every payment of its links has its verdict. Candidates
 * are read across organizations; each erase is guarded again by its own organization and by the
 * same condition, read through the `(credential_id, state)` index.
 */
const noUnresolvedLink = sql`not exists (
  select 1 from devolada_links dl
  where dl.credential_id = ${devoladaCredentials.id} and ${unresolvedLinkSql('dl')}
)`

/** The retired, unerased credentials with no unresolved link, across organizations. */
export const erasableCredentialsQuery = (db: Db) =>
  db
    .select({ id: devoladaCredentials.id, organizationId: devoladaCredentials.organizationId })
    .from(devoladaCredentials)
    .where(and(isNotNull(devoladaCredentials.retiredAt), isNull(devoladaCredentials.erasedAt), noUnresolvedLink))

async function eraseRetiredCredentials(db: Db, now: Date): Promise<void> {
  const candidates = await erasableCredentialsQuery(db)
  for (const credential of candidates) {
    await db
      .update(devoladaCredentials)
      .set({ ciphertext: null, iv: null, erasedAt: now })
      .where(
        and(
          eq(devoladaCredentials.id, credential.id),
          eq(devoladaCredentials.organizationId, credential.organizationId),
          isNotNull(devoladaCredentials.retiredAt),
          isNull(devoladaCredentials.erasedAt),
          noUnresolvedLink,
        ),
      )
  }
}
