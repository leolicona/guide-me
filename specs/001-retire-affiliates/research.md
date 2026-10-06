# Research: Retire affiliates and affiliate shift operators

The plan's decisions (D1–D13) rest on these findings. Each was read on 2026-10-06.

## R1 — What the databases hold

Read-only aggregate queries against `guideme-db-prod` and `guideme-db` (the numbers are in the
spec's table). The ones that shape a decision:

- prod: 1 user with role `affiliate`, **active**, with 1 sale, MXN 360.00 collected in cash and 1
  cash drop → D3 (refuse the role), D5 (keep the balance visible), D6 (keep the seller in the report).
- prod: 5 `affiliate_commissions` rows → D7 (they block a service hard-delete).
- prod: 0 org policies and 0 sale snapshots containing `affiliate_commission_pct` → D8.
- prod: 0 operators and 0 operator-stamped rows; dev: 1 operator, 1 sale, 1 payment, 2 events → D4,
  D9 (the field goes; the dev rows render as the seller's own).

**Decision**: retire the code, keep the data. **Alternatives considered**: a data migration
suspending the legacy user (`UPDATE users SET status='suspended'`) — rejected: it changes rows
(SC-004) and makes a retirement indistinguishable from an admin's suspension; the role check in D3
reaches the same outcome without writing.

## R2 — Foreign keys on rows the code no longer writes

`affiliate_commissions.service_id`, `affiliate_operators.manager_id`,
`affiliate_invitations.invited_by` reference `services` and `users` with `ON DELETE no action`, and
D1 enforces foreign keys. No code path hard-deletes a user. A service hard-delete exists
(`routes/services/handler.ts`, US-A58) and already removes the commission rows first; dropping that
statement would turn every delete of a service with a legacy row into a constraint error → D7.

The child columns (`folios.operator_id`, `folios.affiliate_company_id`, `users.affiliate_company_id`,
`folio_payments.operator_id`, `folio_events.operator_id`) are nullable; SQLite does not check a
foreign key whose child value is `NULL`, so unmapping them (D2) leaves every insert valid.

## R3 — Old ladder documents

`cancellationPolicySchema` is a non-strict `z.object`; Zod strips unknown keys on parse. The engine
already depends on this for the retired `booking_deposit_retained_pct` (engine D20, comment in
`utils/cancellationPolicy.ts`). Removing `affiliate_commission_pct` therefore needs no document
rewrite → D8.

## R4 — What dropping the data later will take

- The four tables can be dropped once no non-null child key references them: with foreign keys
  enforced, `DROP TABLE` on a parent runs an implicit delete that fails while a child row points at
  it (prod: 1 folio carries an `affiliate_company_id`, which must be nulled first).
- The six columns each carry a `REFERENCES` clause; SQLite's `ALTER TABLE … DROP COLUMN` refuses a
  column used in a foreign key, so each needs the twelve-step table rebuild — on `folios`,
  `folio_payments` and `folio_events`, the ledger tables. That cost is why the drop is its own
  change, recorded as debt `affiliate-tables` rather than done here (D1).

## R5 — Where authentication can refuse a role

`authMiddleware` resolves every authenticated request to a `users` row (`buildUserPayload`) and
already refuses `status = 'suspended'` with `403 ACCOUNT_SUSPENDED` after clearing the cookies. The
login handler checks the password through Agnostic Auth and never reads the role. Refusing in the
middleware covers every route, including `/api/me`, with code the app already handles → D3.

**Alternatives considered**: refusing at `/api/auth/login` as well — rejected as a second place to
keep in sync; a login that succeeds and is refused on the next call is today's suspended-agent
behaviour.

## R6 — The app's mirror

The app compiles with `noUnusedLocals`, so every removed field surfaces as a compile error at its
consumer; the MSW fixtures are partly untyped, so they are edited by reading, not by the compiler.
No e2e journey touches affiliates or operators.
