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
 * or closed while its current payment is in flight (data-model § devolada_links). Its credential is
 * kept until none is left (research D12, D21). `alias` names the outer `devolada_links` row.
 */
export const unresolvedLinkSql = (alias: string): SQL => {
  const a = sql.raw(alias)
  return sql`(${a}.state in ('creating', 'open', 'closing', 'abandoned')
    or (${a}.state = 'closed' and ${currentPaymentStatusSql(sql`${a}.id`)} in ('validating', 'queued_for_credit')))`
}

// ─── The apartado expiry sweep's holds (research D8, data-model § Attention) ─────────────────────
//
// An apartado does not expire while its money is undecided: the customer may have paid. The holds
// read only link states and FINAL verdicts, never a payment's stored status alone — a link no
// credential can read keeps its last snapshot for good — and each subquery is correlated on
// `organization_id` and `folio_id` (and `folio_line_id`), so devolada_links (organization_id,
// folio_id) serves it. Aliases are ours, never input.

/**
 * A settlement link's payment awaits the admin's decision (accept or dismiss, D15): `partial` or
 * `invalid`, or last seen in flight on a link no credential can read (`failed`, D21), unresolved.
 */
const awaitsAdminSql = (link: string) => `exists (
  select 1 from devolada_payments hd
  where hd.link_id = ${link}.id and hd.resolution is null
    and (hd.status in ('partial', 'invalid')
      or (${link}.state = 'failed' and hd.status in ('validating', 'queued_for_credit'))))`

/**
 * Every line of the apartado is held, while it has: a sale or deposit link, or a whole-sale
 * settlement link, being created or open; a pending deposit that a link collects, whatever that
 * link's state — `failed`, written without a call, included (Devolada's verdict, or the admin's
 * Verificar or Rechazar, decides it; research defect 4); or a whole-sale settlement payment that
 * awaits the admin. `folio` names the outer `folios` row.
 */
export const apartadoHeldSql = (folio: string): SQL =>
  sql.raw(`exists (
  select 1 from devolada_links hl
  where hl.organization_id = ${folio}.organization_id and hl.folio_id = ${folio}.id
    and ((hl.state in ('creating', 'open') and (hl.kind <> 'settlement' or hl.folio_line_id is null))
      or (hl.kind = 'deposit' and exists (
        select 1 from folio_payments hp where hp.id = hl.folio_payment_id and hp.verification = 'pending'))
      or (hl.kind = 'settlement' and hl.folio_line_id is null and ${awaitsAdminSql('hl')})))`)

/**
 * One line is held by its own settlement link, while it is being created or open, or its payment
 * awaits the admin; the line's siblings keep their own clocks (US-AG54 D5). `line` names the outer
 * `folio_lines` row.
 */
export const lineHeldSql = (line: string): SQL =>
  sql.raw(`exists (
  select 1 from devolada_links ll
  where ll.organization_id = ${line}.organization_id and ll.folio_id = ${line}.folio_id
    and ll.folio_line_id = ${line}.id and ll.kind = 'settlement'
    and (ll.state in ('creating', 'open') or ${awaitsAdminSql('ll')}))`)
