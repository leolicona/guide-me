import type { Context } from 'hono'
import { and, eq, sql } from 'drizzle-orm'
import { getDb } from '../../db/client'
import { devoladaEvents, devoladaLinks } from '../../db/schema'
import { devoladaClient } from '../../services/devolada'
import { ApiError } from '../../types/errors'
import { applyDevoladaPayment } from '../devolada/apply'
import { brokenReasonOf, loadLinkCredential, markConnectionBroken } from '../devolada/connection'
import type { DevoladaWebhookEvent } from './schema'

// devolada-transfer-verification D4 — what a verified Devolada notification does. The signature
// proved that Devolada sent it, not which business it concerns. So:
//   4. the link is found by Devolada's own link id, a globally unique key — the one lookup
//      constitution III exempts from the actor's organization, since a webhook has no actor;
//   5. the event's mode must be the link's;
//   6. an event already processed is skipped, one whose processing failed is processed again;
//   7. the payment is RE-READ with the link's own credential (D21), one of the owning
//      organization's own — another business's payment answers NOT_FOUND — and D9 is applied to
//      that answer, never to the body.
// Ordering and duplicates stop mattering: the re-read is always the current state.

export type WebhooksEnv = {
  Bindings: CloudflareBindings
  Variables: { devoladaEvent: DevoladaWebhookEvent }
}

type Outcome = 'applied' | 'no_change' | 'mode_mismatch' | 'failed'

const unavailable = () => new ApiError('DEVOLADA_UNAVAILABLE', 503, 'Devolada could not be reached')

export const receiveDevoladaWebhook = async (c: Context<WebhooksEnv>) => {
  const event = c.get('devoladaEvent')
  const db = getDb(c.env)
  const now = new Date()

  // 4. Our link, by Devolada's globally unique id. An unknown link is logged, not stored: there is
  //    no organization to scope a row to.
  const link = (
    await db.select().from(devoladaLinks).where(eq(devoladaLinks.devoladaLinkId, event.data.paymentLinkId)).limit(1)
  )[0]
  if (!link) {
    console.log('[devolada] unknown link', event.data.paymentLinkId)
    return c.json({ received: true })
  }
  const org = link.organizationId

  // 6. The inbox. A first delivery is recorded `failed` until it is processed, so a crash leaves
  //    it to Devolada's retry; a retry of a failed event bumps its attempts.
  const inbox = (outcome: Outcome) =>
    db
      .update(devoladaEvents)
      .set({ outcome })
      .where(and(eq(devoladaEvents.eventId, event.eventId), eq(devoladaEvents.organizationId, org)))
  const inserted = await db
    .insert(devoladaEvents)
    .values({
      eventId: event.eventId,
      organizationId: org,
      devoladaPaymentId: event.data.paymentId,
      type: event.type,
      eventCreatedAt: new Date(event.createdAt),
      receivedAt: now,
      outcome: 'failed',
    })
    .onConflictDoNothing({ target: devoladaEvents.eventId })
    .returning({ eventId: devoladaEvents.eventId })
  if (!inserted[0]) {
    const retried = await db
      .update(devoladaEvents)
      .set({ attempts: sql`${devoladaEvents.attempts} + 1`, receivedAt: now })
      .where(
        and(
          eq(devoladaEvents.eventId, event.eventId),
          eq(devoladaEvents.organizationId, org),
          eq(devoladaEvents.outcome, 'failed'),
        ),
      )
      .returning({ eventId: devoladaEvents.eventId })
    // Already applied, already a no-op, or a mode mismatch: a duplicate changes nothing.
    if (!retried[0]) return c.json({ received: true })
  }

  // 5. The event's mode must be the link's own, copied from the credential that created it.
  if (event.data.isTest !== (link.mode === 'test')) {
    await inbox('mode_mismatch')
    return c.json({ received: true })
  }

  // 7. The link's own credential, whatever the connection's status (D21).
  const credential = await loadLinkCredential({ db, env: c.env }, link)
  if (!credential) {
    // Erased: its payments are final, or no credential can read the link. Nothing is left to read.
    console.log('[devolada] link credential already erased', link.id)
    await inbox('no_change')
    return c.json({ received: true })
  }
  if (!credential.apiKey) throw unavailable() // D17: unreadable here; the event stays `failed`

  const read = await devoladaClient(c.env, credential.apiKey).getPayment(event.data.paymentId)
  if (!read.ok) {
    if (read.kind === 'refused' && read.code === 'NOT_FOUND') {
      // Not this organization's payment, or not this mode: change nothing.
      await inbox('no_change')
      return c.json({ received: true })
    }
    // A rejected or suspended CURRENT credential breaks the connection, and the sweep catches up
    // once the admin fixes it. A retired one leaves the connection alone: the sweep applies D21's
    // fallback to a rejection, and retries a suspension at its next run.
    const reason = brokenReasonOf(read)
    if (credential.isCurrent && (reason === 'DEVOLADA_CREDENTIAL_REJECTED' || reason === 'DEVOLADA_BUSINESS_SUSPENDED')) {
      await markConnectionBroken(db, org, reason, credential.credentialId)
    }
    throw unavailable()
  }
  if (read.data.paymentLinkId !== link.devoladaLinkId) {
    console.log('[devolada] re-read names another link', event.data.paymentId)
    await inbox('no_change')
    return c.json({ received: true })
  }

  const outcome = await applyDevoladaPayment(
    { db, env: c.env, waitUntil: (p) => c.executionCtx.waitUntil(p) },
    { link, payment: read.data },
  )
  await inbox(outcome)
  return c.json({ received: true })
}
