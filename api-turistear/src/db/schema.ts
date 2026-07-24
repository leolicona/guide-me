import { sql } from 'drizzle-orm'
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'

export const organizations = sqliteTable('organizations', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  // Hours an admin money-move (direct collection / adjusted confirm) stays awaiting the
  // agent's signature before it auto-signs (US-AG27/AG28). Per-org configurable; default 24.
  ackWindowHours: integer('ack_window_hours').notNull().default(24),
  // Bookings/down-payments policy (US-A46 / US-AG07.1) — org-level globals. minimum deposit as a
  // percent of the folio total (0–100; 0 = no minimum); hold window in whole days before an
  // unsettled booking auto-cancels. US-A47 — two SIGNED-minute departure offsets (+ = before
  // departure, − = after, a grace window): salesCutoff closes NEW sales/booking creation on a
  // departing slot; bookingGrace decides when an unsettled SAME-DAY booking auto-cancels (was
  // same_day_buffer_minutes).
  bookingMinDownPaymentPct: integer('booking_min_down_payment_pct').notNull().default(0),
  bookingHoldDays: integer('booking_hold_days').notNull().default(7),
  salesCutoffOffsetMinutes: integer('sales_cutoff_offset_minutes').notNull().default(0),
  bookingGraceOffsetMinutes: integer('booking_grace_offset_minutes').notNull().default(15),
  // Accommodation/lodging settings (docs/lodging/accommodation-stays.spec.md §2.5). weekendDays:
  // CSV of ISO weekday ints (0=Sun … 6=Sat) — which nights use a unit's weekend_rate (default
  // Fri+Sat). A PAID stay cancels free until lodgingFreeCancelDays before check-in; inside that
  // window lodgingCancelPenaltyPct (% of stay total) is retained. Booking deposits stay
  // non-refundable (US-AG07.4) regardless of these.
  lodgingWeekendDays: text('lodging_weekend_days').notNull().default('5,6'),
  lodgingFreeCancelDays: integer('lodging_free_cancel_days').notNull().default(0),
  lodgingCancelPenaltyPct: integer('lodging_cancel_penalty_pct').notNull().default(0),
  // WhatsApp message templates (docs/whatsapp-qr-delivery/spec.md — D10). Admin-edited in Settings.
  // NULL ⇒ use the shipped default (see utils/waTemplates). waTicketTemplate delivers paid tickets
  // (tours + lodging) and MUST contain {portal_link}; waReminderTemplate is the apartado reminder.
  waTicketTemplate: text('wa_ticket_template'),
  waReminderTemplate: text('wa_reminder_template'),
  // US-A66 (docs/timezone/spec.md) — the org's single IANA time zone. The one org-local clock all
  // wall-clock scheduling resolves against: catalog "today", sale-cutoff/grace/expiry math (closes
  // BUG-007), and audit-timestamp display. Stored slot strings stay naive wall-clock — this fixes
  // only the "now" they compare against. Curated Mexican-zone picker in Settings (D5).
  timezone: text('timezone').notNull().default('America/Mexico_City'),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
})

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id')
    .notNull()
    .references(() => organizations.id),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  passwordSalt: text('password_salt').notNull(),
  phone: text('phone'),
  role: text('role', { enum: ['admin', 'agent', 'affiliate'] }).notNull(),
  status: text('status', { enum: ['unverified', 'active', 'suspended'] })
    .notNull()
    .default('unverified'),
  // Affiliate program (docs/affiliates/affiliate-setup-commissions.spec.md, D4). Set at invite
  // acceptance for an `affiliate` user; null for admin/agent. `position` is the optional job
  // title collected on the affiliate onboarding form (US-AF01).
  affiliateCompanyId: text('affiliate_company_id').references(() => affiliateCompanies.id),
  position: text('position'),
  // DEPRECATED (2026-06-11): commission is service-based now (services.commission_type/value —
  // docs/commissions/service-based-commission.spec.md). No code reads or writes this column;
  // it is kept only to avoid a users-table rebuild. A future migration may drop it.
  baseCommission: integer('base_commission').notNull().default(0),
  plan: text('plan').notNull().default('free'),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
})

export const invitations = sqliteTable('invitations', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id')
    .notNull()
    .references(() => organizations.id),
  identity: text('identity').notNull(),
  identityType: text('identity_type', { enum: ['email'] })
    .notNull()
    .default('email'),
  token: text('token').notNull().unique(),
  invitedBy: text('invited_by')
    .notNull()
    .references(() => users.id),
  status: text('status', { enum: ['pending', 'accepted', 'expired'] })
    .notNull()
    .default('pending'),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
})

export const passwordResetTokens = sqliteTable('password_reset_tokens', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id),
  token: text('token').notNull().unique(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
})

