# Affiliate Setup & Commissions (Admin) — Feature Spec

> **Status:** Draft / scaffold (2026-06-23). Admin-side foundation for the affiliate program.
> **Stories:** US-A48, US-A49, US-A50, US-A51, US-A52, US-A53, US-A54–A57 (Setup Wizard).
> **Top-level spec:** `docs/SPEC.md` → *Affiliate Management* + *Affiliate Setup (Wizard)*.
> **Companion feature (depends on this):** `docs/affiliates/affiliate-portal.spec.md`.

---

## 1. Summary & Intent

Affiliates are **external resellers** (hotels, travel agencies, restaurants) who sell the
operator's services and send groups, earning a **per-affiliate negotiated commission**. This
feature is the **admin-side setup**: model the partner company, curate exactly **which services
the partner may sell and at what commission**, invite their logins, and attribute every sale so
in-house vs affiliate revenue stays separable.

The defining rule: a service is sellable by an affiliate **iff** the admin enabled it for that
affiliate (an `affiliate_commissions` row exists). That row carries the required commission and
**is** the allow-list — there is **no default catalog access and no fallback commission**. This
resolves the earlier open question (no standard-commission fallback, no zero-commission case).

This feature ships **before** the Affiliate Reseller Portal: an affiliate cannot log in or sell
until a company, its commissions, and an invitation exist.

### Out of scope (this feature)

- The affiliate-facing POS / selling / balance / cash-drops — see `affiliate-portal.spec.md`.
- Volume-tiered / automatic commission escalation (rates are flat percent or fixed-per-spot).
- Affiliate-specific negotiated **net prices** (affiliates sell at the operator's price and earn
  the commission as margin; price negotiation is explicitly not modeled).
- Editing a service's curation/commission **after** setup via the wizard — the wizard is
  create-only; post-creation edits use a standard detail form (D11).

---

## 2. Confirmed Decisions (2026-06-23)

- **D1 — Allow-list = commissions table.** `affiliate_commissions(affiliate_company_id, service_id)`
  existence gates visibility; deletion of the row removes the service from the affiliate's POS.
- **D2 — Commission required on enable.** A service cannot be enabled with an empty/zero rate;
  the wizard blocks *Siguiente*. Type is `percent` (basis points) | `fixed` (minor units per spot).
- **D3 — No fallback / no full catalog.** A service with no row is invisible and unsellable.
- **D4 — Affiliate user = `users` row, new `affiliate` role**, linked to one `affiliate_company`.
  Invitations reuse the existing agent-invite + Resend magic-link flow.
- **D5 — Attribution.** Every folio carries a nullable `affiliate_company_id`; the seller user is
  the existing `folios.agent_id`. Agent sales leave `affiliate_company_id` null.
- **D6 — Settlement direction = same as an agent.** The affiliate collects and holds the
  operator's cash; the report shows cash owed = collected − commission − confirmed deposits.
- **D7 — Suspend, don't delete.** Suspending a company/user blocks new logins & sales but leaves
  existing folios, QRs, and history intact (mirrors US-A08).
- **D8 — Invitation flow = parallel, not shared.** Affiliate invitations use a **separate flow**
  from the agent invite (own endpoint / acceptance path) so role + `affiliate_company_id` are
  carried explicitly and the agent flow stays untouched. *(Resolves Q1.)*
- **D9 — Wizard is one atomic save on *Finalizar*.** Steps 1–3 hold state **client-side only**;
  nothing is persisted until *Finalizar*, which writes company + all commission rows + invitations
  in **one transaction**. A mid-wizard abort leaves zero database rows. *(Resolves Q2.)*
- **D10 — Fixed rate ≤ `minimum_price`.** A `fixed` affiliate commission may not exceed the
  service's `minimum_price` (same guard as the commissions spec), so commission never exceeds the
  revenue of a maximally-discounted pass. Validated server-side on save. *(Resolves Q3.)*
- **D11 — Edit path = standard detail form, not the wizard.** After creation, the admin edits a
  company on a normal detail page (company fields + the same enable/commission list + user list),
  reusing the §4 `PUT` / bulk-upsert / invite / deactivate endpoints. The wizard is create-only.
  *(Resolves Q4.)*
- **D12 — Deactivating a service preserves affiliate rows (soft pause).** When a service is
  deactivated (US-A13 → `status:'inactive'`) its `affiliate_commissions` rows are **kept**; the
  service simply drops out of every affiliate catalog and reappears for the same affiliates on
  reactivation. Rows are removed only when the service is **hard-deleted** (US-A58). *(Resolves Q5.)*

---

## 3. Data Model changes

**Migration `0034_add_affiliates.sql`** — additive only (new tables + nullable column + role enum
widening). The `users.role` enum is app-level text (no DB CHECK), so adding `affiliate` needs no
column rebuild — only the Drizzle enum + any guards.

