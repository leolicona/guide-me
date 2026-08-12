import { env } from 'cloudflare:test'

// Shared multitenancy test helpers.
//
// Every NEW tenant-scoped resource route (services, slots, folios, …) MUST add,
// in its own test suite, two isolation tests built on `seedTwoOrgs`:
//   • B3 — fetch-by-id of org A's row as org B's admin → 404 (no leakage)
//   • B4 — collection/list as org B's admin → org A's rows never appear
// See docs/multitenancy/multitenancy.spec.md (Scenarios B3, B4).

const DEFAULT_ORG_NAME = 'Empresa S.A.'

interface SeedUserOptions {
  email: string
  name?: string
  role?: 'admin' | 'agent' | 'affiliate'
  status?: 'unverified' | 'active' | 'suspended'
  /** Agent base commission as a whole-number percentage (default 0). */
  baseCommission?: number
  /** Reuse an existing org instead of creating a new one. */
  organizationId?: string
  organizationName?: string
  /** Link an `affiliate` user to its company (affiliate-setup-commissions.spec.md D4). */
  affiliateCompanyId?: string
}

export const seedUser = async ({
  email,
  name = 'Test User',
  role = 'admin',
  status = 'active',
  baseCommission = 0,
  organizationId,
  organizationName = DEFAULT_ORG_NAME,
  affiliateCompanyId,
}: SeedUserOptions): Promise<{ userId: string; organizationId: string }> => {
  const orgId = organizationId ?? crypto.randomUUID()
  const userId = crypto.randomUUID()

  if (!organizationId) {
    // US-A66 — seed test orgs in UTC so the suite's frozen UTC clock IS the org-local clock. The
    // whole suite reasons in naive-UTC wall-clock (slot times chosen against the frozen 12:00Z);
    // the production default is 'America/Mexico_City' (asserted separately in the organizations
    // suite, which seeds `timezone` explicitly). The tz-conversion math is covered by
    // test/pos/timezone.test.ts.
    await env.DB.prepare('INSERT INTO organizations (id, name, timezone) VALUES (?, ?, ?)')
      .bind(orgId, organizationName, 'UTC')
      .run()
  }

  await env.DB.prepare(
    `INSERT INTO users (id, organization_id, name, email, password_hash, password_salt, phone, role, status, base_commission, plan, affiliate_company_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      userId,
      orgId,
      name,
      email,
      'STORED_HASH',
      'STORED_SALT',
      '+52 55 1234 5678',
      role,
      status,
      baseCommission,
      'free',
      affiliateCompanyId ?? null,
    )
    .run()

  return { userId, organizationId: orgId }
}

/** Seeds an affiliate company (the partner) in the given org. */
export const seedAffiliateCompany = async ({
  organizationId,
  name = 'Hotel Maya',
  status = 'active',
}: {
  organizationId: string
  name?: string
  status?: 'active' | 'suspended'
}): Promise<{ companyId: string }> => {
  const companyId = crypto.randomUUID()
  await env.DB.prepare(
    'INSERT INTO affiliate_companies (id, organization_id, name, status) VALUES (?, ?, ?, ?)',
  )
    .bind(companyId, organizationId, name, status)
    .run()
  return { companyId }
}

/** Seeds one allow-list row (enables a service for an affiliate at a rate). */
export const seedAffiliateCommission = async ({
  organizationId,
  affiliateCompanyId,
  serviceId,
  commissionType = 'percent',
  commissionValue = 1500,
}: {
  organizationId: string
  affiliateCompanyId: string
  serviceId: string
  commissionType?: 'percent' | 'fixed'
  commissionValue?: number
}): Promise<void> => {
  await env.DB.prepare(
    `INSERT INTO affiliate_commissions (id, organization_id, affiliate_company_id, service_id, commission_type, commission_value)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      organizationId,
      affiliateCompanyId,
      serviceId,
      commissionType,
      commissionValue,
    )
    .run()
}

export const clearTenancyDb = async () => {
  // FK-safe order: drop the affiliate child rows before the companies they reference, and the
  // companies before the organizations + after the users that link to them.
  // TECH_DEBT #25 — materializeSeededFolio leaves `__fixture__` services (and possibly lines on
  // them) behind; purge them here so `DELETE FROM organizations` doesn't trip their FK.
  await env.DB.exec(
    `DELETE FROM folio_lines WHERE service_id IN (SELECT id FROM services WHERE name = '__fixture__')`,
  )
  await env.DB.exec(`DELETE FROM services WHERE name = '__fixture__'`)
  await env.DB.exec('DELETE FROM affiliate_commissions')
  await env.DB.exec('DELETE FROM affiliate_invitations')
  await env.DB.exec('DELETE FROM invitations')
  await env.DB.exec('DELETE FROM users')
  await env.DB.exec('DELETE FROM affiliate_companies')
  await env.DB.exec('DELETE FROM organizations')
}