export const services = sqliteTable('services', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id')
    .notNull()
    .references(() => organizations.id),
  name: text('name').notNull(),
  description: text('description'),
  basePrice: integer('base_price').notNull(),
  minimumPrice: integer('minimum_price').notNull(),
  defaultCapacity: integer('default_capacity').notNull(),
  // Service-based commission (US-A12 rev. / docs/commissions/service-based-commission.spec.md):
  // the service defines what ANY seller earns. `percent` → commission_value is basis points
  // (1000 = 10%) of the line total incl. extras; `fixed` → commission_value is minor units PER
  // SPOT (× quantity), capped at minimum_price so it never exceeds a floor-priced pass.
  commissionType: text('commission_type', { enum: ['percent', 'fixed'] })
    .notNull()
    .default('percent'),
  commissionValue: integer('commission_value').notNull().default(0),
  // Flexible capacity / overbooking tolerance (US-A36 — docs/catalog/flexible-capacity.spec.md).
  // isFlexible=false → Hard Cap (strict). true → Soft Cap: the POS allows up to flexCapacityPct
  // extra spots per slot (floor(slot.capacity × pct / 100)), enforced atomically in confirmSale.
  // The POS read exposes these raw fields so the client computes Effective Capacity live (and
  // can highlight slots once an agent dips into the flex margin). pct is 0 for Hard Cap services.
  isFlexible: integer('is_flexible', { mode: 'boolean' }).notNull().default(false),
  flexCapacityPct: integer('flex_capacity_pct').notNull().default(0),
  // US-A37 — primary category (docs/catalog/service-categories.spec.md). A closed enum,
  // nullable only to absorb pre-migration rows (NULL = uncategorized); the API requires it
  // on every create/edit, so all new/re-saved rows carry a value. Drives the POS filter chips.
  category: text('category', {
    enum: ['lodging', 'tours', 'dining', 'adventure', 'culture'],
  }),
  // Zoned Capacity (US-A64 — docs/catalog/zoned-capacity.spec.md). Opt-in: when true, the
  // service's slot seats are partitioned across `service_zones`; sales guard per-zone and
  // `slots.capacity`/`booked` are reconciled from the zones. false = today's single pool.
  // Mutually exclusive with is_flexible (strict per-zone ceilings make the flex margin
  // unreachable — enabling zones clears Soft Cap).
  zonesEnabled: integer('zones_enabled', { mode: 'boolean' }).notNull().default(false),
  status: text('status', { enum: ['active', 'inactive'] })
    .notNull()
    .default('active'),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
})

export const serviceExtras = sqliteTable('service_extras', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id')
    .notNull()
    .references(() => organizations.id),
  serviceId: text('service_id')
    .notNull()
    .references(() => services.id),
  name: text('name').notNull(),
  price: integer('price').notNull(),
  status: text('status', { enum: ['active', 'inactive'] })
    .notNull()
    .default('active'),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
})

export const schedules = sqliteTable('schedules', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id')
    .notNull()
    .references(() => organizations.id),
  serviceId: text('service_id')
    .notNull()
    .references(() => services.id),
  recurrence: text('recurrence', { enum: ['weekly'] })
    .notNull()
    .default('weekly'),
  weekdays: text('weekdays').notNull(), // CSV of 0–6, e.g. "1,3,5"
  startTime: text('start_time').notNull(), // 'HH:MM'
  capacity: integer('capacity').notNull(),
  startDate: text('start_date').notNull(), // 'YYYY-MM-DD'
  endDate: text('end_date').notNull(), // 'YYYY-MM-DD'
  status: text('status', { enum: ['active', 'inactive'] })
    .notNull()
    .default('active'),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
})

export const slots = sqliteTable('slots', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id')
    .notNull()
    .references(() => organizations.id),
  serviceId: text('service_id')
    .notNull()
    .references(() => services.id),
  scheduleId: text('schedule_id').references(() => schedules.id), // nullable
  date: text('date').notNull(), // 'YYYY-MM-DD'
  startTime: text('start_time').notNull(), // 'HH:MM'
  capacity: integer('capacity').notNull(),
  booked: integer('booked').notNull().default(0),
  status: text('status', { enum: ['active', 'inactive'] })
    .notNull()
    .default('active'),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
})

// Zoned Capacity (US-A64 — docs/catalog/zoned-capacity.spec.md). The authored zone definitions
// for a service with `zones_enabled = true`: a name and a seat count, 2–6 active per service.
// A pure inventory partition — no price/commission of its own. Soft-deactivated (folio history);
// hard-deletable only while it has no sales.
export const serviceZones = sqliteTable('service_zones', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id')
    .notNull()
    .references(() => organizations.id),
  serviceId: text('service_id')
    .notNull()
    .references(() => services.id),
  name: text('name').notNull(),
  capacity: integer('capacity').notNull(), // seats in this zone; >= 1
  sortOrder: integer('sort_order').notNull().default(0),
  status: text('status', { enum: ['active', 'inactive'] })
    .notNull()
    .default('active'),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
})