### `affiliate_companies` (new)
```ts
export const affiliateCompanies = sqliteTable('affiliate_companies', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull().references(() => organizations.id),
  name: text('name').notNull(),                       // US-A55 (required)
  contactEmail: text('contact_email'),
  contactPhone: text('contact_phone'),
  status: text('status', { enum: ['active', 'suspended'] }).notNull().default('active'), // US-A52
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
})
// Index: (organization_id) leading — Multitenancy Rule 6.
```

### `affiliate_commissions` (new — allow-list + rate, D1/D2)
```ts
export const affiliateCommissions = sqliteTable('affiliate_commissions', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull().references(() => organizations.id),
  affiliateCompanyId: text('affiliate_company_id').notNull().references(() => affiliateCompanies.id),
  serviceId: text('service_id').notNull().references(() => services.id),
  commissionType: text('commission_type', { enum: ['percent', 'fixed'] }).notNull(),
  commissionValue: integer('commission_value').notNull(), // bps (percent) | minor units/spot (fixed)
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
})
// UNIQUE (affiliate_company_id, service_id) — one rate per service per affiliate.
// Index: (organization_id, affiliate_company_id) leading.
// D10 — a `fixed` commissionValue must be ≤ the service's minimum_price (same guard as the
// commissions spec). Enforced server-side on save (wizard finalize + bulk upsert).
// D12 — rows survive a service deactivation (soft pause); they are deleted only when the
// service is hard-deleted (US-A58 cascades / pre-deletes these rows).
```

### `users` (modified)
```ts
role: text('role', { enum: ['admin', 'agent', 'affiliate'] }).notNull(),          // + 'affiliate'
affiliateCompanyId: text('affiliate_company_id').references(() => affiliateCompanies.id), // nullable
```

### `folios` (modified — attribution, D5)
```ts
// null for in-house (agent/admin) sales; set to the seller's company for affiliate sales (US-A51).
affiliateCompanyId: text('affiliate_company_id').references(() => affiliateCompanies.id),
```

> **D8 — parallel invitation flow.** The affiliate invite does **not** reuse the agent
> `invitations` path. It uses a dedicated endpoint (§4 `POST /api/affiliates/:id/invite`) and its
> own acceptance route, carrying `role:'affiliate'` + `affiliate_company_id` explicitly. Whether
> this is a new `affiliate_invitations` table or the shared `invitations` table with added
> `role` + `affiliate_company_id` columns is an implementation choice — either keeps the agent
> flow untouched. A dedicated table is the cleaner default.

---

## 4. API Surface

All routes admin-only (`authMiddleware` + `requireRole('admin')`), org-scoped. Money in integer
minor units. Per Multitenancy Rule 1, no `organization_id` in request bodies.