/**
 * Full FK-safe wipe for suites that also seed services / slots / folios / cash drops alongside
 * affiliates. Deletes every dependent table before the organizations they reference.
 */
export const clearAffiliateDb = async () => {
  for (const table of [
    'cash_drops',
    'payouts',
    'agent_expenses',
    'folio_line_extras',
    'folio_events',
    'folio_requests',
    'folio_lines',
    'folio_access_tokens',
    'folio_payments',
    'notifications',
    'folios',
    'affiliate_commissions',
    'affiliate_invitations',
    'slots',
    'schedules',
    'service_extras',
    'services',
    'invitations',
    'password_reset_tokens',
    'users',
    'affiliate_companies',
    'organizations',
  ]) {
    await env.DB.exec(`DELETE FROM ${table}`)
  }
}

// US-LG04 — the cash engine reads the folio_payments LEDGER, so a directly-seeded folio must also
// seed its ledger rows (mirrors what confirmSale / settle / cancellation write, and the 0049/0050
// backfills). Call this from a test's seedFolio right after the folios INSERT. Emits: a `payment`
// row (= amount_paid, at created_at); a `commission` row (= commission_amount, if > 0); and for a
// cancelled folio the reversal rows — a negative `refund` (all cancellations) + a negative
// `commission_reversal` (clawback only), dated at cancelled_at — so the folio nets out of the
// sales/cash (and, on clawback, commission) buckets exactly as the engine expects.
export const seedFolioLedgerRows = async (opts: {
  folioId: string
  organizationId: string
  agentId: string
  status?: 'paid' | 'booking' | 'cancelled'
  paymentMethod?: string
  amountPaid: number
  commissionAmount?: number
  cancellationClawback?: boolean
  cancelledAt?: number // unix seconds; defaults to createdAt
  createdAt?: number // unix seconds
}): Promise<void> => {
  const method = opts.paymentMethod ?? 'cash'
  const commission = opts.commissionAmount ?? 0
  const createdAt = opts.createdAt ?? Math.floor(Date.now() / 1000)
  const insert = (entryType: string, amount: number, at: number) =>
    env.DB.prepare(
      `INSERT INTO folio_payments
         (id, organization_id, folio_id, entry_type, amount, method, verification, collected_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'not_required', ?, ?)`,
    )
      .bind(crypto.randomUUID(), opts.organizationId, opts.folioId, entryType, amount, method, opts.agentId, at)
      .run()

  await insert('payment', opts.amountPaid, createdAt)
  if (commission > 0) await insert('commission', commission, createdAt)
  if (opts.status === 'cancelled') {
    const at = opts.cancelledAt ?? createdAt
    if (opts.amountPaid > 0) await insert('refund', -opts.amountPaid, at)
    if (opts.cancellationClawback && commission > 0) await insert('commission_reversal', -commission, at)
  }
}

export interface SeededOrg {
  organizationId: string
  adminUserId: string
  adminEmail: string
  organizationName: string
}

/**
 * Seeds two fully isolated organizations, each with an active admin.
 * Use the returned `adminEmail` with `buildFakeJwt(email)` to authenticate as
 * either org's admin in a cross-org isolation test.
 */
export const seedTwoOrgs = async (): Promise<{
  orgA: SeededOrg
  orgB: SeededOrg
}> => {
  const adminAEmail = 'admin-a@empresa.com'
  const adminBEmail = 'admin-b@empresa.com'

  const a = await seedUser({
    email: adminAEmail,
    role: 'admin',
    organizationName: 'Org A',
  })
  const b = await seedUser({
    email: adminBEmail,
    role: 'admin',
    organizationName: 'Org B',
  })

  return {
    orgA: {
      organizationId: a.organizationId,
      adminUserId: a.userId,
      adminEmail: adminAEmail,
      organizationName: 'Org A',
    },
    orgB: {
      organizationId: b.organizationId,
      adminUserId: b.userId,
      adminEmail: adminBEmail,
      organizationName: 'Org B',
    },
  }
}

