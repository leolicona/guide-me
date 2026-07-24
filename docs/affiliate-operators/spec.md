# Feature: Temporary PIN Access for Affiliate Operators

**User stories:** US-AF10–AF13 (manager registers, WhatsApp-sends, revokes operators, and reads
sales tagged by operator), US-OP01–OP02 (operator sets a PIN on first link open, then unlocks a
temporary shift with PIN only), US-A68 (admin sees operator attribution on a hotel's consolidated
caja). To register in `docs/SPEC.md`. **Phase:** 2 (Core Enhancements) · **affiliate + operator +
admin surface.**

**Depends on:** *Affiliate Setup & Commissions* (`docs/affiliates/affiliate-setup-commissions.spec.md`)
— the `affiliate_companies`, the `affiliate` role, and the folio attribution this layers under ·
*Affiliate Reseller Portal* (`docs/affiliates/affiliate-portal.spec.md`, US-AF01–AF09) — the curated
POS / balance / cash-drop machinery an operator session reuses **verbatim** · *WhatsApp Ticket
Delivery* (`docs/whatsapp-qr-delivery/spec.md`) — the `wa.me/<phone>?text=` "opens the sender's
WhatsApp" pattern story #3 reuses · *Auth* (`agnosticAuth`, `hashPassword`/`verifyPassword`,
`setSessionCookies`) — the scrypt hashing and cookie session this extends with a short-lived,
operator-flavored token.

> **What & why.** Today an affiliate is a **single credentialed seller** (email + password). A hotel
> reselling our tours in practice has **one cashier account** but **many shift workers** at the
> register. This feature lets that one account (the **manager / "Hotel Cashier"**) register its
> employees as lightweight **operators** — name + phone only — hand each a **WhatsApp access link**,
> and have every employee unlock a **temporary shift** with a **4-digit PIN** (restaurant-terminal
> model). Every operator's sale rolls into the **one hotel caja** exactly as the manager's own sales
> do; the folio simply records **`Sold by: Juan`** so the manager can reconcile shifts and the admin
> keeps settling with the single hotel account. **No new role, no new ledger, no change to how the
> admin collects.**

---

## Context

**How affiliate selling works today.**
- An `affiliate` **user** (email + password, admin-invited — US-AF01) belongs to one
  `affiliate_company`. It sells through a curated POS (US-AF04), carries a running balance
  (US-AF08), and settles by cash-drop → admin-confirm. Folios are stamped `agent_id` (the seller) +
  `affiliate_company_id`. The admin's settlement report aggregates per `affiliate_company_id`
  (US-A53).
- Auth is **email + password + Resend magic link**; `users.email` is `NOT NULL UNIQUE`. There is
  **no PIN, no phone-login, no short session, and no sub-seller layer** anywhere.

**Key facts that shape this feature.**
- Operators are **not people we credential** — they have no email and must not become `users` rows
  (which would force `email` nullable and risk leaking into every "one affiliate = one seller"
  balance/commission query). They are a **lightweight layer under the company**.
- The affiliate portal is **already role-gated reuse** (D1 of the portal spec): affiliates hit the
  existing `pos`/`cash`/`folios` routers as a widened role. An operator session can therefore
  **borrow the manager's authorization** and add only an attribution stamp — no forked POS.
- `wa.me/<phone>?text=…` **opens the *sender's* WhatsApp** with the target number + message
  pre-filled. Story #3 is exactly this, with the operator's access link in the text.

---

## Decisions (grilled & confirmed)

