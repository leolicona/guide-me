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
// 'YYYY-MM-DD' N days from today. The fulfilment axis (US-A85) compares a line's snapshotted
// departure against the clock, so a seed with only FUTURE departures can demonstrate nothing about
// it: every folio reads pending, the wasted-seat report is empty, and the T-24h sweep finds nothing.
const dayOffset = (n) => new Date((now + n * DAY) * 1000).toISOString().slice(0, 10)
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
// Held rather than inlined, so the outbox rows below can point at real folios.
const reminderFolioId = randomUUID()
const graceFolioId = randomUUID()
// The PAID reschedule demo: needs a portal token, or the post-move WhatsApp handoff renders its
// button disabled ("Los boletos aún no están listos") — a real sale gets the token at confirm.
const leoFolioId = randomUUID()
// US-AG52 — the two ways a tourist's reschedule petition can end at review time.
const reqViableFolioId = randomUUID()
const reqDoomedFolioId = randomUUID()

// A folio + its line, so the list has cards with a real service name on them.
const folio = ({
  id, customer, phone, status, total, paid, createdAt, extra = {}, service,
  // US-A85 — fulfilment is DERIVED from these two against the line's departure, so a seed that
  // leaves them at their defaults can only ever produce 'pending'. Overriding the date is what lets
  // a folio be genuinely departed rather than merely old.
  quantity = 2, redeemed = 0, departsOn, slot,
}) => {
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
     VALUES (${q(lineId)}, ${q(ORG_ID)}, ${q(id)}, ${q(service.id)},
       ${slot ? q(slot.id) : 'NULL'}, ${q(service.name)},
       ${q(departsOn ?? slot?.date ?? service.date)}, ${q(slot?.startTime ?? '08:00')}, ${quantity},
       ${Math.round(total / quantity)}, ${Math.round(total / quantity)},
       ${Math.round(total / quantity)}, ${total},
       NULL, ${redeemed}, ${createdAt});`,
  ].join('\n')
}

// US-AG52 — the reschedule needs REAL slots: a line with `slot_id = NULL` is refused outright
// ("solo se reagendan líneas de tour"). Every service gets the departure its folios sit on plus two
// alternatives, so the picker has somewhere to move to and the guards have something to guard.
const slotFor = (serviceId, date, startTime, capacity = 20, booked = 0) => ({
  id: randomUUID(), serviceId, date, startTime, capacity, booked,
})

const svc = [
  { id: serviceIds[0], name: 'Tour Isla Mujeres', date: '2026-08-20' },
  { id: serviceIds[1], name: 'Chichén Itzá desde Cancún', date: '2026-08-22' },
  { id: serviceIds[2], name: 'Catamarán al atardecer', date: '2026-08-25' },
  // Used by the out-of-window sale and NOTHING else. The first version of this seed reused an
  // existing service there, so searching for it matched a row that was already loaded and the
  // fallback never fired — the one behaviour the row exists to demonstrate.
  { id: serviceIds[3], name: 'Nado con delfines', date: '2025-12-02' },
]

// One departure per service where its folios live, plus two alternatives on the SAME service so
// Reagendar has real options — D11 only offers the same service, so alternatives on another one
// would leave the picker empty.
const slots = [
  slotFor(svc[0].id, dayOffset(16), '08:00'),   // where the Isla Mujeres folios sit
  slotFor(svc[0].id, dayOffset(18), '08:00'),   // an alternative with room
  slotFor(svc[0].id, dayOffset(19), '14:00', 2, 2), // FULL — the refusal path, on purpose
  slotFor(svc[1].id, dayOffset(18), '07:00'),
  slotFor(svc[1].id, dayOffset(21), '07:00'),
  slotFor(svc[2].id, dayOffset(21), '17:00'),
  slotFor(svc[2].id, dayOffset(23), '17:00'),
  slotFor(svc[3].id, '2025-12-02', '09:00'),
]
const slotOf = (serviceId, i = 0) => slots.filter((s) => s.serviceId === serviceId)[i]

const sql = `
-- Clean slate: children first, then the org itself.
DELETE FROM notifications WHERE organization_id = ${q(ORG_ID)};
-- 0060 renamed cancellation_requests, and its new folio_line_id FK means it must go BEFORE the lines.
DELETE FROM folio_requests WHERE organization_id = ${q(ORG_ID)};
DELETE FROM folio_lines WHERE organization_id = ${q(ORG_ID)};
DELETE FROM folio_payments WHERE organization_id = ${q(ORG_ID)};

DELETE FROM folios WHERE organization_id = ${q(ORG_ID)};
DELETE FROM slots WHERE organization_id = ${q(ORG_ID)};
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

${slots
  .map(
    (sl) => `INSERT INTO slots (id, organization_id, service_id, date, start_time, capacity, booked, status)
     VALUES (${q(sl.id)}, ${q(ORG_ID)}, ${q(sl.serviceId)}, ${q(sl.date)}, ${q(sl.startTime)},
       ${sl.capacity}, ${sl.booked}, 'active');`,
  )
  .join('\n')}

-- One folio per state the Ventas screen can show, so every pill in the pending-work bar has
-- something behind it and the search has more than one row to narrow.
${folio({
  id: leoFolioId, customer: 'Leo Licona', phone: '+529981234567', status: 'paid',
  total: 240000, paid: 240000, createdAt: now - 3600, service: svc[0], slot: slotOf(svc[0].id),
  extra: { payment_verification: q('verified'), tickets_sent_at: 'NULL', tickets_viewed_at: 'NULL' },
})}
-- The portal token a real sale issues at confirm. Without it the folio has no portal_link, and
-- every WhatsApp send (incl. the post-reschedule handoff) is disabled.
INSERT INTO folio_access_tokens (id, organization_id, folio_id, token, expires_at, created_at)
VALUES (${q(randomUUID())}, ${q(ORG_ID)}, ${q(leoFolioId)}, ${q(`tok-${randomUUID()}`)},
        ${now + 30 * DAY}, ${now - 3600});
${folio({
  id: randomUUID(), customer: null, phone: '+529985554444', status: 'paid',
  total: 180000, paid: 180000, createdAt: now - 26 * 3600, service: svc[1], slot: slotOf(svc[1].id),
  extra: { payment_verification: q('pending'), payment_reference: q('SPEI 4471'), sale_mode: q('express') },
})}
${folio({
  id: randomUUID(), customer: 'María Fernández', phone: '+529982223333', status: 'booking',
  total: 300000, paid: 90000, createdAt: now - 5 * 3600, service: svc[2], slot: slotOf(svc[2].id),
  extra: { booking_expires_at: now - 2 * DAY },
})}
${folio({
  id: randomUUID(), customer: 'Jorge Muñoz', phone: '+529987778888', status: 'cancelled',
  total: 150000, paid: 150000, createdAt: now - 9 * DAY, service: svc[0],
  extra: { cancelled_at: now - 8 * DAY, refund_status: q('pending'), refund_amount: 150000 },
})}
-- US-A85 - the three fulfilment readings, so the chip, the "Sin usar" facet and the wasted-seat
-- report each have something behind them. Departures are RELATIVE to today: fixed future dates are
-- why the first version of this seed could only ever show 'pending'.
${folio({
  id: randomUUID(), customer: 'Familia Perez', phone: '+529981110001', status: 'paid',
  total: 200000, paid: 200000, createdAt: now - 10 * DAY, service: svc[0],
  departsOn: dayOffset(-2), quantity: 4, redeemed: 0,
  extra: { payment_verification: q('verified'), tickets_sent_at: now - 10 * DAY },
})}
${folio({
  id: randomUUID(), customer: 'Grupo Hernandez', phone: '+529981110002', status: 'paid',
  total: 200000, paid: 200000, createdAt: now - 10 * DAY, service: svc[1],
  departsOn: dayOffset(-2), quantity: 4, redeemed: 2,
  extra: { payment_verification: q('verified'), tickets_sent_at: now - 10 * DAY },
})}
-- Consumed AND departed: the only shape the review request (US-T08) is allowed to reach.
${folio({
  id: randomUUID(), customer: 'Sofia Lira', phone: '+529981110003', status: 'paid',
  total: 200000, paid: 200000, createdAt: now - 10 * DAY, service: svc[2],
  departsOn: dayOffset(-1), quantity: 4, redeemed: 4,
  extra: {
    payment_verification: q('verified'),
    tickets_sent_at: now - 10 * DAY, tickets_viewed_at: now - 9 * DAY,
  },
})}
-- Departing tomorrow: the folio the T-24h sweep exists to remind.
${folio({
  id: reminderFolioId, customer: 'Diego Cabrera', phone: '+529981110004', status: 'paid',
  total: 150000, paid: 150000, createdAt: now - 2 * DAY, service: svc[0],
  departsOn: dayOffset(1), quantity: 3, redeemed: 0,
  extra: { payment_verification: q('verified'), tickets_sent_at: now - 2 * DAY },
})}
-- An apartado past its settle deadline: stage 2, the OTHER clock-produced notification (D19).
${folio({
  id: graceFolioId, customer: 'Norma Escalante', phone: '+529981110006', status: 'booking',
  total: 400000, paid: 120000, createdAt: now - 6 * DAY, service: svc[2], slot: slotOf(svc[2].id),
  quantity: 4,
  extra: { booking_expires_at: now - 3600, reminder_status: q('sent') },
})}
-- BUG-027 - cancelled and owed NOTHING back: the ladder retained everything. This folio used to
-- render "$X (reembolsado)" about money the company kept, and now reads "(sin reembolso)".
-- Without this row the fix is invisible.
${folio({
  id: randomUUID(), customer: 'Ernesto Vidal', phone: '+529981110005', status: 'cancelled',
  total: 300000, paid: 90000, createdAt: now - 12 * DAY, service: svc[1],
  extra: {
    cancelled_at: now - 11 * DAY, refund_status: q('none'), refund_amount: 0,
    cancellation_source: q('admin'),
  },
})}

-- US-A87 (D6) — a closed apartado that left a CREDIT. Needs a ladder generous enough that the
-- retention is smaller than the deposit: the ladder retains a share of what was SOLD, not of what
-- was collected, so at 40% a 30% deposit still leaves nothing (US-A76). This one paid 120,000 of
-- 400,000 and kept 90,000 back.
${folio({
  id: randomUUID(), customer: 'Beatriz Solano', phone: '+529981110007', status: 'cancelled',
  total: 400000, paid: 120000, createdAt: now - 20 * DAY, service: svc[1],
  extra: {
    cancelled_at: now - 15 * DAY, refund_status: q('none'), refund_amount: 0,
    cancellation_source: q('system_expiry'),
    credit_amount: 90000,
    credit_expires_at: now + 60 * DAY,
  },
})}

-- US-AG52 — the TOURIST origin, at its two review outcomes. Both render the review card that
-- branches on kind ("El cliente pidió reagendar", never "Aprobar y cancelar folio").
--   Carlos Peña   -> the destination still has room: Aprobar reagenda moves the seats.
--   Lucía Ortega  -> the destination FILLED after she asked: approving auto-rejects with the
--                    reason and viable alternatives, because a petition holds no seats.
${folio({
  id: reqViableFolioId, customer: 'Carlos Peña', phone: '+529981110008', status: 'booking',
  total: 240000, paid: 72000, createdAt: now - 4 * 3600, service: svc[0], slot: slotOf(svc[0].id),
  extra: { booking_expires_at: now + 2 * DAY },
})}
${folio({
  id: reqDoomedFolioId, customer: 'Lucía Ortega', phone: '+529981110009', status: 'booking',
  total: 240000, paid: 72000, createdAt: now - 3 * 3600, service: svc[0], slot: slotOf(svc[0].id),
  extra: { booking_expires_at: now + 2 * DAY },
})}
INSERT INTO folio_requests (id, organization_id, folio_id, kind, status, reason,
                            folio_line_id, from_slot_id, to_slot_id, created_at, updated_at)
VALUES (${q(randomUUID())}, ${q(ORG_ID)}, ${q(reqViableFolioId)}, 'reschedule', 'pending',
        'Nos cambió el vuelo, ¿puede ser dos días después?',
        (SELECT id FROM folio_lines WHERE folio_id = ${q(reqViableFolioId)}),
        ${q(slotOf(svc[0].id).id)}, ${q(slotOf(svc[0].id, 1).id)}, ${now - 7200}, ${now - 7200}),
       (${q(randomUUID())}, ${q(ORG_ID)}, ${q(reqDoomedFolioId)}, 'reschedule', 'pending',
        'Preferimos la salida de la tarde',
        (SELECT id FROM folio_lines WHERE folio_id = ${q(reqDoomedFolioId)}),
        ${q(slotOf(svc[0].id).id)}, ${q(slotOf(svc[0].id, 2).id)}, ${now - 5400}, ${now - 5400});

-- US-A86 - the outbox with something in it: work to drain, and a failure that must not stay
-- invisible. Seeded DIRECTLY because wrangler dev does not fire a cron trigger on its own, so an
-- outbox waiting on the scheduled worker would look broken rather than empty. Everything else about
-- these rows is exactly what the sweep writes.
INSERT INTO notifications (id, organization_id, folio_id, event, channel, status, created_at)
VALUES (${q(randomUUID())}, ${q(ORG_ID)}, ${q(reminderFolioId)}, 'departure_reminder', 'whatsapp', 'pending', ${now - 1800}),
       (${q(randomUUID())}, ${q(ORG_ID)}, ${q(reminderFolioId)}, 'departure_reminder', 'email', 'skipped', ${now - 1800}),
       (${q(randomUUID())}, ${q(ORG_ID)}, ${q(graceFolioId)}, 'booking_grace_entered', 'whatsapp', 'pending', ${now - 3600});

INSERT INTO notifications (id, organization_id, folio_id, event, channel, status, attempts, last_error, created_at)
VALUES (${q(randomUUID())}, ${q(ORG_ID)}, ${q(graceFolioId)}, 'booking_grace_entered', 'email', 'failed', 2,
        'Resend 503 - service unavailable', ${now - 3600});

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

   Also seeded: an agent (ana@local.test, same password), 4 services, and 13 sales — one per
   state the Ventas screen can show, plus one from 200 days ago that ONLY search or a date
   range can reach.

   For the folio state machine:
     /folios     "Apartado" everywhere (never "Reserva") · a cancelled folio reading
                 "(sin reembolso)" · chips "Sin usar" and "Parcialmente usado" on departed tours.
                 Estado -> Pendiente -> "Sin usar".
     /mensajes   the admin outbox: two WhatsApp rows to drain, one recorded failure.
     Ajustes     "Marcar como no usado" - set it to 2 h Despues and the no-shows go quiet.

   For the reschedule (US-AG52):
     Maria Fernandez / Norma Escalante  apartados vivos con horario real -> Reagendar
                                        (fecha primero, luego los horarios de ese dia)
     Leo Licona                          venta PAGADA -> Reagendar re-firma su QR
     Carlos Pena                         pidio reagendar desde el portal -> "Aprobar reagenda"
                                        mueve los lugares (el review sheet ya no dice cancelar)
     Lucia Ortega                        pidio un horario que se LLENO despues -> aprobar la
                                        auto-rechaza con el motivo y fechas alternativas
     Beatriz Solano                      apartado cerrado con $900.00 a favor (en la card y
                                        en el detalle, con su vigencia)
     Ajustes                             "Liberacion de apartado" te va a frenar: cada
                                         organizacion nace liberando 15 min antes de dejar
                                         de vender. Eso es la regla D4, y es el cambio que
                                         mas se nota.
`)