// TECH_DEBT #25 — the folio's roll-ups derive from the lines in the PRODUCT; tests that used to
// `SELECT status … FROM folios` read them through this instead. One SQL, mirroring
// utils/folioStatus.ts, so an assertion reads the same answer the API serves.
export const readDerivedFolio = async (
  folioId: string,
): Promise<Record<string, unknown> | undefined> => {
  const { results } = await env.DB.prepare(
    `SELECT f.*,
      (SELECT CASE
        WHEN COALESCE(SUM(CASE WHEN fl.cancelled_at IS NULL THEN 1 ELSE 0 END),0) = 0 THEN 'cancelled'
        WHEN COALESCE(SUM(CASE WHEN fl.cancelled_at IS NULL
            AND COALESCE((SELECT SUM(a2.amount) FROM folio_payment_allocations a2 WHERE a2.folio_line_id = fl.id),0) < fl.line_total
            THEN 1 ELSE 0 END),0) > 0 THEN 'booking'
        ELSE 'paid' END
       FROM folio_lines fl WHERE fl.folio_id = f.id) AS status,
      (SELECT COALESCE(
        (SELECT MIN(fl.booking_expires_at) FROM folio_lines fl
          WHERE fl.folio_id = f.id AND fl.cancelled_at IS NULL AND fl.booking_expires_at IS NOT NULL),
        (SELECT MIN(fl.booking_expires_at) FROM folio_lines fl
          WHERE fl.folio_id = f.id AND fl.booking_expires_at IS NOT NULL))) AS booking_expires_at,
      (SELECT CASE
        WHEN EXISTS (SELECT 1 FROM folio_lines fl WHERE fl.folio_id = f.id AND fl.refund_status = 'pending') THEN 'pending'
        WHEN EXISTS (SELECT 1 FROM folio_lines fl WHERE fl.folio_id = f.id AND fl.refund_status = 'refunded') THEN 'refunded'
        ELSE 'none' END) AS refund_status,
      (SELECT CASE
        WHEN EXISTS (SELECT 1 FROM folio_lines fl WHERE fl.folio_id = f.id AND fl.refund_status = 'pending')
          THEN (SELECT SUM(fl.refund_amount) FROM folio_lines fl WHERE fl.folio_id = f.id AND fl.refund_status = 'pending')
        WHEN EXISTS (SELECT 1 FROM folio_lines fl WHERE fl.folio_id = f.id AND fl.refund_status = 'refunded')
          THEN (SELECT SUM(fl.refund_amount) FROM folio_lines fl WHERE fl.folio_id = f.id AND fl.refund_status = 'refunded')
        ELSE NULL END) AS refund_amount
     FROM folios f WHERE f.id = ?`,
  )
    .bind(folioId)
    .all()
  return results[0] as Record<string, unknown> | undefined
}

