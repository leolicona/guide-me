import { and, asc, eq, sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import { affiliateOperators, folioEvents, users } from '../db/schema'

// US-A24 / US-AG53 (docs/folios/folio-timeline.spec.md) — builder that RETURNS a Drizzle insert
// statement for a folio_events row, so a caller adds it to its own `db.batch(...)` and the
// narrative row lands ATOMICALLY with the mutation it records (D3, the BUG-013 lesson).
//
// One row per USER ACTION (D9): a transfer rejection writes `transfer_rejected`, not
// `transfer_rejected` + `cancelled`. `at` is the event's OWN moment — pass the same Date the
// mutation stamps (settled_at, cancelled_at, …), never a second `new Date()`, so the narrative
// and the audit columns can never disagree (business rule 6 / S-6).

export type FolioEventType =
  | 'created'
  | 'payment'
  | 'payment_verified'
  | 'transfer_rejected'
  | 'tickets_sent'
  | 'tickets_viewed'
  | 'reminder_sent'
  | 'rescheduled'
  | 'cancelled'
  | 'refund_confirmed'

interface FolioEventInput {
  organizationId: string
  folioId: string
  type: FolioEventType
  // NULL = the system (the expiry sweep) or the tourist (the Visto beacon).
  actorId?: string | null
  // The PIN shift that acted (US-A68); null for an in-house (agent/admin) action.
  operatorId?: string | null
  // Shape per event_type (spec § Data Model). Stored as JSON text; nullish values are kept out.
  payload?: Record<string, unknown>
  // ONE clock domain — the request's (JS). Never a DB default here: the Workers runtime freezes
  // Date.now() per request while unixepoch() keeps moving, so a mixed-domain narrative can sort a
  // later action before an earlier one. Where the mutation stamps a JS date (settled_at,
  // cancelled_at, …) pass THAT date; where it uses a DB default (confirmSale's created_at), the
  // sub-second drift is accepted — ordering is what the timeline exists for.
  at: Date
}

export const folioEventRow = (db: Db, input: FolioEventInput) =>
  db.insert(folioEvents).values({
    id: crypto.randomUUID(),
    organizationId: input.organizationId,
    folioId: input.folioId,
    eventType: input.type,
    actorId: input.actorId ?? null,
    operatorId: input.operatorId ?? null,
    payload: input.payload ? JSON.stringify(prune(input.payload)) : null,
    createdAt: input.at,
  })

// Drop nullish keys so a payload never carries `"reason": null` noise.
const prune = (payload: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(payload).filter(([, v]) => v !== null && v !== undefined))

// The one read (business rule 6): the folio detail, oldest-first — the sale as a story. The rowid
// tiebreak keeps same-second neighbours (a sale's `created` + its deposit; the backfill's insert
// order) in insertion order. Actors resolve at read (D10); actor NULL renders Sistema/Cliente
// client-side. Server-derived in its entirety — never accepted from any body.
export const readFolioEvents = async (db: Db, org: string, folioId: string) => {
  const rows = await db
    .select({
      id: folioEvents.id,
      type: folioEvents.eventType,
      at: folioEvents.createdAt,
      actorId: folioEvents.actorId,
      actorName: users.name,
      operatorName: affiliateOperators.name,
      backfilled: folioEvents.backfilled,
      payload: folioEvents.payload,
    })
    .from(folioEvents)
    .leftJoin(users, eq(users.id, folioEvents.actorId))
    .leftJoin(affiliateOperators, eq(affiliateOperators.id, folioEvents.operatorId))
    .where(and(eq(folioEvents.folioId, folioId), eq(folioEvents.organizationId, org)))
    .orderBy(asc(folioEvents.createdAt), sql`folio_events.rowid asc`)
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    at: Math.floor(r.at.getTime() / 1000),
    actor: r.actorId ? { id: r.actorId, name: r.actorName } : null,
    operator_name: r.operatorName,
    backfilled: r.backfilled,
    payload: r.payload ? (JSON.parse(r.payload) as Record<string, unknown>) : null,
  }))
}
