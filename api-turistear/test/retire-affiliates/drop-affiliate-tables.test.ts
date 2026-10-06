import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { seedUser, clearFullDb } from '../helpers/tenancy'

// drop-affiliate-tables US1 — specs/002-drop-affiliate-tables/spec.md.
//
// The suite runs on a D1 with every migration applied, 0069 included, so these assertions read the
// schema production reaches. The failure they guard against is the one measured in build (001
// research R4): a parent table dropped while a child still declares REFERENCES to it makes every
// INSERT or DELETE on that child fail with "no such table" — every sale would stop.

const RETIRED_TABLES = [
  'affiliate_companies',
  'affiliate_commissions',
  'affiliate_invitations',
  'affiliate_operators',
]
const RETIRED_COLUMNS: Array<[string, string]> = [
  ['users', 'affiliate_company_id'],
  ['users', 'position'],
  ['folios', 'affiliate_company_id'],
  ['folios', 'operator_id'],
  ['folio_payments', 'operator_id'],
  ['folio_events', 'operator_id'],
]

const tableNames = async (): Promise<string[]> => {
  const { results } = await env.DB.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%'`,
  ).all<{ name: string }>()
  return results.map((r) => r.name)
}

beforeEach(clearFullDb)

describe('drop-affiliate-tables US1 — 0069 leaves no retired object and no dangling reference', () => {
  it('drops the four tables and their indexes', async () => {
    const { results } = await env.DB.prepare(
      `SELECT type, name FROM sqlite_master WHERE name LIKE 'affiliate%' OR tbl_name LIKE 'affiliate%'`,
    ).all()
    expect(results).toEqual([])
    const tables = await tableNames()
    for (const t of RETIRED_TABLES) expect(tables).not.toContain(t)
  })

  it('drops the six child columns and keeps every other column', async () => {
    for (const [table, column] of RETIRED_COLUMNS) {
      const { results } = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>()
      const columns = results.map((r) => r.name)
      expect(columns, table).not.toContain(column)
      expect(columns, table).toContain('id')
      expect(columns, table).toContain('organization_id')
    }
  })

  it('leaves no foreign key pointing at a table that does not exist', async () => {
    const tables = await tableNames()
    for (const table of tables) {
      const { results } = await env.DB.prepare(`PRAGMA foreign_key_list(${table})`).all<{
        table: string
        from: string
      }>()
      for (const fk of results) expect(tables, `${table}.${fk.from} → ${fk.table}`).toContain(fk.table)
    }
  })

  it('keeps every former child table writable — insert and delete (the R4 failure mode)', async () => {
    const { userId, organizationId } = await seedUser({ email: 'admin@empresa.com', role: 'admin' })
    const ts = Math.floor(Date.now() / 1000)
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO folios (id, organization_id, agent_id, customer_name, subtotal, discount_total, total, amount_paid, commission_amount, created_at, updated_at)
         VALUES ('f-r4', ?, ?, 'Cliente', 100, 0, 100, 100, 0, ?, ?)`,
      ).bind(organizationId, userId, ts, ts),
      env.DB.prepare(
        `INSERT INTO folio_payments (id, organization_id, folio_id, entry_type, amount, method, verification, collected_by, created_at)
         VALUES ('p-r4', ?, 'f-r4', 'payment', 100, 'cash', 'not_required', ?, ?)`,
      ).bind(organizationId, userId, ts),
      env.DB.prepare(
        `INSERT INTO folio_events (id, organization_id, folio_id, event_type, actor_id, created_at)
         VALUES ('e-r4', ?, 'f-r4', 'created', ?, ?)`,
      ).bind(organizationId, userId, ts),
    ])
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM folio_events WHERE id = 'e-r4'`),
      env.DB.prepare(`DELETE FROM folio_payments WHERE id = 'p-r4'`),
      env.DB.prepare(`DELETE FROM folios WHERE id = 'f-r4'`),
    ])
    expect((await env.DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual([])
  })
})