// TECH_DEBT #25 — hand-seeded folios express intent through the SHIM columns (status,
// booking_expires_at, refund_status, refund_amount — test-only dead storage since 0065). The
// PRODUCT derives everything from the lines, so a fixture that wants the product to AGREE calls
// this once after seeding: it materializes the shim's intent as line facts — a minimal line when
// none exists, the ledger row, the allocations, the cancellation stamp, the debt, the clock —
// exactly the shape the 0062–0064 backfills gave real pre-feature folios.
export const materializeSeededFolio = async (folioId: string): Promise<void> => {
  const folio = (
    await env.DB.prepare(`SELECT * FROM folios WHERE id = ?`).bind(folioId).all()
  ).results[0] as Record<string, unknown> | undefined
  if (!folio) return
  const org = folio.organization_id as string
  const intent = (folio.status as string | null) ?? 'paid'
  const ts = (folio.created_at as number) ?? Math.floor(Date.now() / 1000)

  // 1. A folio with no lines gets one minimal slot line covering its total.
  let lines = (
    await env.DB.prepare(`SELECT * FROM folio_lines WHERE folio_id = ?`).bind(folioId).all()
  ).results as Array<Record<string, unknown>>
  if (lines.length === 0) {
    let svc = (
      await env.DB.prepare(
        `SELECT id FROM services WHERE organization_id = ? AND name = '__fixture__'`,
      )
        .bind(org)
        .all()
    ).results[0] as { id: string } | undefined
    if (!svc) {
      svc = { id: crypto.randomUUID() }
      await env.DB.prepare(
        `INSERT INTO services (id, organization_id, name, description, base_price, minimum_price, default_capacity, commission_type, commission_value, status, created_at, updated_at)
         VALUES (?, ?, '__fixture__', NULL, 100000, 0, 12, 'percent', 0, 'active', ?, ?)`,
      )
        .bind(svc.id, org, ts, ts)
        .run()
    }
    const lineId = crypto.randomUUID()
    await env.DB.prepare(
      `INSERT INTO folio_lines (id, organization_id, folio_id, service_id, slot_id, service_name, slot_date, slot_start_time, quantity, base_price, minimum_price, unit_price, line_total, created_at)
       VALUES (?, ?, ?, ?, NULL, '__fixture__', '2026-06-20', '09:00', 1, ?, 0, ?, ?, ?)`,
    )
      .bind(lineId, org, folioId, svc.id, folio.total, folio.total, folio.total, ts)
      .run()
    lines = (
      await env.DB.prepare(`SELECT * FROM folio_lines WHERE folio_id = ?`).bind(folioId).all()
    ).results as Array<Record<string, unknown>>
  }

  // 2. The ledger row (the 0049 shape) when the fixture wrote none.
  const amountPaid = Number(folio.amount_paid ?? 0)
  const hasPayment = (
    await env.DB.prepare(
      `SELECT 1 FROM folio_payments WHERE folio_id = ? AND entry_type = 'payment' LIMIT 1`,
    )
      .bind(folioId)
      .all()
  ).results.length
  if (!hasPayment && amountPaid > 0) {
    await env.DB.prepare(
      `INSERT INTO folio_payments (id, organization_id, folio_id, entry_type, amount, method, verification, collected_by, created_at)
       VALUES (?, ?, ?, 'payment', ?, 'cash', ?, ?, ?)`,
    )
      .bind(
        `pmt_${folioId}`,
        org,
        folioId,
        amountPaid,
        (folio.payment_verification as string) ?? 'not_required',
        folio.agent_id,
        ts,
      )
      .run()
  }

  // 3. Allocations: paid intent covers every line; a booking intent cascades the deposit.
  // Per LINE, not per folio, so a fixture that seeds its lines one at a time can call this after
  // each one (or once at the end) and converge on the same allocations either way.
  const allocatedByLine = new Map(
    (
      (
        await env.DB.prepare(
          `SELECT a.folio_line_id AS id, SUM(a.amount) AS amt FROM folio_payment_allocations a
             JOIN folio_lines l ON a.folio_line_id = l.id WHERE l.folio_id = ? GROUP BY a.folio_line_id`,
        )
          .bind(folioId)
          .all()
      ).results as Array<{ id: string; amt: number }>
    ).map((r) => [r.id, Number(r.amt)]),
  )
  if (amountPaid > 0) {
    // The fixture may have written its own ledger rows (any ids) — hang the allocations off the
    // first real payment instead of assuming the pmt_<folio> row step 2 would have created.
    const payment = (
      await env.DB.prepare(
        `SELECT id FROM folio_payments WHERE folio_id = ? AND entry_type = 'payment' ORDER BY created_at LIMIT 1`,
      )
        .bind(folioId)
        .all()
    ).results[0] as { id: string } | undefined
    const paymentId = payment?.id ?? `pmt_${folioId}`
    // A `paid`/`cancelled` intent means every line is settled, whatever `amount_paid` says — many
    // fixtures never made `folios.total` agree with Σ line_total, and it is the LINE's coverage the
    // product reads now. A `booking` intent cascades the deposit down the lines, as the sale does.
    let pool = amountPaid - [...allocatedByLine.values()].reduce((a, b) => a + b, 0)
    for (const l of lines) {
      if (allocatedByLine.has(l.id)) continue
      const lineTotal = Number(l.line_total)
      const take = intent === 'booking' ? Math.min(lineTotal, Math.max(0, pool)) : lineTotal
      if (take <= 0) continue
      await env.DB.prepare(
        `INSERT INTO folio_payment_allocations (id, organization_id, payment_id, folio_line_id, amount, backfilled, created_at)
         VALUES (?, ?, ?, ?, ?, 1, ?)`,
      )
        .bind(crypto.randomUUID(), org, paymentId, l.id, take, ts)
        .run()
      pool -= take
    }
  }

  // 4. Cancellation stamp + refund debt + hold clock, from the shim's intent.
  if (intent === 'cancelled') {
    await env.DB.prepare(
      `UPDATE folio_lines SET cancelled_at = ?, cancellation_source = ? WHERE folio_id = ? AND cancelled_at IS NULL`,
    )
      .bind(folio.cancelled_at ?? ts, folio.cancellation_source ?? 'admin', folioId)
      .run()
  }
  const refundStatus = folio.refund_status as string | null
  if (refundStatus === 'pending' || refundStatus === 'refunded') {
    await env.DB.prepare(
      `UPDATE folio_lines SET refund_status = ?, refund_amount = ? WHERE folio_id = ? AND id = (SELECT id FROM folio_lines WHERE folio_id = ? LIMIT 1)`,
    )
      .bind(refundStatus, folio.refund_amount ?? 0, folioId, folioId)
      .run()
  }
  if (intent === 'booking' && folio.booking_expires_at != null) {
    await env.DB.prepare(
      `UPDATE folio_lines SET booking_expires_at = ? WHERE folio_id = ? AND cancelled_at IS NULL AND booking_expires_at IS NULL`,
    )
      .bind(folio.booking_expires_at, folioId)
      .run()
  }
}
