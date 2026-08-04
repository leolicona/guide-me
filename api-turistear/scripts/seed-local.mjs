#!/usr/bin/env node
// Seed the LOCAL D1 replica with an organization, an admin you can actually log in as, and enough
// catalog + sales for every screen to have something on it.
//
// Why this exists instead of "just register through the UI": `POST /api/auth/register` inserts the
// user and THEN emails a magic link through Resend. Locally there is no Resend key, so the call
// 502s after the row is written and the account is left `unverified`, which login refuses. Rather
// than teach people that half-broken dance, this script asks agnostic-auth for a password hash —
// a stateless call that creates no account anywhere — and writes an ALREADY-ACTIVE admin.
//
//   node scripts/seed-local.mjs [email] [password]
//
// Idempotent: it deletes the seeded organization and everything under it first, so re-running is
// how you get back to a clean board.

import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const EMAIL = process.argv[2] ?? 'admin@local.test'
const PASSWORD = process.argv[3] ?? 'Local1234!'
const AUTH_URL = 'https://agnostic-auth.leolicona-dev.workers.dev'
const ORG_ID = '00000000-0000-4000-8000-000000000001' // stable, so re-seeding can clean up
const TZ = 'America/Cancun'

const now = Math.floor(Date.now() / 1000)
const DAY = 86400
const q = (s) => `'${String(s).replace(/'/g, "''")}'`

console.log(`→ hashing the password via agnostic-auth (stateless; no account is created there)`)
const res = await fetch(`${AUTH_URL}/auth/hash`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ password: PASSWORD }),
})
if (!res.ok) {
  console.error(`agnostic-auth returned ${res.status}. Is the service up?`)
  process.exit(1)
}
const { data } = await res.json()

const adminId = randomUUID()
const agentId = randomUUID()
const serviceIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()]

// A folio + its line, so the list has cards with a real service name on them.
const folio = ({ id, customer, phone, status, total, paid, createdAt, extra = {}, service }) => {
  const cols = {
    id: q(id),
    organization_id: q(ORG_ID),
    agent_id: q(agentId),
    customer_name: customer === null ? 'NULL' : q(customer),
    customer_email: 'NULL',
    customer_phone: phone ? q(phone) : 'NULL',
    status: q(status),
    subtotal: total,
    discount_total: 0,
    total,
    amount_paid: paid,
    created_at: createdAt,
    updated_at: createdAt,
    ...extra,
  }
  const lineId = randomUUID()
  return [
    `INSERT INTO folios (${Object.keys(cols).join(', ')}) VALUES (${Object.values(cols).join(', ')});`,
    `INSERT INTO folio_lines (id, organization_id, folio_id, service_id, slot_id, service_name,
       slot_date, slot_start_time, quantity, base_price, minimum_price, unit_price, line_total,
       qr_token, redeemed_count, created_at)
     VALUES (${q(lineId)}, ${q(ORG_ID)}, ${q(id)}, ${q(service.id)}, NULL, ${q(service.name)},
       ${q(service.date)}, '08:00', 2, ${total / 2}, ${total / 2}, ${total / 2}, ${total},
       NULL, 0, ${createdAt});`,
  ].join('\n')
}

const svc = [
  { id: serviceIds[0], name: 'Tour Isla Mujeres', date: '2026-08-20' },
  { id: serviceIds[1], name: 'Chichén Itzá desde Cancún', date: '2026-08-22' },
  { id: serviceIds[2], name: 'Catamarán al atardecer', date: '2026-08-25' },
  // Used by the out-of-window sale and NOTHING else. The first version of this seed reused an
  // existing service there, so searching for it matched a row that was already loaded and the
  // fallback never fired — the one behaviour the row exists to demonstrate.
  { id: serviceIds[3], name: 'Nado con delfines', date: '2025-12-02' },
]