// One row per (departure, zone). `capacity` is SNAPSHOTTED from service_zones at creation and
// frozen thereafter (past departures never re-snapshot — that is what makes editing a zone
// non-destructive to history). Created eagerly for every future slot of a zoned service (at
// enable, and in the same atomic batch whenever a new slot is materialized). The sale guard is a
// single conditional UPDATE against this row's own `capacity`; `slots.capacity`/`booked` are
// reconciled as the sum over active (open) rows. `status = 'inactive'` = zone closed for THIS
// departure (e.g. rain), dropping out of both sums while its sold seats stay valid.
export const slotZones = sqliteTable('slot_zones', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id')
    .notNull()
    .references(() => organizations.id),
  slotId: text('slot_id')
    .notNull()
    .references(() => slots.id),
  zoneId: text('zone_id')
    .notNull()
    .references(() => serviceZones.id),
  capacity: integer('capacity').notNull(), // snapshot of the zone's capacity for this departure
  booked: integer('booked').notNull().default(0),
  status: text('status', { enum: ['active', 'inactive'] })
    .notNull()
    .default('active'),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
})

export const folios = sqliteTable('folios', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id')
    .notNull()
    .references(() => organizations.id),
  agentId: text('agent_id')
    .notNull()
    .references(() => users.id),
  // Affiliate sale attribution (docs/affiliates/affiliate-setup-commissions.spec.md, D5). Null for
  // in-house (agent/admin) sales; stamped with the seller's company for an affiliate sale (US-A51)
  // so in-house vs affiliate revenue stays separable. The seller is still `agentId`.
  affiliateCompanyId: text('affiliate_company_id').references(() => affiliateCompanies.id),
  customerName: text('customer_name'),
  customerEmail: text('customer_email'),
  customerPhone: text('customer_phone'),
  status: text('status', { enum: ['paid', 'booking', 'cancelled'] })
    .notNull()
    .default('paid'),
  // How the agent collected (US-AG25/AG29). Only 'cash' folios add to the agent's cash
  // debt; every other method is electronic — it still earns commission (US-AG24) but the
  // money goes to the company. App-level enum (the column is plain text, no CHECK).
  paymentMethod: text('payment_method', { enum: ['cash', 'card', 'transfer', 'link'] })
    .notNull()
    .default('cash'),
  // US-AG41/US-A67 (docs/payment-verification/spec.md). paymentReference: the transfer's bank ref
  // (free text; null for cash; holds the most recent transfer awaiting verification). The RE-ARMABLE
  // paymentVerification axis gates QR: 'not_required' (all-cash) · 'pending' (a transfer payment
  // awaits an admin) · 'verified'. A slot line's QR is signed only when the folio is `paid` AND this
  // is NOT 'pending' (i.e. cash, or the electronic money has been verified). verifiedAt/By: audit.
  paymentReference: text('payment_reference'),
  paymentVerification: text('payment_verification', {
    enum: ['not_required', 'pending', 'verified'],
  })
    .notNull()
    .default('not_required'),
  paymentVerifiedAt: integer('payment_verified_at', { mode: 'timestamp' }),
  paymentVerifiedBy: text('payment_verified_by').references(() => users.id),
  subtotal: integer('subtotal').notNull(),
  discountTotal: integer('discount_total').notNull().default(0),
  total: integer('total').notNull(),
  amountPaid: integer('amount_paid').notNull(),
  // Commission the agent earns on this sale (minor units), snapshotted at confirm time
  // (US-AG23). Deducted from the running balance unless clawed back on cancellation.
  commissionAmount: integer('commission_amount').notNull().default(0),
  // Bookings/down-payments (US-AG07). bookingExpiresAt: snapshot release timestamp for a 'booking'
  // folio (null otherwise) — see resolveBookingExpiry. settledAt/By: one-shot settlement audit.
  // reminder*: the WhatsApp recovery claim (US-AG07.3) — an atomic flag preventing double-contact.
  bookingExpiresAt: integer('booking_expires_at', { mode: 'timestamp' }),
  settledAt: integer('settled_at', { mode: 'timestamp' }),
  settledBy: text('settled_by').references(() => users.id),
  reminderStatus: text('reminder_status', { enum: ['none', 'sent'] })
    .notNull()
    .default('none'),
  reminderSentAt: integer('reminder_sent_at', { mode: 'timestamp' }),
  reminderSentBy: text('reminder_sent_by').references(() => users.id),
  cancelledAt: integer('cancelled_at', { mode: 'timestamp' }), // set on total cancellation (US-A21)
  cancelledBy: text('cancelled_by').references(() => users.id), // admin who cancelled
  cancellationReason: text('cancellation_reason'), // optional admin note
  // On cancellation (US-A26): true → agent loses the commission (clawback); false → the
  // company absorbs it and the agent keeps the commission. Only meaningful when cancelled.
  cancellationClawback: integer('cancellation_clawback', { mode: 'boolean' })
    .notNull()
    .default(false),
  // Cash refund tracking (US-A23 / US-T05). `pending` is set when a PAID folio is cancelled
  // via an approved tourist cancellation request; `refunded` once the admin confirms the
  // physical hand-back (PIN or override). `none` = no refund obligation.
  refundStatus: text('refund_status', { enum: ['none', 'pending', 'refunded'] })
    .notNull()
    .default('none'),
  refundAmount: integer('refund_amount'), // snapshot of amount_paid owed back
  // 6-digit crypto-random PIN shown ONLY in the tourist portal (never emailed). The tourist
  // hands it to the agent/admin to prove they were present to receive the cash.
  refundPin: text('refund_pin'),
  refundPinAttempts: integer('refund_pin_attempts').notNull().default(0),
  // The admin's audit note when confirming WITHOUT the PIN (lost-link override).
  refundNote: text('refund_note'),
  refundedAt: integer('refunded_at', { mode: 'timestamp' }),
  refundedBy: text('refunded_by').references(() => users.id),
  // WhatsApp ticket delivery (docs/whatsapp-qr-delivery/spec.md — D4). A separate axis from
  // payment status. ticketsSentAt: the agent tapped "Enviar por WhatsApp" (their metric, cleared
  // once they act — idempotent last-write-wins, D13). ticketsViewedAt: the tourist opened the
  // portal (the bot-proof "Visto" beacon, first-view). A folio is "pendiente de enviar" once a
  // portal link exists and ticketsSentAt is null.
  ticketsSentAt: integer('tickets_sent_at', { mode: 'timestamp' }),
  ticketsSentBy: text('tickets_sent_by').references(() => users.id),
  ticketsViewedAt: integer('tickets_viewed_at', { mode: 'timestamp' }),
  // US-AF13 — the affiliate shift operator who made the sale (docs/affiliate-operators/spec.md).
  // Null ⇒ the manager/agent sold directly. Pure attribution: agent_id still owns the caja/commission.
  operatorId: text('operator_id').references((): any => affiliateOperators.id),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
})

