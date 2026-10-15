# Data Model: Passkey Sign-In with Email Code Backup

**Plan**: [plan.md](./plan.md) · **Migration**: `api-turistear/migrations/0071_better_auth.sql` (D16)

This is Better Auth 1.7.7's standard schema, mapped onto D1 in snake_case through `modelName` and
`fields`. No column is ours beyond Better Auth's.

**Scope (constitution III)**:
- Every child table belongs to a user. It is scoped transitively through
  `user_id → users.organization_id`, and the migration says so in a comment.
- `verifications` and `rate_limits` are keyed by globally unique values (an email or a token; an IP
  and a path), so they are exempt from organization filtering, as `users.email` is.

**Timestamps and IDs**:
- Timestamps are epoch **seconds** (Drizzle `mode: 'timestamp'`), except
  `rate_limits.last_request`, which Better Auth stores in milliseconds.
- IDs are UUIDs (`advanced.database.generateId: 'uuid'`).

## users (existing; changed) — Better Auth `user`

| Column | Better Auth field | Change | Notes |
|---|---|---|---|
| `id`, `name`, `email`, `created_at`, `updated_at` | core fields | `email` is **lowercased** by the migration | R11 |
| `email_verified` | `emailVerified` | **new**, INTEGER (bool) NOT NULL DEFAULT 0 | Backfilled to 1 where `status = 'active'`. Set by an email-code sign-in |
| `image` | `image` | **new**, TEXT NULL | Required by the model; never written |
| `organization_id`, `role`, `status`, `phone`, `plan` | `additionalFields`, `input: false` | unchanged | Never writable through `/api/auth/*` (D2) |
| `password_hash`, `password_salt` | not mapped for Better Auth | no longer read; inserts write `''` | Dropped by the follow-up (D15) |

**`status` lifecycle**:
- `unverified` → `active` on the first email-code sign-in (D6 hook).
- `active` ↔ `suspended` is unchanged (agent deactivate and reactivate).
- A `suspended` user cannot get a session (D6).

`password_reset_tokens` is no longer mapped. It is dropped by the follow-up.

## sessions (new) — Better Auth `session`

| Column | Notes |
|---|---|
| `id` | TEXT PK |
| `user_id` | → `users(id)` ON DELETE CASCADE, indexed |
| `token` | TEXT NOT NULL UNIQUE; carried signed in `__Secure-<prefix>.session_token` |
| `expires_at` | 7 days after the last renewal |
| `ip_address`, `user_agent` | Written by Better Auth |
| `created_at`, `updated_at` | `created_at` drives the fresh-session rule (1 day) |

**Lifecycle**:
- **Created** by a sign-in, either email code or passkey.
- **Renewed** by a request more than 1 day after the last update. `expires_at` moves; `token` does
  not.
- **Deleted** by `/sign-out`, `/revoke-sessions` or `/revoke-session`.
- **Refused** once `expires_at` has passed.

## accounts (new; always empty) — Better Auth `account`

`id`, `user_id` (→ `users` ON DELETE CASCADE, indexed), `account_id`, `provider_id`,
`access_token`, `refresh_token`, `id_token`, `access_token_expires_at`, `refresh_token_expires_at`,
`scope`, `password`, `created_at`, `updated_at`.

Neither email codes nor passkeys write it; Better Auth's schema requires it.

## verifications (new) — Better Auth `verification`

| Column | Notes |
|---|---|
| `id` | TEXT PK |
| `identifier` | indexed. For a code: `sign-in-otp-<email>`. For a passkey challenge: an opaque token, carried in a signed cookie |
| `value` | For a code: `<encrypted code>:<attempts>`. For a challenge: the ceremony JSON |
| `expires_at` | Codes: +300 s. Challenges: +300 s |
| `created_at`, `updated_at` | The newest row per identifier wins |

**Code rules**:
- 6 digits, 5 minutes, single use.
- 3 wrong attempts, then `TOO_MANY_ATTEMPTS`.
- A newer code supersedes the older one.
- Stored encrypted with the environment secret (FR-016).

## passkeys (new) — `@better-auth/passkey` `passkey`

| Column | Notes |
|---|---|
| `id` | TEXT PK |
| `user_id` | → `users(id)` ON DELETE CASCADE, indexed |
| `name` | TEXT NULL; user-editable |
| `credential_id` | TEXT NOT NULL UNIQUE |
| `public_key` | TEXT NOT NULL |
| `counter` | INTEGER NOT NULL; the use count. Going backwards fails verification |
| `device_type` | `singleDevice` · `multiDevice` |
| `backed_up` | INTEGER (bool) NOT NULL; whether the passkey is synced |
| `transports` | TEXT NULL |
| `aaguid` | TEXT NULL |
| `created_at` | INTEGER NULL |

There is no per-account limit. Any passkey can be deleted by its owner.

## rate_limits (new) — Better Auth `rateLimit`

| Column | Notes |
|---|---|
| `id` | TEXT PK |
| `key` | TEXT NOT NULL UNIQUE (`<ip>|<path>`) |
| `count` | INTEGER NOT NULL |
| `last_request` | INTEGER NOT NULL, epoch **milliseconds** |

## Migration 0071 checklist (D16)

- **Number**: the next free one at implementation time (0071 today).
- **Additive**: only `CREATE TABLE`, `CREATE INDEX` and `ALTER TABLE … ADD COLUMN` with defaults.
  Code already deployed ignores all of it.
- **Data updates**:
  - `UPDATE users SET email = lower(email)`
  - `UPDATE invitations SET identity = lower(identity)`
  - `UPDATE users SET email_verified = 1 WHERE status = 'active'`
- **Scoping comment**: it states the transitive scope of each child table.
- **Not touched**: `password_hash`, `password_salt` and `password_reset_tokens`. They go in the
  follow-up (D15).
