import { and, asc, eq, isNotNull, isNull, lte, or, sql } from 'drizzle-orm'
import { getDb, type Db } from '../../db/client'
import { devoladaCredentials, devoladaLinks, type DevoladaLink } from '../../db/schema'
import { devoladaClient, type DevoladaPaymentRead } from '../../services/devolada'
import { currentPaymentOf } from '../../utils/devoladaLinkView'
import { unresolvedLinkSql } from '../../utils/devoladaSql'
import { applyDevoladaPayment } from './apply'
import {
  brokenReasonOf,
  fallBackLinkCredential,
  loadLinkCredential,
  markConnectionBroken,
  type LinkCredential,
} from './connection'

// devolada-transfer-verification D12 — the recovery sweep, a third independent run on the API's
// cron (every 15 minutes, dev and production; a preview has none).
//
// It follows every open link to its verdict, whatever its organization's connection status, each
// with the link's own credential (D21): a notification Devolada could not deliver is applied at
// most 25 minutes later (SC-003). Like `sweepExpiredBookings` it has no actor: it selects due rows
// across organizations, then acts on each with that row's own `organization_id` (constitution III).
// It is fail-soft per organization and per sale, and it never cancels anything on the clock alone.
//
// PR 1 (research D19): an unpaid link past its expiry only moves to `expired`, after a successful
// re-read, and its sale is already back in «Por verificar» (D14). PR 2 replaces that step with D9's
// unpaid branch; PR 3 adds the replay of abandoned links and the follow-up of closed ones.

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

  const byOrg = new Map<string, DevoladaLink[]>()
  for (const link of due) {
    const list = byOrg.get(link.organizationId) ?? []
    list.push(link)
    byOrg.set(link.organizationId, list)
  }

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

async function sweepOrganization(
  deps: { db: Db; env: CloudflareBindings; waitUntil: (p: Promise<unknown>) => void },
  org: string,
  links: DevoladaLink[],
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

  // Grouped by sale, then by credential: one `GET /v1/payments?customerRef=` answers every link of
  // the sale that credential can see. Groups keep the order the selection gave.
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
}

/** Applies one sale's re-read to every link of ours it names, then expires the unpaid due ones. */
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
    // Until PR 2 (D19): after this successful re-read, an unpaid link past its expiry — no payment,
    // or an expired one — moves to `expired`, and NOTHING is cancelled: its sale is already back in
    // «Por verificar» (D14), and the next run stops re-reading it.
    if (link.expiresAt.getTime() > now.getTime()) continue
    const current = currentPaymentOf(
      payments
        .filter((p) => p.paymentLinkId === link.devoladaLinkId)
        .map((p) => ({ status: p.status, devoladaCreatedAt: new Date(p.createdAt * 1000) })),
    )
    if (current && current.status !== 'expired') continue
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
async function eraseRetiredCredentials(db: Db, now: Date): Promise<void> {
  const noUnresolvedLink = sql`not exists (
    select 1 from devolada_links dl
    where dl.credential_id = ${devoladaCredentials.id} and ${unresolvedLinkSql('dl')}
  )`
  const candidates = await db
    .select({ id: devoladaCredentials.id, organizationId: devoladaCredentials.organizationId })
    .from(devoladaCredentials)
    .where(and(isNotNull(devoladaCredentials.retiredAt), isNull(devoladaCredentials.erasedAt), noUnresolvedLink))
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