export const folioLines = sqliteTable('folio_lines', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id')
    .notNull()
    .references(() => organizations.id),
  folioId: text('folio_id')
    .notNull()
    .references(() => folios.id),
  serviceId: text('service_id')
    .notNull()
    .references(() => services.id),
  // Slot fields are NULL for a lodging stay line (docs/lodging — Option A); set for tour lines.
  slotId: text('slot_id').references(() => slots.id),
  serviceName: text('service_name').notNull(), // snapshot at sale time (unit name for a stay)
  slotDate: text('slot_date'), // snapshot 'YYYY-MM-DD' (null for a stay)
  slotStartTime: text('slot_start_time'), // snapshot 'HH:MM' (null for a stay)
  quantity: integer('quantity').notNull(),
  basePrice: integer('base_price').notNull(), // snapshot unit base price
  minimumPrice: integer('minimum_price').notNull(), // snapshot unit floor
  unitPrice: integer('unit_price').notNull(), // sold unit price (post-discount)
  lineTotal: integer('line_total').notNull(),
  // Commission inputs snapshotted at sale (US-AG07): so settle re-derives commission without
  // re-reading a possibly-edited service. percent → basis points of line_total; fixed → per spot.
  commissionType: text('commission_type', { enum: ['percent', 'fixed'] })
    .notNull()
    .default('percent'),
  commissionValue: integer('commission_value').notNull().default(0),
  qrToken: text('qr_token'), // signed access ticket; null for folios sold pre-feature
  redeemedCount: integer('redeemed_count').notNull().default(0), // passes redeemed; <= quantity
  // Accommodation stay line (docs/lodging/accommodation-stays.spec.md §4.4, Option A). lineType
  // 'slot' (tour, default) vs 'stay' (lodging). A stay line carries the unit type + date range +
  // guests + nights instead of a slot; its price is snapshotted in line_total (base_price =
  // unit_price = line_total, minimum_price = 0) and `quantity` = rooms reserved (v2, D12) so
  // existing totals work and a fixed commission counts per room-stay (value × quantity, D13).
  lineType: text('line_type', { enum: ['slot', 'stay'] }).notNull().default('slot'),
  unitTypeId: text('unit_type_id').references(() => accommodationUnitTypes.id), // null for a tour line
  checkIn: text('check_in'), // 'YYYY-MM-DD' (stay only)
  checkOut: text('check_out'), // 'YYYY-MM-DD' (stay only)
  guests: integer('guests'), // stay only
  nights: integer('nights'), // stay only
  // Zoned Capacity (US-A64). The zone a slot line's seats occupy + a snapshot of its name at
  // sale time (so renaming a zone never rewrites a sold ticket/receipt). NULL for an unzoned
  // sale or a lodging stay line.
  zoneId: text('zone_id').references(() => serviceZones.id),
  zoneName: text('zone_name'),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
})

