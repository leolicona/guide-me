import { sql } from 'drizzle-orm'
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'

export const organizations = sqliteTable('organizations', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
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
  subtotal: integer('subtotal').notNull(),
  discountTotal: integer('discount_total').notNull().default(0),
  total: integer('total').notNull(),
  amountPaid: integer('amount_paid').notNull(),
  cancelledAt: integer('cancelled_at', { mode: 'timestamp' }), // set on total cancellation (US-A21)
  cancelledBy: text('cancelled_by').references(() => users.id), // admin who cancelled
  cancellationReason: text('cancellation_reason'), // optional admin note
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

export const cashDrawers = sqliteTable('cash_drawers', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id')
    .notNull()
    .references(() => organizations.id),
  agentId: text('agent_id')
    .notNull()
    .references(() => users.id),
  businessDate: text('business_date').notNull(), // 'YYYY-MM-DD' org-local day
  status: text('status', { enum: ['open', 'submitted', 'approved', 'rejected'] })
    .notNull()
    .default('open'),
  totalCollected: integer('total_collected'), // snapshot at close
  pendingBalance: integer('pending_balance'),
  expenseTotal: integer('expense_total'),
  netBalance: integer('net_balance'),
  folioCount: integer('folio_count'),
  submittedAt: integer('submitted_at', { mode: 'timestamp' }),
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

export const cashDrawerExpenses = sqliteTable('cash_drawer_expenses', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id')
    .notNull()
    .references(() => organizations.id),
  cashDrawerId: text('cash_drawer_id')
    .notNull()
    .references(() => cashDrawers.id),
  description: text('description').notNull(),
  amount: integer('amount').notNull(), // minor units, > 0
  createdAt: integer('created_at', { mode: 'timestamp' })
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
export type CashDrawer = typeof cashDrawers.$inferSelect
export type NewCashDrawer = typeof cashDrawers.$inferInsert
export type CashDrawerExpense = typeof cashDrawerExpenses.$inferSelect
export type NewCashDrawerExpense = typeof cashDrawerExpenses.$inferInsert