const sql = `
-- Clean slate: children first, then the org itself.
DELETE FROM folio_lines WHERE organization_id = ${q(ORG_ID)};
DELETE FROM folio_payments WHERE organization_id = ${q(ORG_ID)};
DELETE FROM cancellation_requests WHERE organization_id = ${q(ORG_ID)};
DELETE FROM folios WHERE organization_id = ${q(ORG_ID)};
DELETE FROM services WHERE organization_id = ${q(ORG_ID)};
DELETE FROM users WHERE organization_id = ${q(ORG_ID)};
DELETE FROM organizations WHERE id = ${q(ORG_ID)};

INSERT INTO organizations (id, name, timezone) VALUES (${q(ORG_ID)}, 'Turistear Local', ${q(TZ)});

-- status='active' is the whole point: the verify endpoint does nothing else to the user row,
-- so skipping the magic link costs nothing.
INSERT INTO users (id, organization_id, name, email, password_hash, password_salt, phone, role,
                   status, base_commission, plan)
VALUES (${q(adminId)}, ${q(ORG_ID)}, 'Admin Local', ${q(EMAIL)}, ${q(data.hash)}, ${q(data.salt)},
        '+529980000000', 'admin', 'active', 0, 'free');
INSERT INTO users (id, organization_id, name, email, password_hash, password_salt, phone, role,
                   status, base_commission, plan)
VALUES (${q(agentId)}, ${q(ORG_ID)}, 'Ana Ramírez', 'ana@local.test', ${q(data.hash)}, ${q(data.salt)},
        '+529981111111', 'agent', 'active', 10, 'free');

${svc
  .map(
    (s) => `INSERT INTO services (id, organization_id, name, description, base_price, minimum_price,
       default_capacity, status, created_at, updated_at)
     VALUES (${q(s.id)}, ${q(ORG_ID)}, ${q(s.name)}, '', 120000, 90000, 30, 'active', ${now}, ${now});`,
  )
  .join('\n')}

-- One folio per state the Ventas screen can show, so every pill in the pending-work bar has
-- something behind it and the search has more than one row to narrow.
${folio({
  id: randomUUID(), customer: 'Leo Licona', phone: '+529981234567', status: 'paid',
  total: 240000, paid: 240000, createdAt: now - 3600, service: svc[0],
  extra: { payment_verification: q('verified'), tickets_sent_at: 'NULL', tickets_viewed_at: 'NULL' },
})}
${folio({
  id: randomUUID(), customer: null, phone: '+529985554444', status: 'paid',
  total: 180000, paid: 180000, createdAt: now - 26 * 3600, service: svc[1],
  extra: { payment_verification: q('pending'), payment_reference: q('SPEI 4471'), sale_mode: q('express') },
})}
${folio({
  id: randomUUID(), customer: 'María Fernández', phone: '+529982223333', status: 'booking',
  total: 300000, paid: 90000, createdAt: now - 5 * 3600, service: svc[2],
  extra: { booking_expires_at: now - 2 * DAY },
})}
${folio({
  id: randomUUID(), customer: 'Jorge Muñoz', phone: '+529987778888', status: 'cancelled',
  total: 150000, paid: 150000, createdAt: now - 9 * DAY, service: svc[0],
  extra: { cancelled_at: now - 8 * DAY, refund_status: q('pending'), refund_amount: 150000 },
})}
-- Older than the 30-day window and owing nothing: only findable through search or a date range,
-- which is exactly what US-A83 is for.
${folio({
  id: randomUUID(), customer: 'Rosalía Villanueva', phone: '+529986665544', status: 'paid',
  total: 95000, paid: 95000, createdAt: now - 200 * DAY, service: svc[3],
  extra: { payment_verification: q('verified'), tickets_sent_at: now - 200 * DAY, tickets_viewed_at: now - 200 * DAY },
})}
`

const file = join(mkdtempSync(join(tmpdir(), 'seed-')), 'seed.sql')
writeFileSync(file, sql)

console.log('→ writing to the LOCAL D1 replica')
execFileSync(
  'npx',
  ['wrangler', 'd1', 'execute', 'guideme-db', '--local', `--file=${file}`],
  { stdio: 'inherit' },
)

console.log(`
✔ Ready.

   URL       http://localhost:5174
   Email     ${EMAIL}
   Password  ${PASSWORD}

   Also seeded: an agent (ana@local.test, same password), 3 services, and 5 sales — one per
   state the Ventas screen can show, plus one from 200 days ago that ONLY search or a date
   range can reach.
`)
