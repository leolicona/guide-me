import { and, desc, eq, isNotNull, isNull, ne, or, sql } from 'drizzle-orm'
import type { Db } from '../../db/client'
import {
  devoladaConnections,
  devoladaCredentials,
  devoladaLinks,
  users,
  type DevoladaBrokenReason,
  type DevoladaConnection,
  type DevoladaLink,
  type DevoladaMode,
} from '../../db/schema'
import { devoladaClient, type DevoladaFailure } from '../../services/devolada'
import { ApiError } from '../../types/errors'
import {
  canStoreCredentials,
  decryptCredential,
  encryptCredential,
  keyHint,
} from '../../utils/devoladaCredential'
import { unresolvedLinkSql } from '../../utils/devoladaSql'

// devolada-transfer-verification D1-D3, D21 — an organization's Devolada connection: connecting,
// replacing the key, disconnecting, its health, and the credential every call about a link uses.
//
// Every key the organization connects is a row of `devolada_credentials`; the connection points to
// its CURRENT one, which new links use. Each link keeps the key that created it (D21), so the admin
// can switch Devolada accounts at any time and every payment is still followed to its verdict.

export interface ConnectionDeps {
  db: Db
  env: CloudflareBindings
}

export const API_KEY_FORMAT = /^dk_[0-9a-f]{32}$/
// D2 — an admin opening a broken connection probes it again at most every 15 minutes: the app
// re-reads the connection whenever its window regains focus, and each probe leaves a dead link in
// the business's panel.
const REPROBE_INTERVAL_SECONDS = 15 * 60

export const PROBE_CUSTOMER_REF = 'turistear-conexion'
const PROBE_LABEL = 'Prueba de conexión — Turistear Ya!'

const nowSec = () => Math.floor(Date.now() / 1000)

// ─── The probe (D2) ──────────────────────────────────────────────────────────────────────────────

/** Devolada's refusal → the connection's broken reason, when it is one (contract § Error mapping). */
export const brokenReasonOf = (failure: Pick<DevoladaFailure, 'kind' | 'code'>): DevoladaBrokenReason | null => {
  if (failure.kind !== 'refused') return null
  if (failure.code === 'AUTHENTICATION_ERROR') return 'DEVOLADA_CREDENTIAL_REJECTED'
  if (failure.code === 'BUSINESS_SUSPENDED') return 'DEVOLADA_BUSINESS_SUSPENDED'
  if (failure.code === 'CHANNEL_UNAVAILABLE') return 'DEVOLADA_CHANNEL_UNAVAILABLE'
  return null
}

type ProbeResult = { ok: true; mode: DevoladaMode } | { ok: false; failure: DevoladaFailure }

/**
 * A one-time link born expired: the one call that uses the credential, reports its mode, and fails
 * exactly where a real sale would fail (a business without its CLABE). A fresh Idempotency-Key per
 * attempt, so a refusal is never replayed to a later, fixed attempt.
 */
async function probe(env: CloudflareBindings, apiKey: string): Promise<ProbeResult> {
  const res = await devoladaClient(env, apiKey).createPaymentLink(
    {
      customerRef: PROBE_CUSTOMER_REF,
      askCents: 100,
      mode: 'one_time',
      expiresAt: nowSec() - 60,
      label: PROBE_LABEL,
    },
    { idempotencyKey: crypto.randomUUID() },
  )
  if (res.ok) return { ok: true, mode: res.data.isTest ? 'test' : 'real' }
  return { ok: false, failure: res }
}

/** A failed probe (or address check) as the connect endpoint's refusal (contract § Connection). */
const refusalOf = (failure: DevoladaFailure): ApiError => {
  switch (brokenReasonOf(failure)) {
    case 'DEVOLADA_CREDENTIAL_REJECTED':
      return new ApiError('DEVOLADA_CREDENTIAL_REJECTED', 422, 'Devolada rejected the API key')
    case 'DEVOLADA_BUSINESS_SUSPENDED':
      return new ApiError('DEVOLADA_BUSINESS_SUSPENDED', 409, 'Devolada suspended the business')
    case 'DEVOLADA_CHANNEL_UNAVAILABLE':
      // `message` names the missing piece of the business's SPEI channel: `clabe` or `bank`.
      return new ApiError('DEVOLADA_CHANNEL_UNAVAILABLE', 409, failure.message === 'bank' ? 'bank' : 'clabe')
  }
  if (failure.kind === 'refused') {
    // A refusal of OUR request (VALIDATION_ERROR, INSECURE_URL…) is our bug, logged with
    // Devolada's message; the admin can only try again later.
    console.error('[devolada] connect refused', failure.code, failure.message)
  }
  return new ApiError('DEVOLADA_UNAVAILABLE', 502, 'Devolada could not be reached')
}