export const folioLineExtras = sqliteTable('folio_line_extras', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id')
    .notNull()
    .references(() => organizations.id),
  folioId: text('folio_id')
    .notNull()
    .references(() => folios.id),
  folioLineId: text('folio_line_id')
    .notNull()
    .references(() => folioLines.id),
  extraId: text('extra_id')
    .notNull()
    .references(() => serviceExtras.id),
  name: text('name').notNull(), // snapshot
  price: integer('price').notNull(), // snapshot unit price (no discount on extras)
  quantity: integer('quantity').notNull().default(1),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
})

// Agent operating expenses — perpetual (not day-scoped). Reduce the agent's running
// balance. See docs/cash-drops/agent-balance-cash-drops.spec.md.
export const agentExpenses = sqliteTable('agent_expenses', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id')
    .notNull()
    .references(() => organizations.id),
  agentId: text('agent_id')
    .notNull()
    .references(() => users.id),
  description: text('description').notNull(),
  amount: integer('amount').notNull(), // minor units, > 0
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
})

// Cash drops — settlement events (agent hands physical cash to the admin). A confirmed
// drop reduces the agent's running balance. `balance_before` is an audit snapshot of the
// derived balance at creation time.
export const cashDrops = sqliteTable('cash_drops', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id')
    .notNull()
    .references(() => organizations.id),
  agentId: text('agent_id')
    .notNull()
    .references(() => users.id),
  amount: integer('amount').notNull(), // minor units, > 0 — reduces balance once confirmed
  balanceBefore: integer('balance_before').notNull(), // audit snapshot at creation
  // Settlement watermark: the agent's authoritative balance the instant this drop was
  // confirmed. Set only on confirm; null while pending/rejected (and for pre-0024 rows).
  balanceAfter: integer('balance_after'),
  // The agent's originally-registered amount, stashed only when an admin confirms with a
  // corrected `amount` (adjust-on-confirm); null means "confirmed as requested".
  amountRequested: integer('amount_requested'),
  status: text('status', { enum: ['pending', 'confirmed', 'rejected'] })
    .notNull()
    .default('pending'),
  // Who created this row: 'agent' (filed a hand-in, baseline) or 'admin' (direct collection,
  // US-A27). Financially inert — drives labelling/audit only.
  source: text('source', { enum: ['agent', 'admin'] })
    .notNull()
    .default('agent'),
  // The agent's signature lifecycle for a unilateral admin money-move (US-AG27/AG28).
  // Orthogonal to `status`; NEVER affects the balance. `auto_signed` may also be DERIVED at
  // read time once `reviewed_at + org.ack_window_hours` has elapsed (persisted opportunistically).
  acknowledgment: text('acknowledgment', {
    enum: ['not_required', 'pending', 'signed', 'auto_signed', 'disputed', 'resolved'],
  })
    .notNull()
    .default('not_required'),
  // Terminal instant of the acknowledgment lifecycle (signed / auto_signed / resolved); null
  // while pending/disputed/not_required.
  acknowledgedAt: integer('acknowledged_at', { mode: 'timestamp' }),
  // The agent's dispute reason (required on dispute); null otherwise.
  ackNote: text('ack_note'),
  // The admin who resolved a dispute; null otherwise.
  ackResolvedBy: text('ack_resolved_by').references(() => users.id),
  note: text('note'),
  reviewedBy: text('reviewed_by').references(() => users.id),
  reviewedAt: integer('reviewed_at', { mode: 'timestamp' }),
  reviewNote: text('review_note'),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
})

// Payouts — company-to-agent payments (transfer/payroll) that clear a negative running
// balance (US-A25). Immediate (no review): each payout raises the agent's balance by its
// amount. `created_by` is the admin who registered it.
export const payouts = sqliteTable('payouts', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id')
    .notNull()
    .references(() => organizations.id),
  agentId: text('agent_id')
    .notNull()
    .references(() => users.id),
  amount: integer('amount').notNull(), // minor units, > 0 — raises the balance
  note: text('note'),
  createdBy: text('created_by')
    .notNull()
    .references(() => users.id),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
})

