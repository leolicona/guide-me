# Quickstart: validate the retirement

## Prerequisites

`pnpm install --frozen-lockfile` at the repository root.

## The gates (what `verify` runs)

```bash
pnpm lint:app
pnpm test:app
pnpm test:api
pnpm build:api
pnpm build:app
```

All five pass. The suites listed under the spec's *Scope boundary* pass with no edit in the diff:

```bash
git diff --stat origin/develop -- \
  api-turistear/test/auth/admin-registration.test.ts api-turistear/test/auth/agent-invitation.test.ts \
  api-turistear/test/auth/password-recovery.test.ts api-turistear/test/cash/advanced-cash-collection.test.ts \
  api-turistear/test/cash/agent-balance-cash-drops.test.ts api-turistear/test/cash/agent-balance-ux-overhaul.test.ts \
  api-turistear/test/folios/folio-cancellation.test.ts api-turistear/test/folios/folio-list-search.test.ts \
  api-turistear/test/folios/folio-surface-parity.test.ts api-turistear/test/folios/line-cancellation.test.ts \
  api-turistear/test/folios/line-settle.test.ts api-turistear/test/commissions/service-based-commission.test.ts \
  api-turistear/test/multitenancy/multitenancy.test.ts
# → no output
```

## The retirement itself

```bash
pnpm --filter api-turistear exec vitest run test/retire-affiliates
```

Proves, against legacy rows seeded in raw SQL: the retired addresses answer 404 (US1); a legacy
`affiliate` user is refused `403 ACCOUNT_SUSPENDED` and an operator cookie opens nothing (US2); the
legacy seller stays in the cash roster, the commission report and its CSV, and can be collected
from; a legacy commission row does not block deleting an unsold service (US3).

## SC-001 — what is left of the concepts

```bash
grep -rniE "affiliat|afiliad|gm_op|operator_?name|operatorId|shift operator" \
  api-turistear/src app-turistear/src --include=*.ts --include=*.tsx | grep -v "\.test\."
```

Only the retirement's own lines remain: the D2 schema note, the D3 refusal, the D7 cleanup and the
D6/D8 comments.

## SC-004 — nothing written

The change ships no file under `api-turistear/migrations/`:

```bash
git diff --name-only origin/develop -- api-turistear/migrations   # → no output
```