// ─── Credentials (D21) ───────────────────────────────────────────────────────────────────────────

/** Decrypts a stored key, or null when this environment cannot read it (D17). Never logs the key. */
async function readKey(
  env: CloudflareBindings,
  organizationId: string,
  row: { id: string; ciphertext: string | null; iv: string | null },
): Promise<string | null> {
  if (!row.ciphertext || !row.iv) return null
  try {
    return await decryptCredential(env, organizationId, { ciphertext: row.ciphertext, iv: row.iv })
  } catch (err) {
    console.error('[devolada] credential unreadable here', row.id, (err as Error).name)
    return null
  }
}

export interface CurrentCredential {
  connection: DevoladaConnection
  credentialId: string
  mode: DevoladaMode
  /** Null when this environment cannot decrypt it: no key, or not the key it was sealed with. */
  apiKey: string | null
}

/**
 * The key new links use, for a connection that has one (`connected` or `broken`). Only a
 * `connected` connection with a readable key issues links (links.ts, D6).
 */
export async function loadCurrentCredential(
  { db, env }: ConnectionDeps,
  organizationId: string,
): Promise<CurrentCredential | null> {
  const row = (
    await db
      .select({ connection: devoladaConnections, credential: devoladaCredentials })
      .from(devoladaConnections)
      .innerJoin(
        devoladaCredentials,
        and(
          eq(devoladaCredentials.id, devoladaConnections.currentCredentialId),
          eq(devoladaCredentials.organizationId, devoladaConnections.organizationId),
        ),
      )
      .where(
        and(
          eq(devoladaConnections.organizationId, organizationId),
          ne(devoladaConnections.status, 'disconnected'),
        ),
      )
      .limit(1)
  )[0]
  if (!row) return null
  return {
    connection: row.connection,
    credentialId: row.credential.id,
    mode: row.credential.mode,
    apiKey: await readKey(env, organizationId, row.credential),
  }
}

export interface LinkCredential {
  credentialId: string
  /** Null when this environment cannot decrypt it (D17). */
  apiKey: string | null
  /** Whether it is the organization's current credential (D21: the current one never falls back). */
  isCurrent: boolean
}

/**
 * The link's own key — the one that created it, unless D21's fallback moved it — whatever the
 * connection's status. Null once its ciphertext was erased: nothing about the link is left to read.
 */
export async function loadLinkCredential(
  { db, env }: ConnectionDeps,
  link: Pick<DevoladaLink, 'organizationId' | 'credentialId'>,
): Promise<LinkCredential | null> {
  const row = (
    await db
      .select({
        id: devoladaCredentials.id,
        ciphertext: devoladaCredentials.ciphertext,
        iv: devoladaCredentials.iv,
        currentId: devoladaConnections.currentCredentialId,
      })
      .from(devoladaCredentials)
      .leftJoin(devoladaConnections, eq(devoladaConnections.organizationId, devoladaCredentials.organizationId))
      .where(
        and(
          eq(devoladaCredentials.id, link.credentialId),
          eq(devoladaCredentials.organizationId, link.organizationId),
        ),
      )
      .limit(1)
  )[0]
  if (!row || !row.ciphertext) return null
  return {
    credentialId: row.id,
    apiKey: await readKey(env, link.organizationId, row),
    isCurrent: row.currentId === row.id,
  }
}

/**
 * D21 — a link whose RETIRED credential Devolada rejected (`AUTHENTICATION_ERROR`) on a re-read, a
 * close or a replay. The current credential is asked whether it can read the link: if so, as after
 * a rotation within one business, the link moves to it; if no credential can read it, the link
 * becomes `failed`, and its payment keeps its last state for the admin to decide. Never called for
 * the current credential (its rejection breaks the connection), nor for a suspended business.
 */
