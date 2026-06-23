# Affiliate Reseller Portal — Feature Spec

> **Status:** Draft / scaffold (2026-06-23). The affiliate-facing runtime.
> **Stories:** US-AF01–US-AF09.
> **Top-level spec:** `docs/SPEC.md` → *Affiliate (External Reseller)*.
> **Depends on:** `docs/affiliates/affiliate-setup-commissions.spec.md` (company, allow-list,
> commissions, invitations, the `affiliate` role, and folio attribution must exist first).

---

## 1. Summary & Intent

The portal lets an **admin-invited `affiliate`** (hotel / agency / restaurant concierge) sell the
operator's services to the groups they bring. The role is a **scoped-down Sales Agent**: same POS,
discount, booking, email, balance, and history machinery — **minus** the field capabilities. An
affiliate **cannot scan/validate QRs** (US-AG15) and **cannot record expenses** (US-AG13).

Two hard constraints distinguish it from an agent:
1. **Curated catalog** — the affiliate sees only the services enabled for their company
   (`affiliate_commissions` allow-list, US-A56). Never the full catalog.
2. **Commission source** — their earnings come from the per-affiliate rate, not `services.commission_*`.

Everything else (full payment mints the QR at sale; partial payment opens an apartado; manual
discount down to `minimum_price`; running balance settled by deposit/cash-drop) **reuses the agent
implementation** with a role/allow-list filter rather than new subsystems.

### Out of scope (this feature)

- Company/commission/allow-list management, invitations, attribution column, the `affiliate` role,
  and the setup migration — all in `affiliate-setup-commissions.spec.md`.