// Tourist portal magic-link tokens (US-T01). A folio-scoped CAPABILITY token — not a user
// identity/session (tourists have no `users` row). 32 random bytes base64url in the URL;
// valid through the trip (end-of-day of the last slot + 7d, capped at 90d).
// Spec: docs/tourist-portal/tourist-self-service-portal.spec.md
export const folioAccessTokens = sqliteTable('folio_access_tokens', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id')
    .notNull()
    .references(() => organizations.id),
  folioId: text('folio_id')
    .notNull()
    .references(() => folios.id),
  token: text('token').notNull().unique(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  lastAccessedAt: integer('last_accessed_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
})

// Tourist-initiated cancellation requests (US-T04). A REQUEST, never a cancel: it touches no
// inventory or folio status — only an admin approval funnels into the existing cancelFolio
// path (US-A21). At most one open `pending` row per folio (partial unique index).
export const cancellationRequests = sqliteTable('cancellation_requests', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id')
    .notNull()
    .references(() => organizations.id),
  folioId: text('folio_id')
    .notNull()
    .references(() => folios.id),
  status: text('status', { enum: ['pending', 'approved', 'rejected'] })
    .notNull()
    .default('pending'),
  reason: text('reason'), // the tourist's stated reason (optional)
  resolutionNote: text('resolution_note'), // admin's note — required on reject
  resolvedBy: text('resolved_by').references(() => users.id),
  resolvedAt: integer('resolved_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
})

// ── Accommodation / Lodging ──────────────────────────────────────────────────────────────
// docs/lodging/accommodation-stays.spec.md. A `lodging` service (services.category='lodging') is
// a property/listing that owns named, individually-bookable units. A unit is sold for a DATE RANGE
// (multi-night stay) rather than a per-day slot — a new inventory primitive beside `slots`. Each
// table carries organization_id directly (Rule 5) for per-query org filtering + org-leading index.

// A named, bookable unit (US-A59). Money in minor units; amenities a CSV of enum keys (mirrors
// schedules.weekdays). Per-unit rate rules, occupancy, min-stay, check-in/out. Soft-deactivated.
export const accommodationUnitTypes = sqliteTable('accommodation_unit_types', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id')
    .notNull()
    .references(() => organizations.id),
  serviceId: text('service_id')
    .notNull()
    .references(() => services.id),
  name: text('name').notNull(),
  unitType: text('unit_type'), // free label: 'cabin' / 'suite' (admin-defined, not a closed enum)
  // v2 (RFC) — how many interchangeable rooms of this type exist. 1 = the boutique case
  // (a unique cabin is its own type). The per-night guard sells against this pool.
  inventoryCount: integer('inventory_count').notNull().default(1),
  beds: integer('beds').notNull(),
  baseOccupancy: integer('base_occupancy').notNull(), // guests included in the nightly rate
  maxCapacity: integer('max_capacity').notNull(), // hard cap on guests (>= base_occupancy)
  baseRate: integer('base_rate').notNull(), // per-night, minor units
  weekendRate: integer('weekend_rate'), // nullable → use base_rate on weekend nights
  extraPersonFee: integer('extra_person_fee').notNull().default(0), // per extra person per night
  minNights: integer('min_nights').notNull().default(1),
  checkinTime: text('checkin_time').notNull().default('15:00'), // 'HH:MM'
  checkoutTime: text('checkout_time').notNull().default('11:00'), // 'HH:MM'
  amenities: text('amenities').notNull().default(''), // CSV of amenity enum keys
  // Per-unit commission override (waterfall): NULL type ⇒ inherit the service's base commission.
  // When set, commissionValue mirrors services.commission_*: basis points (percent) / minor units (fixed).
  commissionType: text('commission_type', { enum: ['percent', 'fixed'] }),
  commissionValue: integer('commission_value'),
  status: text('status', { enum: ['active', 'inactive'] })
    .notNull()
    .default('active'),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
})

// Per-type seasonal rate override (US-A60). A flat nightly rate for every night in
// [start_date, end_date]; outranks the weekend rate (seasonal > weekend > base). Overlapping
// active seasons for the same type are rejected (409 SEASON_OVERLAP). Soft-deactivated.
export const accommodationSeasons = sqliteTable('accommodation_seasons', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id')
    .notNull()
    .references(() => organizations.id),
  serviceId: text('service_id')
    .notNull()
    .references(() => services.id),
  unitTypeId: text('unit_type_id')
    .notNull()
    .references(() => accommodationUnitTypes.id),
  name: text('name').notNull(),
  startDate: text('start_date').notNull(), // 'YYYY-MM-DD'
  endDate: text('end_date').notNull(), // 'YYYY-MM-DD' (>= start_date)
  nightlyRate: integer('nightly_rate').notNull(), // minor units
  status: text('status', { enum: ['active', 'inactive'] })
    .notNull()
    .default('active'),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
})

