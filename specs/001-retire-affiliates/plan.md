# Implementation Plan: Retire affiliates and affiliate shift operators

**Branch**: `feat/retire-affiliates` | **Date**: 2026-10-06 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/001-retire-affiliates/spec.md`

## Summary

Remove the affiliate role and its shift operators from both workspaces: unmount five routers'
worth of endpoints, drop the `affiliate` role and the `gm_op` session from authentication, take the
affiliate branches out of selling, cash, reports, cancellation and the sale reads, and delete the
app's affiliate and operator screens with their mirror. The data stays in D1, unmapped (D1, D2);
the money it already recorded stays readable and settleable (D5–D7).

Code cites these decisions as `retire-affiliates D<n>`.

## Decisions

**D1 — Code only; no migration.** The four tables and six columns stay in D1.
*Why*: a migration runs before the code it ships with and must stay compatible with the code
already deployed (constitution, Additional constraints). A `DROP` would break the running Worker
for the window between the migration and the deploy, and cannot be undone. Dropping is registered
as debt `affiliate-tables` (see [research.md](./research.md) R4 for why the six columns need a table
rebuild and are likely to stay forever).

**D2 — Drizzle stops mapping the retired tables and columns**: `affiliate_companies`,
`affiliate_commissions`, `affiliate_invitations`, `affiliate_operators`; `users.affiliate_company_id`,
`users.position`, `folios.affiliate_company_id`, `folios.operator_id`, `folio_payments.operator_id`,
`folio_events.operator_id`. A comment in `src/db/schema.ts` names them.
*Why*: an unmapped column cannot be read or written by accident. All six columns are nullable, so
every insert leaves them `NULL`, and SQLite checks no foreign key on a `NULL` child key.

**D3 — A stored role other than `admin`/`agent` is refused in `authMiddleware` with the existing
`403 ACCOUNT_SUSPENDED`, cookies cleared.**
*Why*: every authenticated route passes through that one function, and the app already handles the
code (a suspended agent meets it today). No new error code, nothing new to mirror. The password
check at login belongs to Agnostic Auth and knows no roles, so login still answers `200`; the very
next request is refused — exactly the suspended-agent path.

**D4 — `gm_op` is neither read nor cleared.**
*Why*: prod has 0 operators and dev 1; the cookie is HttpOnly with a 24-hour max-age, so any stray
one is gone within a day. Clearing it on every login and logout would keep a retired name in the
code indefinitely.

**D5 — The cash roster, payouts and direct collections target every non-admin user of the org
(`role != 'admin'`), instead of naming roles.**
*Why*: Money law (constitution II). Prod's one affiliate user collected MXN 360.00 in cash and has a
drop on file. Naming only `agent` would hide that balance from the admin with no way to settle it.
`role != 'admin'` names no retired role and is exactly today's set.

**D6 — The commission report keeps every seller with activity; a seller's role is the stored value;
the CSV labels an unknown role with that value; the affiliate company column and filter go.**
*Why*: the report is a reading of the ledger. Dropping a seller would make its totals disagree with
the cash. Labelling the legacy seller "Agente" would be false; the stored value is the truth.

**D7 — Hard-deleting an unsold service keeps deleting legacy `affiliate_commissions` rows, through
a two-column mapping local to `routes/services/handler.ts`.**
*Why*: prod holds 5 such rows referencing services with `ON DELETE no action`, and D1 enforces
foreign keys, so without it those services could never be hard-deleted. The table is unmapped from
the schema (D2); a local mapping keeps the delete inside the hard-delete's atomic batch, which
Drizzle's D1 driver does not allow for a raw `db.run(sql…)` (learned in build: it fails at
`batch`). The mapping leaves with the table (debt `affiliate-tables`).

**D8 — The cancellation ladder drops `affiliate_commission_pct`; the engine drops `sellerKind`.**
*Why*: 0 org policies and 0 sale snapshots in prod carry the key, and Zod strips unknown keys on a
non-strict object, so an old document still parses (the same mechanism D20 of the engine relies on).
For the one legacy affiliate sale, `affiliate_commission_pct ?? agent_commission_pct` already
resolved to the agent share — pricing is unchanged.

**D9 — Every response sheds its affiliate and operator fields in the same pull request as the app's
mirror**: `operator_name` (sale response, list rows, detail, payments, timeline events, dashboard
collections), `operator` (`/api/me`), `affiliateCompanyId` (the session user),
`invitation_type`/`company_name` (invitation lookup), `role`/`affiliate_company` (cash balances),
`affiliate_company` (commission report).
*Why*: the mirror is held by discipline until a contracts package exists (constitution IV). A field
nobody produces is a fiction in a fixture.

**D10 — Sale search loses its operator arm on the server and on the client together.**
*Why*: the archived folio-list-search D3 — one search, one answer, whatever was loaded.

**D11 — Retired routers are unmounted, not tombstoned.**
*Why*: the app's screens leave in the same pull request, so no client remains; Hono's not-found
answers. A tombstone is code kept for a feature that is gone.

**D12 — Shared primitives stay.** `WizardShell`'s comments name the affiliate wizard as its
consumer, but that wizard rendered through `WizardPage`; the Dialog host had no consumer before this
change either. Constitution VII names it as the multi-step host, so removing it is a design-system
decision, not this one — only its comments change. Server helpers that existed only for operators
(`utils/phone.ts`, `utils/pin.ts`, `utils/operatorSession.ts`) are deleted; the app's
`normalizePhone` serves the POS too and stays.

**D13 — Tests follow the behaviour.** The three affiliate and operator suites are deleted — what
they prove no longer exists. Partial suites lose their affiliate cases. A new suite,
`api-turistear/test/retire-affiliates/retire-affiliates.test.ts`, proves the retirement against
legacy rows seeded in raw SQL: retired routes answer 404 (US1), the legacy role is refused and an
operator cookie is ignored (US2), a legacy seller stays in the roster, the report and the CSV and
can be collected from, and a legacy commission row does not block a service delete (US3).

## Technical Context

**Language/Version**: TypeScript (ESM), Node 22

**Primary Dependencies**: Hono 4, Drizzle ORM, Zod 4 (API); React 19, MUI 9, TanStack Query 5,
React Router 7 (app)

**Storage**: Cloudflare D1 — unchanged; no migration (D1)

**Testing**: Vitest 4 with `@cloudflare/vitest-pool-workers` (API); jsdom + Testing Library + MSW
(app)

**Target Platform**: Cloudflare Workers (both)

**Project Type**: web service + web app (pnpm workspace)

**Performance Goals**: no regression; the sale list, detail, payments, timeline and dashboard each
lose one left join

**Constraints**: zero rows changed in either database (SC-004); the suites named in the spec's
scope boundary pass unedited

**Scale/Scope**: ~45 API files and ~60 app files touched or deleted

## Constitution Check

| Principle | Gate | Result |
| --- | --- | --- |
| I. Spec-driven, cited | Spec, plan and tasks under `specs/001-retire-affiliates/`; decisions numbered; scope boundary as a mechanical test | PASS |
| II. Money law | No ledger row changes; legacy cash stays visible and settleable (D5); report keeps every seller (D6); a legacy sale cancels with the same share (D8) | PASS |
| III. Tenant isolation | Routes are removed, none added; every surviving query keeps its org filter; the new suite's cross-org check rides `seedTwoOrgs` | PASS |
| IV. The server decides | Role refusal in the API (D3); the app's mirror changes with each response (D9); MSW handlers follow | PASS |
| V. Capacity guarded by the DB | Untouched | PASS |
| VI. Proven where enforced | Retirement proven in API tests (D13); app tests lose operator and affiliate cases only | PASS |
| VII. Elegant Field Minimalism | No token or primitive changes (D12); copy loses "Afiliado"/"Vendido por" | PASS |
| VIII. Services we do not own | The affiliate invitation email leaves `services/resend.ts`; no new integration | PASS |

The constitution itself names the affiliate and operator roles (preamble, III, IV, the Auth row of
the stack table). It is amended in this pull request through `/speckit-constitution`, as Governance
requires.

## Project Structure

### Documentation (this feature)

```text
specs/001-retire-affiliates/
├── spec.md
├── plan.md              # this file
├── research.md          # the measurements and the alternatives behind D1–D13
├── data-model.md        # what stays in D1, unmapped
├── contracts/
│   └── api-changes.md   # removed endpoints and changed response shapes
├── quickstart.md        # how to validate
├── checklists/
│   └── requirements.md
└── tasks.md
```

### Source Code (repository root)

```text
api-turistear/
├── src/
│   ├── index.tsx                     # unmount affiliates + operators routers; /api/me
│   ├── db/schema.ts                  # D2
│   ├── middleware/auth.ts            # D3, D4
│   ├── types/context.ts              # roles, no OperatorPayload
│   ├── routes/affiliates/            # deleted
│   ├── routes/operators/             # deleted
│   ├── routes/{auth,cash,dashboard,folios,pos,reports,services}/
│   ├── services/resend.ts            # affiliate invitation email removed
│   └── utils/{cookies,cancellationPolicy,folioDetail,folioEvents,folioListRows,
│               folioPayments,folioSearch}.ts; {operatorSession,phone,pin}.ts deleted
└── test/
    ├── affiliates/, operators/       # deleted
    ├── retire-affiliates/            # new (D13)
    └── helpers/tenancy.ts            # affiliate seeders removed; clearAffiliateDb → clearFullDb

app-turistear/src/
├── App.tsx, config/routes.ts, layout/{AppLayout,AccountMenu}.tsx
├── features/affiliates/, features/operators/          # deleted
├── pages/{Affiliate*,Operators,OperatorAccess}Page.tsx # deleted
├── features/{auth,cash,folios,organization,reports,dashboard,pos}/
├── services/{affiliates,operators}Service.ts          # deleted
└── test/handlers/                                      # MSW mirror
```

**Structure Decision**: the existing two-workspace layout; nothing new besides the API test suite.

## Complexity Tracking

No violation to justify.
