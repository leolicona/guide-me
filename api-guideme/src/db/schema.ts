import { sql } from 'drizzle-orm'
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'

export const organizations = sqliteTable('organizations', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  // Hours an admin money-move (direct collection / adjusted confirm) stays awaiting the
  // agent's signature before it auto-signs (US-AG27/AG28). Per-org configurable; default 24.
  ackWindowHours: integer('ack_window_hours').notNull().default(24),
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
  role: text('role', { enum: ['admin', 'agent'] }).notNull(),
  status: text('status', { enum: ['unverified', 'active', 'suspended'] })
    .notNull()
    .default('unverified'),
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

export const folios = sqliteTable('folios', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id')
    .notNull()
    .references(() => organizations.id),
  agentId: text('agent_id')
    .notNull()
    .references(() => users.id),
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
  subtotal: integer('subtotal').notNull(),
  discountTotal: integer('discount_total').notNull().default(0),
  total: integer('total').notNull(),
  amountPaid: integer('amount_paid').notNull(),
  // Commission the agent earns on this sale (minor units), snapshotted at confirm time
  // (US-AG23). Deducted from the running balance unless clawed back on cancellation.
  commissionAmount: integer('commission_amount').notNull().default(0),
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
  slotId: text('slot_id')
    .notNull()
    .references(() => slots.id),
  serviceName: text('service_name').notNull(), // snapshot at sale time
  slotDate: text('slot_date').notNull(), // snapshot 'YYYY-MM-DD'
  slotStartTime: text('slot_start_time').notNull(), // snapshot 'HH:MM'
  quantity: integer('quantity').notNull(),
  basePrice: integer('base_price').notNull(), // snapshot unit base price
  minimumPrice: integer('minimum_price').notNull(), // snapshot unit floor
  unitPrice: integer('unit_price').notNull(), // sold unit price (post-discount)
  lineTotal: integer('line_total').notNull(),
  qrToken: text('qr_token'), // signed access ticket; null for folios sold pre-feature
  redeemedCount: integer('redeemed_count').notNull().default(0), // passes redeemed; <= quantity
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
