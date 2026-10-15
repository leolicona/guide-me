---
slug: password-material
status: open
kind: deliberate
severity: low
effort: hours
opened: 2026-10-15
---

# Technical Debt: password columns and reset tokens still live in D1 after the passkey cutover

## What was traded

`specs/004-passkey-auth` replaced every password flow with Better Auth's email code and passkeys,
but left the password material in D1 on purpose (plan D15, FR-061): "a migration runs before the
code it ships with, and the code being replaced still reads them", so migration
`0071_better_auth.sql` could not drop them. They are unread instead: Drizzle no longer maps
`password_reset_tokens`, and keeps `users.password_hash`/`password_salt` only so inserts can write
`''` into the `NOT NULL` columns.

## Where it lives

- The columns `users.password_hash`, `users.password_salt` (`NOT NULL`, from
  `api-turistear/migrations/0002_create_users.sql`) and the table `password_reset_tokens` (from
  `0004_create_password_reset_tokens.sql`), in `guideme-db` (dev) and `guideme-db-prod` (prod).
  Rows created before cutover still hold their Agnostic Auth hashes and salts.
- `api-turistear/src/db/schema.ts::users` — `passwordHash` and `passwordSalt`, mapped with
  `.$defaultFn(() => '')` and the comment "passkey-auth D15 — no longer read; dropped by the deploy
  after cutover (debt `password-material`)". The default also satisfies Better Auth's schema check,
  which refuses a `NOT NULL` column it never writes unless it has a default.
- `api-turistear/src/db/schema.ts` — the note "passkey-auth D15 — `password_reset_tokens` (and
  `users.password_hash`/`password_salt`) are no longer mapped or read".
- `api-turistear/migrations/0071_better_auth.sql` — header: "D15 — `users.password_hash`,
  `users.password_salt` and `password_reset_tokens` are NOT touched".
- Writers that name the columns or the table in raw SQL:
  - `api-turistear/test/helpers/tenancy.ts::seedUser` — inserts `'STORED_HASH'`, `'STORED_SALT'`;
  - `api-turistear/test/helpers/tenancy.ts` — `'password_reset_tokens'` in the cleanup table list;
  - `api-turistear/test/retire-affiliates/delete-legacy-affiliates.test.ts` — seeds
    `password_hash: 'H'`, `password_salt: 'S'` and a `password_reset_tokens` row, and lists the
    table in its dumps;
  - `api-turistear/scripts/seed-local.mjs` — writes `''` into both columns.

## Interest

- Pre-cutover password hashes and salts stay at rest in both databases although nothing can use
  them; SC-006 ("no password material remains") stays unmet until they go.
- Every raw-SQL insert into `users` (fixtures, the local seed, any future backfill) must still
  supply or default the two `NOT NULL` columns.
- Readers of the schema have to know that two mapped columns and one table are dead.

## Paying it

The next PR after cutover reaches prod (D15; quickstart § 6): migration `0072` (or the next free
number) with `ALTER TABLE users DROP COLUMN password_hash`, `ALTER TABLE users DROP COLUMN
password_salt` and `DROP TABLE password_reset_tokens` (a child of `users`, so dropping it first is
safe). The same change removes `passwordHash`/`passwordSalt` and the D15 note from
`src/db/schema.ts`, the columns from `seedUser` and `seed-local.mjs`, and the table from the
tenancy cleanup list. `delete-legacy-affiliates.test.ts` replays migration 0070's SQL, which
deletes from `password_reset_tokens`; that suite's handling of the dropped table has to be decided
in the same change.

Confirm on each environment:

```bash
pnpm --filter api-turistear exec wrangler d1 execute guideme-db --env dev --remote --command \
  "SELECT name FROM pragma_table_info('users') WHERE name LIKE 'password%' UNION ALL SELECT name FROM sqlite_master WHERE name = 'password_reset_tokens';"
pnpm --filter api-turistear exec wrangler d1 execute guideme-db-prod --env production --remote --command \
  "SELECT name FROM pragma_table_info('users') WHERE name LIKE 'password%' UNION ALL SELECT name FROM sqlite_master WHERE name = 'password_reset_tokens';"
```

Expected: no rows. On the tree: `git grep -nE "password_hash|password_salt|password_reset_tokens|passwordHash|passwordSalt" -- api-turistear/src api-turistear/test api-turistear/scripts`
finds nothing outside the migrations.

**Trigger**: the passkey-auth cutover (`specs/004-passkey-auth`) is live in prod — from then on no
deployed code reads the material, and every day it stays is password data kept for nothing.

## Notes

- Same path as `affiliate-tables` (`specs/001-retire-affiliates` → `specs/002-drop-affiliate-tables`).
- Spec: `specs/004-passkey-auth/spec.md` FR-060, FR-061, SC-006; plan D15; quickstart § 6.
