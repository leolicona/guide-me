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
`0071_better_auth.sql` could not drop them. They are unread instead: Drizzle maps neither
`password_reset_tokens` nor `users.password_hash`/`password_salt`, and a new user is inserted so
that it works on both sides of the drop (2026-10-15, below).

## Where it lives

- The columns `users.password_hash`, `users.password_salt` (`NOT NULL`, from
  `api-turistear/migrations/0002_create_users.sql`) and the table `password_reset_tokens` (from
  `0004_create_password_reset_tokens.sql`), in `guideme-db` (dev) and `guideme-db-prod` (prod).
  Rows created before cutover still hold their Agnostic Auth hashes and salts.
- `api-turistear/src/db/schema.ts::users` — the comment "passkey-auth D15 — `password_hash` and
  `password_salt` are deliberately NOT mapped", and the note "passkey-auth D15 —
  `password_reset_tokens` (and `users.password_hash`/`password_salt`) are no longer mapped or read".
- `api-turistear/src/routes/onboarding/handler.ts` — `usersWithPasswordColumns` (an insert-only
  view of `users` that writes `''` into both columns), `insertUser`, `passwordColumnsDropped` and
  `acrossTheDrop`: `register` and `acceptInvitation` insert with the columns, and once they are gone
  the same rows through `users`.
- `api-turistear/test/auth/password-material.test.ts` — drops the columns and the table from its own
  database and proves registration, invitations, both sign-ins, Better Auth's `update-user` and the
  agent list work without them.
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
- Every insert into `users` (the onboarding fallback, fixtures, the local seed, any future backfill)
  must still supply the two `NOT NULL` columns.
- Readers of the onboarding handler have to know that its fallback is temporary.

## Paying it

In two steps, because a migration runs before the code it ships with and must be backward-compatible
with the code already deployed (constitution, Additional constraints; D15, quickstart § 6):

1. **Done 2026-10-15** — the code stops depending on the material: `users` maps neither column, and
   a new user is insertable before and after the drop (Where it lives). Until this was deployed,
   dropping the columns would have broken registration and invitations on dev from the moment the
   drop's preview applied it, and on prod between its migration and its API deploy.
2. **The drop** — once step 1 is live in prod: migration `0072` (or the next free number) with
   `DROP TABLE password_reset_tokens` (a child of `users`, so dropping it first is safe),
   `ALTER TABLE users DROP COLUMN password_hash` and `ALTER TABLE users DROP COLUMN password_salt`.
   The same change:
   - deletes `usersWithPasswordColumns`, `insertUser`, `passwordColumnsDropped` and `acrossTheDrop`
     from `routes/onboarding/handler.ts`, so `register` and `acceptInvitation` insert through
     `users` again;
   - deletes `test/auth/password-material.test.ts`, which would fail on columns already gone (the
     whole suite then runs without them);
   - removes the columns from `seedUser` and `seed-local.mjs`, the table from the `clearFullDb`
     list, and the D15 comments from `src/db/schema.ts`;
   - decides how `delete-legacy-affiliates.test.ts`, which replays migration 0070's SQL and so
     deletes from `password_reset_tokens`, handles the dropped table.

Confirm on each environment:

```bash
pnpm --filter api-turistear exec wrangler d1 execute guideme-db --env dev --remote --command \
  "SELECT name FROM pragma_table_info('users') WHERE name LIKE 'password%' UNION ALL SELECT name FROM sqlite_master WHERE name = 'password_reset_tokens';"
pnpm --filter api-turistear exec wrangler d1 execute guideme-db-prod --env production --remote --command \
  "SELECT name FROM pragma_table_info('users') WHERE name LIKE 'password%' UNION ALL SELECT name FROM sqlite_master WHERE name = 'password_reset_tokens';"
```

Expected: no rows. On the tree: `git grep -nE "password_hash|password_salt|password_reset_tokens|passwordHash|passwordSalt" -- api-turistear/src api-turistear/test api-turistear/scripts`
finds nothing outside the migrations.

**Trigger**: a prod release (a `v*` tag) that carries step 1 has deployed green — from then on no
deployed code depends on the material, and every day it stays is password data kept for nothing.

## Notes

- Same path as `affiliate-tables` (`specs/001-retire-affiliates` → `specs/002-drop-affiliate-tables`).
- 2026-10-15: what a drop breaks first is a new user. An insert that names a dropped column fails
  (`table users has no column named password_hash`), and D1 rolls the whole batch back. A read does
  not fail: SQLite takes a double-quoted name it cannot resolve for a string literal, so a mapped
  but dropped column reads back as the text `'password_hash'`. The cutover's code (merge commit
  968dfd0) still inserted through the mapped columns, so it could not run against the drop; step 1
  is what can.
- Spec: `specs/004-passkey-auth/spec.md` FR-060, FR-061, SC-006; plan D15; quickstart § 6.
