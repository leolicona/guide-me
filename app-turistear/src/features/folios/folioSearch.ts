// US-A83 (docs/oversight/folio-list-search.spec.md) — the local search, as pure functions.
//
// It mirrors the server's `?q=` exactly: the same five fields, the same normalisation, the same
// two-character floor. That symmetry is the point — the screen filters locally first and only asks
// the server when nothing matched, so if the two disagreed the same query would give two answers
// depending on how many rows happened to be loaded.

import type { FolioListItem } from './types'

/** Below this a substring match returns everything, so it is not a filter (rule 7). */
export const MIN_QUERY_LENGTH = 2

/**
 * Lowercase, strip accents, fold `ñ`.
 *
 * `NFD` splits a letter from its accent so the combining marks can be dropped wholesale — `ñ` is
 * folded explicitly afterwards because it is a letter in Spanish, not an accented `n`, and users
 * type `munoz` for `Muñoz` regardless.
 */
export const normalize = (raw: string): string =>
  raw
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ñ/g, 'n')

const digits = (raw: string | null | undefined): string => (raw ?? '').replace(/\D/g, '')

/**
 * Does this folio match? The five fields a folio actually gets described by (D2).
 *
 * `query` must already be normalised — the caller normalises once per keystroke rather than once
 * per row, which for a few hundred rows is the difference that keeps typing feeling instant.
 *
 * The seller/operator arm carries its stated cost: `ana` matches sales TO Ana and sales BY Ana.
 * That was asked for explicitly and is recorded as D2, not discovered in the field.
 */
export const matchesQuery = (folio: FolioListItem, query: string): boolean => {
  if (query.length < MIN_QUERY_LENGTH) return true

  const haystacks = [
    folio.customer_name,
    folio.agent?.name,
    folio.operator_name,
    // The same 8 characters `{folio_ref}` renders in the WhatsApp template.
    folio.id?.slice(0, 8),
    // A folio with three lines is still one row: `some`, not a flattened join.
    ...(folio.lines ?? []).map((l) => l.service_name),
  ]
  if (haystacks.some((h) => h && normalize(h).includes(query))) return true

  // The phone is compared digits-to-digits: it is stored `+52 998 123 4567` and typed `9981234567`.
  const queryDigits = query.replace(/\D/g, '')
  if (queryDigits.length >= MIN_QUERY_LENGTH) {
    return digits(folio.customer_phone).includes(queryDigits)
  }
  return false
}

/** The org-local calendar day of an instant, as `YYYY-MM-DD`. `en-CA` is the locale that formats
 *  dates in that order — used as a key, never shown. */
export const orgDay = (unixSeconds: number, tz?: string): string =>
  new Date(unixSeconds * 1000).toLocaleDateString('en-CA', { timeZone: tz })

/** Calendar arithmetic on the day string, never `now − 86400`: subtracting a fixed number of
 *  seconds lands on the wrong day across a DST boundary. */
export const shiftDay = (day: string, delta: number): string => {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + delta)
  return d.toISOString().slice(0, 10)
}

const MONTHS_ABBR = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']

/** "3 ago" / "3 ago – 12 ago" — the label the range pill wears, so the strip states the filter
 *  without the calendar being opened. */
export const rangeLabel = (from: string, to: string): string => {
  const day = (d: string) => {
    const [, m, dd] = d.split('-').map(Number)
    return `${dd} ${MONTHS_ABBR[m - 1]}`
  }
  return from === to ? day(from) : `${day(from)} – ${day(to)}`
}