export async function fallBackLinkCredential(
  deps: ConnectionDeps,
  link: Pick<DevoladaLink, 'id' | 'organizationId' | 'credentialId' | 'devoladaLinkId'>,
): Promise<'moved' | 'failed' | 'retry'> {
  const { db } = deps
  const current = await loadCurrentCredential(deps, link.organizationId)
  const fail = async () => {
    await db
      .update(devoladaLinks)
      .set({ state: 'failed', updatedAt: new Date() })
      .where(
        and(
          eq(devoladaLinks.id, link.id),
          eq(devoladaLinks.organizationId, link.organizationId),
          eq(devoladaLinks.credentialId, link.credentialId),
          ne(devoladaLinks.state, 'paid'),
          ne(devoladaLinks.state, 'expired'),
        ),
      )
    return 'failed' as const
  }
  // No other key, or a link Devolada never gave an id: nothing can read it.
  if (!current || current.credentialId === link.credentialId || !link.devoladaLinkId) return fail()
  if (!current.apiKey) return 'retry'
  const res = await devoladaClient(deps.env, current.apiKey).getPaymentLink(link.devoladaLinkId)
  if (res.ok) {
    await db
      .update(devoladaLinks)
      .set({ credentialId: current.credentialId, mode: current.mode, updatedAt: new Date() })
      .where(
        and(
          eq(devoladaLinks.id, link.id),
          eq(devoladaLinks.organizationId, link.organizationId),
          eq(devoladaLinks.credentialId, link.credentialId),
        ),
      )
    return 'moved'
  }
  if (res.kind === 'refused' && res.code === 'NOT_FOUND') return fail()
  const reason = brokenReasonOf(res)
  if (reason === 'DEVOLADA_CREDENTIAL_REJECTED' || reason === 'DEVOLADA_BUSINESS_SUSPENDED') {
    await markConnectionBroken(db, link.organizationId, reason, current.credentialId)
  }
  return 'retry'
}

/**
 * The current credential's call was refused for a reason the admin must fix (contract § Error
 * mapping). Guarded by the credential, so a key the admin just replaced never breaks the new one.
 */
export async function markConnectionBroken(
  db: Db,
  organizationId: string,
  reason: DevoladaBrokenReason,
  credentialId: string,
): Promise<void> {
  const now = new Date()
  await db
    .update(devoladaConnections)
    .set({
      status: 'broken',
      brokenReason: reason,
      brokenAt: sql`coalesce(${devoladaConnections.brokenAt}, ${Math.floor(now.getTime() / 1000)})`,
      updatedAt: now,
    })
    .where(
      and(
        eq(devoladaConnections.organizationId, organizationId),
        eq(devoladaConnections.currentCredentialId, credentialId),
        ne(devoladaConnections.status, 'disconnected'),
      ),
    )
}

/** D9 — validation credit paused at Devolada, as the connection's health shows it. */
export async function setCreditPaused(db: Db, organizationId: string, paused: boolean): Promise<void> {
  const now = new Date()
  await db
    .update(devoladaConnections)
    .set({
      creditPausedAt: paused
        ? sql`coalesce(${devoladaConnections.creditPausedAt}, ${Math.floor(now.getTime() / 1000)})`
        : null,
      updatedAt: now,
    })
    .where(eq(devoladaConnections.organizationId, organizationId))
}

// ─── Connect, disconnect, read ───────────────────────────────────────────────────────────────────

export interface ConnectInput {
  organizationId: string
  adminId: string
  apiKey: string
  replaceWebhook: boolean
}

