import { and, asc, eq, getTableColumns, sql, type SQL } from 'drizzle-orm'
import type { Db } from '../db/client'
import { folioEvents, users } from '../db/schema'

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
  // devolada-transfer-verification (data-model.md § Changes to existing types). Payloads:
  // - payment_link_issued — actor = the seller; `{link_id, kind, amount, expires_at}` (D6).
  // - payment_link_closed — actor = whoever stopped the sale, or NULL; `{link_id, reason}` (D13).
  // - payment_verdict — actor NULL; `{link_id, status, asked, received, receipt_number, awaiting}`,
  //   for partial, invalid and unapplied, and for confirmed on a cancelled sale (D9).
  // - transfer_not_received — actor NULL; `{link_id, kind}` (D11).
  // An automatic `payment_verified` has actor NULL and `{source: 'devolada', receipt_number,
  // received}` (D10).
  | 'payment_link_issued'
  | 'payment_link_closed'
  | 'payment_verdict'
  | 'transfer_not_received'

interface FolioEventInput {
  organizationId: string
  folioId: string
  type: FolioEventType
  // NULL = the system (the expiry sweep) or the tourist (the Visto beacon).
  actorId?: string | null
  // US-A22 (line-autonomy D13) — the line this event is about; omit for a folio-scoped event.
  // The payload should still NAME the line (service_name, slot_date) so the timeline renders
  // without a join and survives the line's own columns changing.
  folioLineId?: string | null
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
    folioLineId: input.folioLineId ?? null,
    payload: input.payload ? JSON.stringify(prune(input.payload)) : null,
    createdAt: input.at,
  })

// devolada-transfer-verification D10 — the same row, written only when `gate` holds when the
// statement runs. Inside a `db.batch`, a gate over the batch's own guarded transition keeps the
// narrative from claiming an action another processor already took (constitution V). Drizzle's
// insert-select names every column in the table's own order, so the values follow that order.
export const folioEventRowWhere = (db: Db, input: FolioEventInput, gate: SQL) => {
  const values: Record<string, unknown> = {
    id: crypto.randomUUID(),
    organizationId: input.organizationId,
    folioId: input.folioId,
    eventType: input.type,
    actorId: input.actorId ?? null,
    folioLineId: input.folioLineId ?? null,
    payload: input.payload ? JSON.stringify(prune(input.payload)) : null,
    backfilled: 0,
    createdAt: Math.floor(input.at.getTime() / 1000),
  }
  const columns = Object.keys(getTableColumns(folioEvents)).map((key) => {
    if (!(key in values)) throw new Error(`folioEventRowWhere: no value for folio_events.${key}`)
    return sql`${values[key]}`
  })
  return db.insert(folioEvents).select(sql`SELECT ${sql.join(columns, sql`, `)} WHERE ${gate}`)
}

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
      backfilled: folioEvents.backfilled,
      payload: folioEvents.payload,
    })
    .from(folioEvents)
    .leftJoin(users, eq(users.id, folioEvents.actorId))
    .where(and(eq(folioEvents.folioId, folioId), eq(folioEvents.organizationId, org)))
    .orderBy(asc(folioEvents.createdAt), sql`folio_events.rowid asc`)
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    at: Math.floor(r.at.getTime() / 1000),
    actor: r.actorId ? { id: r.actorId, name: r.actorName } : null,
    backfilled: r.backfilled,
    payload: r.payload ? (JSON.parse(r.payload) as Record<string, unknown>) : null,
  }))
}