- QR scanning/validation and expense recording — **explicitly denied** to this role.
- Affiliate-negotiated net prices (sells at the operator's price; margin = commission).

---

## 2. Confirmed Decisions (2026-06-23)

- **D1 — Role-gated reuse.** Affiliates hit the existing `pos` / `cash` / `folios` routers; access
  is widened to `requireRole('agent','admin','affiliate')` and then **filtered**, not forked.
- **D2 — Curated catalog.** Every catalog/availability read for an `affiliate` caller is filtered
  to the services in their `affiliate_commissions` allow-list. A non-enabled `service_id` at
  checkout → `404`/`403` (defense in depth — never trust the client).
- **D3 — Commission source.** At sale, an affiliate seller's per-line commission resolves from
  `affiliate_commissions(company, service)`; same math + snapshot rule as the commissions spec
  (percent on discounted line total; fixed × quantity).
- **D4 — Capability denial.** Scanner (US-AG15) and expenses (US-AG13) endpoints reject an
  `affiliate` caller with `403`. No scanner/expense UI is rendered in the portal shell.
- **D5 — Balance parity.** Affiliate carries the agent running balance (Σ collected − Σ commission −
  Σ confirmed deposits), **minus expenses** (none exist for the role). Settles via cash-drop;
  admin confirms (US-A19 flow). Direction matches an agent.
- **D6 — Full payment mints QR; partial opens apartado.** Reuses US-AG07 / US-AG07.1–.5 verbatim.
- **D7 — Same shell, third role (not a separate app).** Admin and agent already share one
  `AppLayout` whose nav array is filtered by an optional `role` field, with routes diverging only
  where the surface differs (Ventas, Caja). Affiliate joins as a **third role in the same shell**:
  reuse `/pos`, widen `RoleGuard`/landing/nav unions to include `'affiliate'`, and give it a
  trimmed nav (no Escáner). This matches existing precedent and avoids a parallel app. *(Resolves Q3/Q7.)*
- **D8 — Ticket recipient = the affiliate.** On sale/settle the ticket + QR email is addressed to
  the **affiliate** (concierge) for group distribution, not the individual tourist. *(Resolves Q2/Q6.)*
- **D9 — In-person cash settlement, same as an agent.** The admin meets the affiliate periodically
  and receives the cash there; settlement is the existing agent **cash-drop → admin-confirm** flow
  (US-AG14 / US-A19), no remote/transfer-reference variant. *(Resolves Q4/Q8.)*

---

## 3. Data Model changes

**None new.** This feature consumes the tables added by the setup feature (`affiliate_companies`,
`affiliate_commissions`, `users.affiliate_company_id`, `folios.affiliate_company_id`) and reuses
`folios` / cash-drop tables unchanged. The seller is the existing `folios.agent_id` (an affiliate
user id); `affiliate_company_id` is stamped from the seller's company.

---

## 4. API Surface (reuse + filter)

Money in integer minor units; Multitenancy Rule 1 (no `organization_id` in bodies). Changes are
**role-widening + caller-scoping**, not new resources.

| Method & path | Change for affiliates | Errors | US |
|---|---|---|---|
| `POST /api/auth/accept-invitation` *(extended)* | accepts `company_name` (required) + `position` (optional) when the invite is for an `affiliate`; creates the `affiliate` user linked to the company | `400 VALIDATION_ERROR` | AF01 |
| `POST /api/auth/login`, `POST /api/auth/forgot-password` | unchanged; affiliate uses the same endpoints | — | AF02/AF03 |
| `GET /api/pos/services` *(filtered)* | for an `affiliate` caller, returns **only** allow-list services with `has_availability` | — | AF04 |
| `GET /api/pos/services/:id` *(guarded)* | non-allow-list service → `404` | `404` | AF04 |
| `POST /api/pos/folios` *(role-widened)* | `affiliate` allowed; commission resolves from `affiliate_commissions`; stamps `affiliate_company_id`; discount floor = `minimum_price`; `down_payment` opens apartado | `403 SERVICE_NOT_ALLOWED`, `400`, `409 SLOT_CLOSED` | AF04/AF05/AF06 |
| `POST /api/pos/folios/:id/settle`,`/cancel`,`/reminder`,`/reactivate` | available to `affiliate`, caller-scoped to their own folios | `404`, `409` | AF05 |
| `GET /api/pos/folios` *(caller-scoped)* | affiliate sees only their own folios | — | AF09 |
| `GET /api/cash/balance` + `POST /api/cash/drops` *(role-widened)* | affiliate running balance + deposit/cash-drop; **expenses route denied** | `403` (expenses) | AF08 |
| `POST /api/tickets/scan` *(denied)* | `affiliate` → `403 FORBIDDEN` | `403` | D4 |
| `POST /api/cash/expenses` *(denied)* | `affiliate` → `403 FORBIDDEN` | `403` | D4 |

### 4.2 Catalog filter implementation (D2 — the curated-catalog mechanic)

The existing `listPosServices` handler (`src/routes/pos/handler.ts`) builds the catalog from one
query: `SELECT … FROM services WHERE organization_id = ? AND status = 'active' ORDER BY name`, then
a second query sums slot availability. **For an affiliate caller**, add exactly one constraint so
the curated list falls out of the same query — no second source of truth, no view to keep in sync:

```ts
// caller is the affiliate user; caller.affiliateCompanyId is their company (set at acceptance)
const base = db.select({ /* …same columns… */ })
  .from(services)
  .where(and(
    eq(services.organizationId, caller.organizationId),
    eq(services.status, 'active'),
  ))

// affiliate-only: INNER JOIN gates the list to the allow-list rows for THIS company.
if (caller.role === 'affiliate') {
  base.innerJoin(affiliateCommissions, and(
    eq(affiliateCommissions.serviceId, services.id),
    eq(affiliateCommissions.affiliateCompanyId, caller.affiliateCompanyId),
  ))
}
```

Because enabling a service **is** creating its `affiliate_commissions` row (setup spec D1), the
inner join returns precisely the services the admin curated — a disabled/never-enabled service
produces no row and is therefore absent. The same join also yields the affiliate's per-service
`commission_type` / `commission_value`, so the commission resolution at checkout (D3) reads from
the row already in hand. Agent/admin callers skip the join and see the full active catalog,
unchanged. The single-day vs 3-day availability window logic (US-AG30) is untouched.

**Defense in depth:** `GET /api/pos/services/:id` and `POST /api/pos/folios` re-check the row
exists for an affiliate caller, so a hand-crafted request for a non-curated `service_id` →
`404` / `403 SERVICE_NOT_ALLOWED` even though it never appeared in the list.

---

## 5. Portal shell (UI/UX) — same shell, third role (D7)

Reuses the existing `AppLayout` (`src/layout/AppLayout.tsx`) rather than a separate app. Concrete
frontend changes:

- **Role unions widened** from `'admin' | 'agent'` to include `'affiliate'`: `RoleGuard`
  (`src/features/auth/components/RoleGuard.tsx`), the `NavItem.role` field + `NAV_ITEMS` filter,
  `AccountMenu` `roleLabel` (e.g. *"Afiliado"*), and `landingFor`.
- **Landing:** affiliate → `ROUTES.POS` (Vender), same as an agent (admins land on Hoy).
- **Nav set:** `[Vender, Ventas, Caja]` — the agent nav **minus Escáner** (no scanner for this
  role, D4). `Ventas` → own folio history; `Caja` → own balance + *Entregar*. No Hoy, no Equipo,
  no expenses. Achieved by tagging the relevant `NAV_ITEMS` with `role` and adding `'affiliate'`
  where shared (Vender/Caja) — mirrors how admin/agent already diverge on Ventas/Caja.
- **Catalog:** the same POS catalog, filtered to the curated services (§4.2).
- **Checkout:** identical adaptive amount-driven checkout (US-AG07.2) — full pay → QR; partial → apartado.
- **Onboarding (US-AF01):** the affiliate invite-acceptance form adds **Company name (required)** +
  **Position (optional)** on top of the standard name/password fields.
- Design-system: MUI elegant-minimalist (`CLAUDE.md`). **TODO:** screen mocks.

---

## 6. Scope boundary & cross-feature impact

- **Bookings** (`docs/bookings/...`): affiliate apartados reuse the flow as-is; the auto-expiry
  sweep and reminders apply unchanged.
- **Email** (`docs/email/...`): ticket/QR delivery reused; recipient is the **affiliate** (D8) for
  group distribution — the affiliate's account email, not a per-tourist address.
- **Commissions**: affiliate commission source switch is the only seam (D3).
- **Scanner / cash expenses**: add explicit `affiliate` denials (D4).

---

## 7. Test Scenarios (vitest is the API gate)

- **AF01 onboarding** — accepting an affiliate invite requires `company_name`; creates an
  `affiliate` user linked to the company; `position` optional.
- **AF04 curated catalog** — affiliate `GET /api/pos/services` returns only allow-list services;
  a non-enabled `service_id` at `GET /:id` and at checkout → `404`/`403`.
- **AF06 discount floor** — affiliate discount below `minimum_price` blocked, exactly like an agent.
- **AF/commission** — affiliate sale snapshots commission from `affiliate_commissions`, not
  `services.commission_*`; reduces the affiliate's running balance.
- **AF05 apartado** — partial payment opens a `booking`; QR minted only on settle.
- **D4 denials** — affiliate calling scan or expenses → `403`.
- **AF08 settle** — cash-drop reduces balance after admin confirmation; no expenses path exists.

### Multitenancy + isolation (required — `seedTwoOrgs`)
- Affiliate of `org_a` can never read/sell an `org_b` service or see an `org_b` folio (`404`).
- A `corporate`-style cross-affiliate read is `404`: affiliate A cannot see affiliate B's folios
  even within the same org (caller-scoped to their own `agent_id`).

---

## 8. Definition of Done

- [ ] `accept-invitation` extended for affiliate onboarding (company_name required, position optional).
- [ ] POS catalog + detail reads filtered to the affiliate's allow-list; checkout guards a
      non-allow-list `service_id` server-side.
- [ ] `POST /api/pos/folios` resolves commission from `affiliate_commissions` for affiliate sellers
      and stamps `affiliate_company_id`; discount floor + apartado behavior identical to agents.
- [ ] Scanner (`/api/tickets/scan`) and expenses (`/api/cash/expenses`) reject `affiliate` with `403`.
- [ ] Affiliate running balance + cash-drop reuse the agent model (no expenses); settles via the US-A19 confirm flow.
- [ ] Affiliate folio history caller-scoped; tickets/QR emailed on sale/settle.
- [ ] Portal shell renders the affiliate nav set (no Escáner / expenses / Equipo).
- [ ] Multitenancy + cross-affiliate isolation tests pass via `seedTwoOrgs`.

---

## 9. Resolved Decisions (2026-06-23) & Remaining Questions

All four original open questions are **resolved** (see §2 decisions + §4.2/§5):

1. **Catalog filter** → **inner-join `affiliate_commissions`** in the existing `listPosServices`
   read for affiliate callers (§4.2). Single source of truth; no view.
2. **Ticket recipient** → the **affiliate** (D8), addressed to their account email for distribution.
3. **Routing/shell** → **same shell, third role** (D7): reuse `/pos`, widen the role unions, trimmed
   nav (no Escáner).
4. **Cash settlement** → **in-person cash-drop, same as an agent** (D9): the admin meets the
   affiliate and confirms the hand-in via the US-A19 flow.

### Remaining (minor) questions

- **Customer email copy** — D8 sends the ticket to the affiliate. Do we *also* want an optional
  customer-email field on the affiliate checkout (off by default) for cases where the tourist wants
  their own copy, or is affiliate-only delivery sufficient for v1? (default: affiliate-only)
- **Booking reminders (US-AG07.3)** — for an affiliate apartado, does the WhatsApp/Reminder
  recovery action target the affiliate or the end customer? (default: the affiliate, consistent with D8)