// Type-level quantity block-out (US-A61, v2 D11): removes `quantity` rooms of the type from the
// pool for the half-open [start_date, end_date) (matches turnover). Overlapping block-outs SUM.
// Hard-deletable (no historical value), so no status column.
export const accommodationBlockouts = sqliteTable('accommodation_blockouts', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id')
    .notNull()
    .references(() => organizations.id),
  serviceId: text('service_id')
    .notNull()
    .references(() => services.id),
  unitTypeId: text('unit_type_id')
    .notNull()
    .references(() => accommodationUnitTypes.id),
  quantity: integer('quantity').notNull().default(1), // rooms out of inventory (≤ inventory_count)
  startDate: text('start_date').notNull(), // 'YYYY-MM-DD'
  endDate: text('end_date').notNull(), // 'YYYY-MM-DD' (> start_date)
  reason: text('reason'),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
})

// THE inventory unit (US-AG36/38, v2). One row per sold stay line: `quantity` rooms of a type
// for the nights [check_in, check_out). `active` holds the quantity (covers 'booking' + 'paid'
// folios); cancel/expiry → 'cancelled' frees it. Enforced by the per-night atomic count guard
// (D10) — a conditional INSERT in confirmSale / conditional UPDATE on reactivate.
export const accommodationReservations = sqliteTable('accommodation_reservations', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id')
    .notNull()
    .references(() => organizations.id),
  serviceId: text('service_id')
    .notNull()
    .references(() => services.id),
  unitTypeId: text('unit_type_id')
    .notNull()
    .references(() => accommodationUnitTypes.id),
  quantity: integer('quantity').notNull().default(1), // rooms reserved
  folioId: text('folio_id')
    .notNull()
    .references(() => folios.id),
  checkIn: text('check_in').notNull(), // 'YYYY-MM-DD'
  checkOut: text('check_out').notNull(), // 'YYYY-MM-DD' (> check_in)
  guests: integer('guests').notNull(), // total for the line (≤ max_capacity × quantity)
  status: text('status', { enum: ['active', 'cancelled'] })
    .notNull()
    .default('active'),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
})

// ── Affiliate program ────────────────────────────────────────────────────────────────────
// docs/affiliates/affiliate-setup-commissions.spec.md. An affiliate is an external reseller
// (hotel / agency / restaurant). The admin models the company, curates which services it may
// sell and at what commission (the allow-list), and invites its logins.

// The partner company (US-A48/A52/A55). Suspending it (status) cascades to its users at
// authMiddleware — existing folios/QRs stay intact (D7).
export const affiliateCompanies = sqliteTable('affiliate_companies', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id')
    .notNull()
    .references(() => organizations.id),
  name: text('name').notNull(),
  contactEmail: text('contact_email'),
  contactPhone: text('contact_phone'),
  status: text('status', { enum: ['active', 'suspended'] })
    .notNull()
    .default('active'),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
})

// The allow-list AND the per-service rate in one (D1/D2): a service is sellable by an affiliate
// iff a row exists here. `percent` → commission_value is basis points (1500 = 15%); `fixed` →
// minor units PER SPOT (× quantity), capped at the service's minimum_price (D10). UNIQUE per
// (company, service). Rows survive a service deactivation (D12); removed only on hard-delete.
export const affiliateCommissions = sqliteTable('affiliate_commissions', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id')
    .notNull()
    .references(() => organizations.id),
  affiliateCompanyId: text('affiliate_company_id')
    .notNull()
    .references(() => affiliateCompanies.id),
  serviceId: text('service_id')
    .notNull()
    .references(() => services.id),
  commissionType: text('commission_type', { enum: ['percent', 'fixed'] }).notNull(),
  commissionValue: integer('commission_value').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
})

// Parallel invite flow (D8): a dedicated table so the affiliate invite carries role + company
// explicitly and the agent `invitations` path stays untouched. Acceptance creates the
// `affiliate` user linked to affiliateCompanyId (US-AF01).
export const affiliateInvitations = sqliteTable('affiliate_invitations', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id')
    .notNull()
    .references(() => organizations.id),
  affiliateCompanyId: text('affiliate_company_id')
    .notNull()
    .references(() => affiliateCompanies.id),
  identity: text('identity').notNull(),
  identityType: text('identity_type', { enum: ['email'] })
    .notNull()
    .default('email'),
  token: text('token').notNull().unique(),
  invitedBy: text('invited_by')
    .notNull()
    .references(() => users.id),
  status: text('status', { enum: ['pending', 'accepted', 'expired'] })
    .notNull()
    .default('pending'),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
})