/** D2, D3, D21 — connect, or replace the key. Answers the connection's view. */
export async function connectDevolada(deps: ConnectionDeps, input: ConnectInput) {
  const { db, env } = deps
  const { organizationId: org, adminId, apiKey } = input

  // 0. D17 — without a readable DEVOLADA_CREDENTIAL_KEY the key could never be stored: refuse
  //    before anything reaches Devolada.
  if (!canStoreCredentials(env)) {
    console.error('[devolada] DEVOLADA_CREDENTIAL_KEY is missing or malformed in this environment')
    throw new ApiError('INTERNAL_ERROR', 500, 'Devolada is not available in this environment')
  }
  // 1. Format.
  if (!API_KEY_FORMAT.test(apiKey)) {
    throw new ApiError('VALIDATION_ERROR', 400, 'A Devolada API key is dk_ followed by 32 hex characters')
  }
  // 2. Probe.
  const probed = await probe(env, apiKey)
  if (!probed.ok) throw refusalOf(probed.failure)
  // 3. Mode policy: production takes only real credentials; everywhere else, only test ones.
  if (probed.mode !== env.DEVOLADA_KEY_MODE) {
    throw new ApiError(
      'DEVOLADA_MODE_NOT_ALLOWED',
      422,
      `This environment takes ${env.DEVOLADA_KEY_MODE} credentials`,
    )
  }
  // 4. D3 — the notification address. Where this environment registers none (local, previews),
  //    Devolada's address is neither read nor written: the business keeps whatever it has.
  const ours = env.DEVOLADA_WEBHOOK_URL || null
  let replacedWebhookUrl: string | null = null
  if (ours) {
    const client = devoladaClient(env, apiKey)
    const current = await client.getWebhook()
    let register = false
    if (current.ok) {
      if (current.data.url !== ours) {
        if (!input.replaceWebhook) throw new ApiError('DEVOLADA_WEBHOOK_CONFLICT', 409, current.data.url)
        replacedWebhookUrl = current.data.url
        register = true
      }
    } else if (current.kind === 'refused' && current.code === 'NOT_FOUND') {
      register = true
    } else {
      throw refusalOf(current)
    }
    if (register) {
      const put = await client.putWebhook(ours)
      if (!put.ok) {
        if (put.kind === 'refused' && put.code === 'INSECURE_URL') {
          console.error('[devolada] DEVOLADA_WEBHOOK_URL refused by Devolada as insecure')
          throw new ApiError('INTERNAL_ERROR', 500, 'This environment has no valid notification address')
        }
        throw refusalOf(put)
      }
    }
  }

  // 5. Store, in one batch (constitution V): the new credential becomes current, the previous one
  //    is retired — kept, while a link that uses it is unresolved (D21).
  const now = new Date()
  const credentialId = crypto.randomUUID()
  const sealed = await encryptCredential(env, org, apiKey)
  await db.batch([
    db.insert(devoladaCredentials).values({
      id: credentialId,
      organizationId: org,
      mode: probed.mode,
      ciphertext: sealed.ciphertext,
      iv: sealed.iv,
      keyHint: keyHint(apiKey),
      createdBy: adminId,
      createdAt: now,
    }),
    db
      .update(devoladaCredentials)
      .set({ retiredAt: now })
      .where(
        and(
          eq(devoladaCredentials.organizationId, org),
          isNull(devoladaCredentials.retiredAt),
          ne(devoladaCredentials.id, credentialId),
        ),
      ),
    db
      .insert(devoladaConnections)
      .values({
        id: crypto.randomUUID(),
        organizationId: org,
        status: 'connected',
        currentCredentialId: credentialId,
        webhookUrl: ours,
        replacedWebhookUrl,
        connectedBy: adminId,
        connectedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: devoladaConnections.organizationId,
        set: {
          status: 'connected',
          currentCredentialId: credentialId,
          webhookUrl: ours,
          ...(replacedWebhookUrl ? { replacedWebhookUrl } : {}),
          brokenReason: null,
          brokenAt: null,
          probedAt: null,
          connectedBy: adminId,
          connectedAt: now,
          disconnectedBy: null,
          disconnectedAt: null,
          updatedAt: now,
        },
      }),
  ])
  return readConnectionView(deps, org)
}

/**
 * FR-004, D21 — idempotent. The current credential is retired, not forgotten: links already issued
 * are followed to their verdict with it, and the sweep erases it once nothing it serves is
 * unresolved (D12). Devolada's notification address is left as it is (D3).
 */
