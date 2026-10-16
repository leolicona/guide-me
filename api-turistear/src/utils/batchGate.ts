import { getTableColumns, is, SQL, sql } from 'drizzle-orm'
import type { SQLiteTable } from 'drizzle-orm/sqlite-core'
import type { Db } from '../db/client'

// devolada-transfer-verification D11 (constitution V) — a statement inside a `db.batch` that must
// not run unless an earlier statement of the same batch took effect. D1 executes every statement of
// a batch, so each later one carries the condition itself: an UPDATE in its WHERE, an INSERT as
// INSERT … SELECT … WHERE. This builds the second.

/**
 * `INSERT INTO table SELECT <row> WHERE <gate>`: the row is written only while `gate` holds. Every
 * column gets a value in the table's own order — the row's, else the column's declared default,
 * else NULL — which is what a plain `.values()` insert would write.
 */
export const insertWhere = (db: Db, table: SQLiteTable, row: Record<string, unknown>, gate: SQL) => {
  const values = Object.entries(getTableColumns(table)).map(([key, column]) => {
    const value = row[key]
    if (value === null) return sql`null`
    if (value !== undefined) return sql`${column.mapToDriverValue(value)}`
    if (is(column.default, SQL)) return column.default
    if (column.default !== undefined) return sql`${column.mapToDriverValue(column.default)}`
    if (column.defaultFn) return sql`${column.mapToDriverValue(column.defaultFn())}`
    return sql`null`
  })
  return db.insert(table).select(sql`SELECT ${sql.join(values, sql`, `)} WHERE ${gate}`)
}
