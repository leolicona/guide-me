import { sql, type SQL } from 'drizzle-orm'

// devolada-transfer-verification — SQL fragments shared by every read that reasons about a link's
// current payment (data-model § devolada_links, § devolada_payments). One definition, so the
// sweep's cleanup, the connection view and the read model cannot disagree.

/** Statuses of a payment Devolada is still deciding: in flight (data-model). */
export const IN_FLIGHT_STATUSES = ['validating', 'queued_for_credit'] as const

/**
 * The status of a link's current payment — its latest non-superseded one by Devolada's own
 * creation time — or NULL before the customer submits proof. `linkId` is the outer column, e.g.
 * sql`l.id`; the read goes through `devolada_payments (link_id)`.
 */
export const currentPaymentStatusSql = (linkId: SQL): SQL =>
  sql`(select dp.status from devolada_payments dp
        where dp.link_id = ${linkId} and dp.status <> 'superseded'
        order by dp.devolada_created_at desc, dp.rowid desc limit 1)`

/**
 * A link that something may still happen to at Devolada: creating, open, closing or abandoned,
 * or closed while its current payment is in flight (data-model § devolada_links). `alias` names
 * the outer `devolada_links` row.
 */
export const unresolvedLinkSql = (alias: string): SQL => {
  const a = sql.raw(alias)
  return sql`(${a}.state in ('creating', 'open', 'closing', 'abandoned')
    or (${a}.state = 'closed' and ${currentPaymentStatusSql(sql`${a}.id`)} in ('validating', 'queued_for_credit')))`
}