export async function disconnectDevolada(
  deps: ConnectionDeps,
  { organizationId: org, adminId }: { organizationId: string; adminId: string },
) {
  const { db } = deps
  const now = new Date()
  await db.batch([
    db
      .update(devoladaCredentials)
      .set({ retiredAt: now })
      .where(and(eq(devoladaCredentials.organizationId, org), isNull(devoladaCredentials.retiredAt))),
    db
      .update(devoladaConnections)
      .set({
        status: 'disconnected',
        currentCredentialId: null,
        disconnectedBy: adminId,
        disconnectedAt: now,
        updatedAt: now,
      })
      .where(and(eq(devoladaConnections.organizationId, org), ne(devoladaConnections.status, 'disconnected'))),
  ])
  return readConnectionView(deps, org)
}

export interface DevoladaConnectionView {
  status: DevoladaConnection['status']
  mode: DevoladaMode | null
  key_hint: string | null
  connected_at: number
  connected_by: { id: string; name: string | null }
  broken_reason: DevoladaBrokenReason | null
  last_verdict_at: number | null
  credit_paused_since: number | null
  previous_keys: { key_hint: string; pending_links: number }[]
  webhook: {
    url: string | null
    is_ours: boolean | null
    consecutive_failures: number
    last_success_at: number | null
    last_failure_at: number | null
    failed_deliveries: number
  } | null
  health_error: 'DEVOLADA_UNAVAILABLE' | null
}

const sec = (d: Date | null): number | null => (d ? Math.floor(d.getTime() / 1000) : null)

/**
 * D21 — each retired credential not yet erased that still has unresolved links, with how many, so
 * the admin knows not to revoke it at Devolada yet. Read through the `(credential_id, state)` index.
 */
async function readPreviousKeys(db: Db, organizationId: string) {
  return db
    .select({
      key_hint: devoladaCredentials.keyHint,
      pending_links: sql<number>`count(*)`,
    })
    .from(devoladaCredentials)
    .innerJoin(devoladaLinks, eq(devoladaLinks.credentialId, devoladaCredentials.id))
    .where(
      and(
        eq(devoladaCredentials.organizationId, organizationId),
        isNotNull(devoladaCredentials.retiredAt),
        isNull(devoladaCredentials.erasedAt),
        eq(devoladaLinks.organizationId, organizationId),
        unresolvedLinkSql('devolada_links'),
      ),
    )
    .groupBy(devoladaCredentials.id)
    .orderBy(desc(devoladaCredentials.retiredAt))
}

/**
 * The admin's view of the connection (contract § DevoladaConnectionView), or null when the
 * organization never connected. Health is read live and fails soft: it never fails the request.
 * While `broken`, and at most every 15 minutes, the read first repeats D2's probe with the current
 * credential; a pass makes the connection `connected` again (D2).
 */