// US-AF10–AF13 / US-OP01–OP02 (docs/affiliate-operators/spec.md). A shift cashier at an affiliate
// company's register — NOT a `users` row (no email/password). Registered by the manager with name +
// phone; identified by a durable access_token (the saved WhatsApp link) and unlocked by a 4-digit
// PIN. Pure attribution: its sales roll into the owning manager's one caja (folios.agent_id stays
// the manager); folios.operator_id only labels "Vendido por: {name}".
export const affiliateOperators = sqliteTable('affiliate_operators', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id')
    .notNull()
    .references(() => organizations.id),
  affiliateCompanyId: text('affiliate_company_id')
    .notNull()
    .references(() => affiliateCompanies.id),
  // The affiliate user who owns this operator — sales attribute to this manager's caja/balance
  // (folios.agent_id) and it resolves the operator session's borrowed identity (D5).
  managerId: text('manager_id')
    .notNull()
    .references(() => users.id),
  name: text('name').notNull(),
  phone: text('phone').notNull(), // MX-normalized; unique among the company's ACTIVE operators
  pinHash: text('pin_hash'), // null until first-run PIN setup (US-OP01)
  pinSalt: text('pin_salt'),
  pinAttempts: integer('pin_attempts').notNull().default(0), // >= 5 ⇒ locked until a manager resets
  accessToken: text('access_token').notNull().unique(), // the saved link's secret; rotated on remove/reset
  status: text('status', { enum: ['active', 'removed'] })
    .notNull()
    .default('active'),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
})

export type AffiliateOperator = typeof affiliateOperators.$inferSelect
export type NewAffiliateOperator = typeof affiliateOperators.$inferInsert

export type AffiliateCompany = typeof affiliateCompanies.$inferSelect
export type NewAffiliateCompany = typeof affiliateCompanies.$inferInsert
export type AffiliateCommission = typeof affiliateCommissions.$inferSelect
export type NewAffiliateCommission = typeof affiliateCommissions.$inferInsert
export type AffiliateInvitation = typeof affiliateInvitations.$inferSelect
export type NewAffiliateInvitation = typeof affiliateInvitations.$inferInsert

export type Organization = typeof organizations.$inferSelect
export type NewOrganization = typeof organizations.$inferInsert
export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert
export type Invitation = typeof invitations.$inferSelect
export type NewInvitation = typeof invitations.$inferInsert
export type PasswordResetToken = typeof passwordResetTokens.$inferSelect
export type NewPasswordResetToken = typeof passwordResetTokens.$inferInsert
export type Service = typeof services.$inferSelect
export type NewService = typeof services.$inferInsert
export type ServiceExtra = typeof serviceExtras.$inferSelect
export type NewServiceExtra = typeof serviceExtras.$inferInsert
export type Schedule = typeof schedules.$inferSelect
export type NewSchedule = typeof schedules.$inferInsert
export type Slot = typeof slots.$inferSelect
export type NewSlot = typeof slots.$inferInsert
export type Folio = typeof folios.$inferSelect
export type NewFolio = typeof folios.$inferInsert
export type FolioLine = typeof folioLines.$inferSelect
export type NewFolioLine = typeof folioLines.$inferInsert
export type FolioLineExtra = typeof folioLineExtras.$inferSelect
export type NewFolioLineExtra = typeof folioLineExtras.$inferInsert
export type AgentExpense = typeof agentExpenses.$inferSelect
export type NewAgentExpense = typeof agentExpenses.$inferInsert
export type CashDrop = typeof cashDrops.$inferSelect
export type NewCashDrop = typeof cashDrops.$inferInsert
export type Payout = typeof payouts.$inferSelect
export type NewPayout = typeof payouts.$inferInsert
export type FolioAccessToken = typeof folioAccessTokens.$inferSelect
export type NewFolioAccessToken = typeof folioAccessTokens.$inferInsert
export type CancellationRequest = typeof cancellationRequests.$inferSelect
export type NewCancellationRequest = typeof cancellationRequests.$inferInsert
export type AccommodationUnitType = typeof accommodationUnitTypes.$inferSelect
export type NewAccommodationUnitType = typeof accommodationUnitTypes.$inferInsert
export type AccommodationSeason = typeof accommodationSeasons.$inferSelect
export type NewAccommodationSeason = typeof accommodationSeasons.$inferInsert
export type AccommodationBlockout = typeof accommodationBlockouts.$inferSelect
export type NewAccommodationBlockout = typeof accommodationBlockouts.$inferInsert
export type AccommodationReservation = typeof accommodationReservations.$inferSelect
export type NewAccommodationReservation = typeof accommodationReservations.$inferInsert