- **D1 — Operators are a new lightweight table, NOT users.** `affiliate_operators`, owned by
  `affiliate_company_id` (any of the company's affiliate users may manage them). Never in `users`;
  they hold no email and no password — only a **PIN** and an **access token**.
- **D2 — Attribution, not accounting.** `folios.operator_id` (nullable FK → `affiliate_operators`).
  The folio's **`agent_id` stays the owning manager**, so caja, commission, balance, and settlement
  are **completely unchanged** — `operator_id` is a pure label (`Sold by: {name}`). `null` = the
  manager sold directly (rendered as the hotel, no "Sold by" line — default).
- **D3 — One hotel caja; no per-operator ledger.** Every operator sale accrues to the manager's
  balance exactly as the manager's own sales do. Story #7 ("reconcile employees") = **grouping the
  hotel's receipts by operator**, a read/filter — not a second balance. Story #8 ("consolidated
  caja") is therefore **true by construction**: the admin settles with the one hotel account as
  today.
- **D4 — Auth = durable link (identity) + PIN (secret) → 24h session.** Each operator gets one
  **long-lived signed access URL** that never expires until revoked — it identifies *who*, nothing
  more. **First open** (no PIN yet): set + confirm a **4-digit PIN**. **Every day after**: the link
  identifies them, the **PIN** unlocks and mints a **24-hour** session; after 24h the session dies
  and they re-enter **only the PIN** via the same saved link (story #5 — "instant new shift"). No
  refresh token for operators — the short expiry is the point.
- **D5 — An operator session borrows the manager's identity + adds an operator claim.** The 24h
  operator JWT carries the **owning manager's identity** (so `requireRole('affiliate')`, org, and
  company all resolve through the existing middleware) **plus an `op` claim** = operator id. Auth
  middleware sets `c.get('user')` = the manager and `c.get('operator')` = the operator row.
  `confirmSale` (and settle) stamp `operator_id` from `c.get('operator')`.
- **D6 — Full parity minus employee management.** An operator does everything the manager can in the
  POS/caja — sell, discount, apartado, **cash-drop/settle** (it's the one shared caja), see the
  hotel's full balance and every operator's receipts — **except** the operators-management panel,
  which is gated to a **real manager session** (`c.get('operator')` is null).
- **D7 — Registration = name + phone only.** The manager registers an operator with a **name**
  (required) and a **phone** (required, MX-normalized). Creation mints the `access_token`. **Phone
  is unique among the company's *active* operators** (a removed operator's phone is reusable) — the
  WhatsApp link targets that number, so it must be unambiguous.
- **D8 — One-click WhatsApp send.** A button beside each operator opens `wa.me/<operatorPhone>?text=…`
  — the **manager's** WhatsApp, pre-filled with a Spanish message + the operator's access link
  (`{APP_BASE_URL}/o/{access_token}`). No copy-paste.
- **D9 — Remove = soft.** `status = 'removed'` invalidates the link (rotate/void `access_token`) and
  clears `pin_hash` so it can never unlock again — but the row survives, so historical folios still
  read `Sold by: Juan`. The freed phone may be reused for a new operator.
- **D10 — PIN security.** 4 digits, hashed with the existing **`hashPassword`** (scrypt; never
  plaintext). **5 consecutive wrong entries → locked** (`pin_attempts >= 5`) until a manager resets.
  A wrong PIN increments; a correct one resets the counter. Only a **manager** recovers a locked /
  forgotten operator — re-send the link and/or **reset** (clears `pin_hash` + attempts → the
  operator sets a fresh PIN on next open, the first-run flow again). Operators have no email, so
  there is **no self-service reset** — but an operator **may change their own PIN** from within an
  active session (current + new).
- **D11 — Admin sees the operator label too.** Operator attribution surfaces on the **admin's** folio
  reads (drill into a hotel's sales by operator), not just the manager's — harmless and useful for
  audits.
- **D12 — Credential is a 4-digit PIN, not a password.** The saved link already carries the entropy
  (a high-entropy signed token); the PIN is a **second factor** guarding an expired-session phone,
  with a lockout — matching a phone lock screen / restaurant terminal and the field ergonomics of a
  numeric keypad. Same `hashPassword` storage, so switching to a password later is input-validation +
  UI only.

---

## Data model

New table + one additive column (additive migration `0048_affiliate_operators.sql`):

```ts
// A shift worker at an affiliate company's register — NOT a user (no email/password). Owned by the
// company; managed by any of its affiliate users. Identified by a durable access_token (the saved
// WhatsApp link) and unlocked by a 4-digit PIN. Pure attribution: its sales roll into the owning
// manager's one caja (folios.agent_id stays the manager); operator_id only labels "Sold by: {name}".
export const affiliateOperators = sqliteTable('affiliate_operators', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull().references(() => organizations.id),
  affiliateCompanyId: text('affiliate_company_id').notNull().references(() => affiliateCompanies.id),
  // The affiliate user who owns this operator — folios sold by it are attributed to this manager's
  // caja/balance (folios.agent_id). Resolves the operator session's borrowed identity (D5).
  managerId: text('manager_id').notNull().references(() => users.id),
  name: text('name').notNull(),
  phone: text('phone').notNull(),         // MX-normalized; unique among the company's ACTIVE operators
  pinHash: text('pin_hash'),              // null until first-run PIN setup (US-OP01)
  pinSalt: text('pin_salt'),
  pinAttempts: integer('pin_attempts').notNull().default(0), // >= 5 ⇒ locked until a manager resets
  accessToken: text('access_token').notNull().unique(),      // the saved link's secret; rotated on remove/reset
  status: text('status', { enum: ['active', 'removed'] }).notNull().default('active'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
})

// folios gains (additive):
// The shift operator who made the sale (US-AF13). Null ⇒ the manager sold directly. Pure attribution
// — agent_id (the manager) still owns the money. FK, so a soft-removed operator keeps naming history.
operatorId: text('operator_id').references(() => affiliateOperators.id),
```

No backfill needed — `operator_id` is null on every existing folio (all past sales were the manager's
own), and there are no operators yet.

---

## Server changes (`api-turistear/`)

**Auth (`middleware/auth.ts` + a JWT helper).**
- Mint a **24h operator JWT** carrying the manager's identity + `op` = operator id (reuse the
  existing signing key; a small `signOperatorSession` helper). No refresh token.
- In the middleware, after resolving `user` from the identity: if the token has an `op` claim, load
  the operator, assert `status = 'active'` and it belongs to `user`'s company, then
  `c.set('operator', operator)`. A removed/locked operator ⇒ `401` (its sessions die at once).

**Operator access router (token-based, public — mirrors `acceptInvite`/portal).**
- `GET  /api/operator/access/:token` — resolve the link: `{ operator_name, hotel_name, pin_set }`
  (`pin_set=false` ⇒ first-run). `404` if token unknown/removed.
- `POST /api/operator/access/:token/set-pin` — first-run only (`pin_hash` null): `{ pin, confirm }`
  (4 digits, equal) → `hashPassword` → store → mint 24h session cookie. `409` if a PIN already
  exists.
- `POST /api/operator/access/:token/login` — `{ pin }` → `verifyPassword`; success → reset attempts +
  mint 24h session; failure → increment attempts (`423 LOCKED` at ≥ 5). `409` if no PIN set yet.
- `POST /api/operator/change-pin` — session-guarded (`c.get('operator')` present): `{ current, new }`.

**Manager operators router (`requireRole('affiliate')`, real-manager only — reject `c.get('operator')`).**
- `GET  /api/affiliate/operators` — list the company's operators (active first): id, name, phone,
  status, `pin_set`, locked, `access_url` (for the WhatsApp button).
- `POST /api/affiliate/operators` — `{ name, phone }` → normalize phone, enforce active-phone
  uniqueness, mint `access_token`, `managerId = caller`. Returns the row incl. `access_url`.
- `POST /api/affiliate/operators/:id/reset-pin` — clear `pin_hash`/`pin_salt` + attempts, **rotate**
  `access_token` (old link dies), so the operator re-sets a PIN on next open.
- `POST /api/affiliate/operators/:id/remove` — `status='removed'`, void `access_token`, clear
  `pin_hash`. Idempotent.

**POS attribution (`pos/handler.ts`).**
- `confirmSale` and `settle`: set `operatorId = c.get('operator')?.id ?? null`. Everything else
  (agent_id, commission, balance, verification) unchanged.
- `readFolio` / `listFolios` / `listAgentFolios`: expose `operator_id` + `operator_name` (join), and
  accept an **`operator` filter** for the manager's grouping view (US-AF13). Admin reads expose it
  too (US-A68).

**Multitenancy.** Every operator route is org- + company-scoped from context, never the body;
cross-org isolation tests via `seedTwoOrgs` (a manager/operator in org A is `404` to org B).

## Client changes (`app-turistear/`)

- **Operators panel** (new, manager-only — in the affiliate portal's account/management surface):
  list operators; **"Agregar operador"** (name + phone `FormSheet`); each row has **WhatsApp send**
  (opens `wa.me/<phone>?text=…` with the link), **Reenviar/Restablecer PIN**, and **Quitar**
  (`ConfirmSheet`). Status/locked chips (`StatusChip`). Gated off the nav for operator sessions.
- **Operator access pages** (new, unauthenticated route `/o/:token`): resolve the link →
  - first-run: a **set-PIN** screen (4-digit keypad, enter + confirm);
  - returning: a **PIN unlock** screen (single 4-digit entry, lockout message at ≥5);
  then land on the affiliate POS. A big numeric **PinPad** primitive (≥48px targets, sunlight-legible
  per the design system). No email/password fields anywhere.
- **Session banner** — an operator session shows a subtle "Operador: {name}" marker and a **"Cambiar
  PIN"** action; a "Sesión termina en …/expira" hint is optional.
- **Folio attribution** — the receipt + folio detail show **`Vendido por: {operator}`** when
  `operator_id` is set; the manager's/admin's folio list shows an **operator column + filter**
  (US-AF13 / US-A68).
- **Services/hooks** — `operatorsService` (CRUD + `access_url`), `operatorAccessService` (resolve /
  set-pin / login / change-pin), `useOperators`, and the operator-session context.

---

## Acceptance criteria

**US-AF10 (manager registers operators)**
1. A manager registers an operator with **name + phone only**; the operator appears active with a
   generated access link and **no PIN yet**.
2. Registering a second **active** operator with the **same phone** in the company → validation error
   (client + `409` server). A removed operator's phone may be reused.

**US-AF11 (one-click WhatsApp send)**
3. The send button opens the **manager's** WhatsApp targeting the operator's number with a Spanish
   message containing the operator's access link (`/o/{token}`).

**US-OP01 (first-run PIN setup)**
4. Opening a fresh link prompts **set + confirm a 4-digit PIN**; mismatch or non-4-digit is rejected.
   On success a **24h session** is minted and the operator lands on the POS.

**US-OP02 (daily PIN unlock / temporary access)**
5. After the session expires, re-opening the **saved link** asks for **only the PIN**; the correct
   PIN starts a new 24h shift. **5 wrong PINs** locks the operator (`423`) until a manager resets.

**US-AF13 (sales traceability by operator)**
6. A sale made in an operator session records `operator_id`; the folio and lists show
   **`Vendido por: {operator}`**, and the manager can **filter the hotel's folios by operator**.
7. A sale made directly by the manager has `operator_id = null` and shows **no** "Vendido por" line.
8. **Full parity** — in an operator session the POS, discounts, apartados, **cash-drop/settlement**,
   balance, and history all work identically to the manager; **only** the operators-management panel
   is hidden/`403`.

**US-AF12 (revocation)**
9. **Remove** an operator → their link + PIN stop working immediately (`401`/`404`); they can no
   longer sell. Their **past folios keep** `Vendido por: {name}`.

**US-A68 (admin consolidated caja + attribution)**
10. All operator sales roll into the **one hotel caja** (agent_id = the manager); the admin's
    settlement with the hotel is unchanged, and the admin can **see the operator label** on the
    hotel's folios.

**Isolation**
11. A manager/operator in org A is `404` to org B for every route (`seedTwoOrgs`).

## Definition of Done

- Migration `0048` applied local + remote; `cf-typegen` clean.
- Tests: operator CRUD + active-phone uniqueness; first-run set-PIN → session; login success/reset,
  wrong-PIN increment + lockout at 5; manager reset (rotate token, re-set PIN); remove kills
  link/PIN but keeps attribution; operator session sells with `operator_id` stamped and has full
  POS/caja parity but `403` on the operators panel; folio reads expose + filter by operator; cross-org
  isolation (`seedTwoOrgs`). Full API suite green.
- `pnpm build:app` + `pnpm lint:app` clean; operator link → set-PIN → sell → expire → re-PIN, plus
  the manager panel (register / WhatsApp / reset / remove), verified end-to-end.
- Registered in `docs/SPEC.md` (US-AF10–AF13, US-OP01–OP02, US-A68 + a Phase-2 feature entry + a new
  **Operator (Cajero de turno)** actor/glossary line).
```