export async function readConnectionView(
  deps: ConnectionDeps,
  organizationId: string,
): Promise<DevoladaConnectionView | null> {
  const { db, env } = deps
  const load = async () =>
    (
      await db
        .select({
          connection: devoladaConnections,
          mode: devoladaCredentials.mode,
          keyHint: devoladaCredentials.keyHint,
          connectedByName: users.name,
        })
        .from(devoladaConnections)
        .leftJoin(
          devoladaCredentials,
          and(
            eq(devoladaCredentials.id, devoladaConnections.currentCredentialId),
            eq(devoladaCredentials.organizationId, devoladaConnections.organizationId),
          ),
        )
        .leftJoin(users, eq(users.id, devoladaConnections.connectedBy))
        .where(eq(devoladaConnections.organizationId, organizationId))
        .limit(1)
    )[0]

  let row = await load()
  if (!row) return null

  if (row.connection.status === 'broken') {
    await reprobeBroken(deps, organizationId)
    row = (await load())!
  }

  const { connection } = row
  const previousKeys = (await readPreviousKeys(db, organizationId)).map((k) => ({
    key_hint: k.key_hint,
    pending_links: Number(k.pending_links),
  }))
  const base = {
    status: connection.status,
    mode: connection.status === 'disconnected' ? null : (row.mode ?? null),
    key_hint: connection.status === 'disconnected' ? null : (row.keyHint ?? null),
    connected_at: sec(connection.connectedAt)!,
    connected_by: { id: connection.connectedBy, name: row.connectedByName ?? null },
    broken_reason: connection.brokenReason,
    last_verdict_at: sec(connection.lastVerdictAt),
    credit_paused_since: sec(connection.creditPausedAt),
    previous_keys: previousKeys,
  }
  // While disconnected nothing is read from Devolada.
  if (connection.status === 'disconnected') return { ...base, webhook: null, health_error: null }

  const current = await loadCurrentCredential(deps, organizationId)
  if (!current?.apiKey) return { ...base, webhook: null, health_error: 'DEVOLADA_UNAVAILABLE' }
  const client = devoladaClient(env, current.apiKey)
  const [endpoint, failed] = await Promise.all([client.getWebhook(), client.listFailedDeliveries()])
  const noAddress = !endpoint.ok && endpoint.kind === 'refused' && endpoint.code === 'NOT_FOUND'
  if ((!endpoint.ok && !noAddress) || !failed.ok) {
    return { ...base, webhook: null, health_error: 'DEVOLADA_UNAVAILABLE' }
  }
  const ours = env.DEVOLADA_WEBHOOK_URL || null
  const data = endpoint.ok ? endpoint.data : null
  return {
    ...base,
    webhook: {
      url: data?.url ?? null,
      // D3, D17 — null where this environment registers no address: verdicts arrive by the sweep,
      // which is expected rather than a failure.
      is_ours: ours ? data?.url === ours : null,
      consecutive_failures: data?.consecutiveFailures ?? 0,
      last_success_at: data?.lastSuccessAt ?? null,
      last_failure_at: data?.lastFailureAt ?? null,
      failed_deliveries: failed.data,
    },
    health_error: null,
  }
}

/** D2 — the broken connection's probe, stamped BEFORE the call so two reads cannot both probe. */
async function reprobeBroken(deps: ConnectionDeps, organizationId: string): Promise<void> {
  const { db, env } = deps
  const now = nowSec()
  const claimed = await db
    .update(devoladaConnections)
    .set({ probedAt: new Date(now * 1000) })
    .where(
      and(
        eq(devoladaConnections.organizationId, organizationId),
        eq(devoladaConnections.status, 'broken'),
        or(
          isNull(devoladaConnections.probedAt),
          sql`${devoladaConnections.probedAt} <= ${now - REPROBE_INTERVAL_SECONDS}`,
        ),
      ),
    )
    .returning({ id: devoladaConnections.id })
  if (!claimed[0]) return
  const current = await loadCurrentCredential(deps, organizationId)
  if (!current?.apiKey) return
  const probed = await probe(env, current.apiKey)
  if (probed.ok) {
    await db
      .update(devoladaConnections)
      .set({ status: 'connected', brokenReason: null, brokenAt: null, updatedAt: new Date() })
      .where(
        and(
          eq(devoladaConnections.organizationId, organizationId),
          eq(devoladaConnections.status, 'broken'),
          eq(devoladaConnections.currentCredentialId, current.credentialId),
        ),
      )
    return
  }
  // Still refused: the reason may have changed (a suspension lifted, a key revoked since).
  const reason = brokenReasonOf(probed.failure)
  if (reason) await markConnectionBroken(db, organizationId, reason, current.credentialId)
}

/** `GET /organizations/me` — the summary every role reads; never a credential column (D1). */
export async function readConnectionSummary(
  db: Db,
  organizationId: string,
): Promise<{ status: 'not_connected' | DevoladaConnection['status']; mode: DevoladaMode | null }> {
  const row = (
    await db
      .select({ status: devoladaConnections.status, mode: devoladaCredentials.mode })
      .from(devoladaConnections)
      .leftJoin(
        devoladaCredentials,
        and(
          eq(devoladaCredentials.id, devoladaConnections.currentCredentialId),
          eq(devoladaCredentials.organizationId, devoladaConnections.organizationId),
        ),
      )
      .where(eq(devoladaConnections.organizationId, organizationId))
      .limit(1)
  )[0]
  if (!row) return { status: 'not_connected', mode: null }
  return { status: row.status, mode: row.status === 'disconnected' ? null : (row.mode ?? null) }
}
