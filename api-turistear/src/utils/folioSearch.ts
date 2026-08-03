// US-A83 (docs/oversight/folio-list-search.spec.md) — the `?q=` predicate and the org-local date
// range, in one place because both are "ways to reach past the load window" (D11/D12).

import { and, eq, exists, gte, lte, or, sql, type SQL } from 'drizzle-orm'
import type { Db } from '../db/client'
import { affiliateOperators, folioLines, folios, users } from '../db/schema'
import { naiveEpoch } from './tz'

/** Below this a `LIKE %x%` scans the table to return everything, so it is not a filter (rule 7). */
export const MIN_QUERY_LENGTH = 2

/** An unindexed scan needs a ceiling (D6). Not a meaningful number — just a bounded one. */
export const SEARCH_LIMIT = 50

/**
 * Lowercase and strip the seven Spanish accented forms, in SQL.
 *
 * D1/SQLite ships no `unaccent` and no ICU collation, so this is the honest option left. The two
 * alternatives were both worse: a normalised column is a second copy of every name that can drift
 * from the first, and an accent-sensitive fallback would make the SERVER disagree with the client
 * over the same query — one search, two answers, depending on how many rows happened to be loaded.
 *
 * `ñ → n` is deliberate, not collateral: `Muñoz` should be found by typing `munoz`.
 */
const unaccent = (col: SQL | unknown): SQL => sql`
  replace(replace(replace(replace(replace(replace(replace(
    lower(${col}),
  'á','a'),'é','e'),'í','i'),'ó','o'),'ú','u'),'ü','u'),'ñ','n')`

/** Digits only — a phone is written a dozen ways and typed as one. */
const digitsOnly = (col: SQL | unknown): SQL => sql`
  replace(replace(replace(replace(replace(${col}, ' ', ''), '-', ''), '(', ''), ')', ''), '+', '')`

/** The same normalisation the client applies, so both sides answer identically (D3). */
export const normalizeQuery = (raw: string): string =>
  raw
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ñ/g, 'n')

/**
 * The five fields a folio actually gets described by (D2/rule 4).
 *
 * The service name lives in `folio_lines`, so it is matched through `EXISTS` rather than a join —
 * a folio with three lines must appear once, not three times, and this predicate is `OR`-ed into a
 * query that already returns one row per folio.
 *
 * The seller/operator arm is the one with a stated cost: searching `Ana` returns sales *to* Ana and
 * sales *by* Ana. That was asked for explicitly and is recorded as D2, not discovered later.
 */
export const searchFilter = (db: Db, org: string, normalized: string): SQL => {
  const like = `%${normalized}%`
  const digits = normalized.replace(/\D/g, '')

  const arms: SQL[] = [
    sql`${unaccent(folios.customerName)} LIKE ${like}`,
    sql`${unaccent(users.name)} LIKE ${like}`,
    sql`${unaccent(affiliateOperators.name)} LIKE ${like}`,
    // The folio ref the WhatsApp template renders: the id's first 8 characters (`delivery.ts:102`).
    sql`lower(substr(${folios.id}, 1, 8)) LIKE ${like}`,
    exists(
      db
        .select({ one: sql`1` })
        .from(folioLines)
        .where(
          and(
            eq(folioLines.folioId, folios.id),
            eq(folioLines.organizationId, org),
            sql`${unaccent(folioLines.serviceName)} LIKE ${like}`,
          ),
        ),
    ),
  ]

  // Only when the query contains digits — otherwise `%%` would match every folio with a phone.
  if (digits.length >= MIN_QUERY_LENGTH) {
    arms.push(sql`${digitsOnly(folios.customerPhone)} LIKE ${`%${digits}%`}`)
  }

  return or(...arms)!
}

/**
 * An inclusive org-local day range over `created_at` (rule 1).
 *
 * `to` is resolved to the START of the following day rather than `23:59`, so a sale at 23:59:30 is
 * inside the range it obviously belongs to. Either bound may be absent.
 */
export const dateRangeFilter = (
  tz: string,
  from: string | undefined,
  to: string | undefined,
): SQL | null => {
  const bounds: SQL[] = []
  if (from) bounds.push(gte(folios.createdAt, new Date(naiveEpoch(from, '00:00', tz) * 1000)))
  if (to) {
    const next = new Date(`${to}T00:00:00Z`)
    next.setUTCDate(next.getUTCDate() + 1)
    bounds.push(
      lte(folios.createdAt, new Date(naiveEpoch(next.toISOString().slice(0, 10), '00:00', tz) * 1000 - 1000)),
    )
  }
  return bounds.length ? and(...bounds)! : null
}

/** `YYYY-MM-DD` or nothing. A malformed date falls through to "no filter", like every other
 *  parameter on this route. */
export const asDay = (raw: string | undefined): string | undefined =>
  raw && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : undefined