| Method & path | Payload | Success | Errors | US |
|---|---|---|---|---|
| `POST /api/affiliates` *(wizard finalize)* | `{ company:{name, contact_email?, contact_phone?}, commissions:[{service_id, commission_type, commission_value}], invites:[email] }` | `201` (company + counts) | `400 VALIDATION_ERROR` (no name / enabled service w/ zero rate), `409 SERVICE_INACTIVE` | A54–A57 |
| `GET /api/affiliates` | — | `200` (list: name, status, #services, #users) | — | A48 |
| `GET /api/affiliates/:id` | — | `200` (company + commissions + users) | `404` | A48 |
| `PUT /api/affiliates/:id` | `{ name?, contact_*? }` | `200` | `404`, `400` | A48 |
| `PUT /api/affiliates/:id/commissions` *(bulk upsert)* | `[{service_id, commission_type, commission_value}]` — absent service ⇒ row deleted (disabled) | `200` | `404`, `400` | A50 |
| `POST /api/affiliates/:id/invite` | `{ email }` | `201` (invitation) | `404`, `409 ALREADY_INVITED` | A49 |
| `POST /api/affiliates/:id/deactivate` / `.../reactivate` | `{}` | `200` | `404` | A52 |
| `GET /api/affiliates/:id/report?from&to` | — | `200` (sales, commission, cash owed) | `404` | A53 |

> **Wizard atomicity (D9):** `POST /api/affiliates` validates everything first, then writes company
> + all commission rows + invitation records in **one transaction** (fail-all — any invalid field
> aborts the whole save, no partial company). Resend emails are dispatched **after** the commit, so
> a mail-provider hiccup never leaves a half-saved affiliate; a failed send surfaces as a
> resend-able pending invitation rather than rolling back the company.

### 4.1 Suspend semantics (US-A52)
- Company `suspended` → all its users denied at `authMiddleware` (reuse the `ACCOUNT_SUSPENDED` 403
  path from staff-management) **and** new sales blocked. Existing folios/QRs untouched.

---

## 5. The Setup Wizard (US-A54–A57)

Mirrors the Service Creation Wizard (`docs/catalog/service-wizard.spec.md`): full-screen on mobile
(90vh, rounded top), fixed header (*"Nuevo afiliado"*, close X, *"PASO n DE 3"*), progress bar,
fixed footer *Anterior* / *Siguiente* → *Finalizar*. Create-only.

- **Step 1 — Company Info (US-A55):** Name (required) + contact email/phone. *Siguiente* blocked
  until name valid.
- **Step 2 — Catalog & Commissions (US-A56):** list active services, each ON/OFF; ON reveals an
  inline commission input + %/$ segmented toggle (symbol updates). *Siguiente* blocked if any
  enabled service has empty/zero commission. Enabled set → `affiliate_commissions` rows.
- **Step 3 — Invitations (US-A57):** add 0..n emails; on *Finalizar* persist + send Resend invites.
  Emails optional (invite later via §4 `POST .../invite`).

> Design-system conformance: MUI, elegant-minimalist (see `CLAUDE.md`). **TODO:** screen mocks.

---

## 6. Scope boundary & cross-feature impact

- **Commissions spec** (`docs/commissions/service-based-commission.spec.md`): the affiliate rate is
  an *override source* selected at sale when the seller is an affiliate; math + snapshot rule
  unchanged. The affiliate path reads `affiliate_commissions`, not `services.commission_*`.
- **Folio attribution** consumed by dashboards/reports (US-A16/A17/A18) — the period commission &
  settlement report groups by seller and surfaces `affiliate_company_id`; US-A53 is its per-affiliate
  drill-down (`docs/reports/commission-report.spec.md`). The single-day dashboard (US-A16) extension
  remains TODO.
- **Auth/invitations** reuse the agent flow; only the created user's role + company link differ.

---

## 7. Test Scenarios (vitest is the API gate)

- **Wizard finalize** — creates company + N commission rows + M invitations atomically.
- **Enable requires rate** — enabling a service with zero/empty rate → `400`.
- **Disable deletes row** — bulk upsert omitting a service removes it from the allow-list.
- **Attribution** — an affiliate sale stamps `folios.affiliate_company_id`; an agent sale leaves it null.
- **Suspend** — suspended company's users hit `403 ACCOUNT_SUSPENDED`; existing folios intact.
- **Report** — cash owed = collected − commission − confirmed deposits over the range.

### Multitenancy isolation (required — `seedTwoOrgs`, per `CLAUDE.md`)
- **B4 list scope** — `org_a` admin's `GET /api/affiliates` never returns `org_b` companies.
- **B3 cross-org 404** — `org_a` admin acting on an `org_b` affiliate id → `404`, unchanged.
- **B1 injected org** — `organizationId` in any body is stripped by Zod; rows stay `org_a`.
- **Cross-org service enable** — enabling an `org_b` `service_id` for an `org_a` affiliate → `404`/`400`.

---

## 8. Definition of Done

- [ ] Migration `0034_add_affiliates.sql`: `affiliate_companies`, `affiliate_commissions` (+ UNIQUE +
      org-leading indexes), `users.affiliate_company_id`, `folios.affiliate_company_id`.
- [ ] Drizzle schema updated; `users.role` enum includes `affiliate`.
- [ ] `affiliates` router mounted; all endpoints in §4 implemented, admin-only.
- [ ] All reads/writes filter by `c.var.user.organizationId` (Rules 2 & 4); no `organizationId` in any Zod schema (Rule 1).
- [ ] Enable-requires-rate + disable-deletes-row enforced server-side (not just UI).
- [ ] `authMiddleware` rejects suspended affiliate company users with `403 ACCOUNT_SUSPENDED`.
- [ ] Setup Wizard (US-A54–A57) implemented; create-only; design-system conformant.
- [ ] Multitenancy tests (B1/B3/B4 + cross-org service enable) pass via `seedTwoOrgs`.

---

## 9. Resolved Decisions (2026-06-23) & Remaining Questions

All five original open questions are **resolved** (see §2 decisions):

1. **Invitation carrier** → **parallel flow** (D8). Dedicated endpoint + acceptance route carrying
   `role` + `affiliate_company_id`; agent flow untouched. (Table vs shared-columns = impl. choice.)
2. **Wizard atomicity** → **one atomic save on *Finalizar*** (D9). Nothing persists until then;
   fail-all on validation; Resend emails fire after commit.
3. **Fixed-rate ceiling** → **yes** (D10). `fixed` ≤ service `minimum_price`, enforced server-side.
4. **Edit path** → **standard detail form** (D11), reusing the §4 PUT/upsert/invite endpoints; wizard is create-only.
5. **Orphan rows on service deactivate** → **preserve (soft pause)** (D12). Rows survive US-A13
   deactivation and reappear on reactivation; removed only on hard delete (US-A58).

### Remaining (minor) questions

- **`minimum_price` lowered below an existing fixed rate (US-A13 edit).** D10 guards rate-on-save;
  should lowering a service's `minimum_price` later also re-validate / clamp existing affiliate
  fixed rates, or just flag them? (default: flag in the affiliate detail view, don't auto-mutate)
- **Service hard-delete (US-A58) cascade** — confirm `affiliate_commissions` rows are pre-deleted
  in the same transaction as the service delete (FK has no `ON DELETE CASCADE` by default in D1).
  Specced in the catalog feature; noted here as the consumer.
