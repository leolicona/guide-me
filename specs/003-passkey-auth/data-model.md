# Data Model: Passkey Sign-In with Email Code Recovery

**Plan**: [plan.md](./plan.md) · **Migration**: `api-turistear/migrations/0070_better_auth.sql` (D17)

Every new table belongs to a user. It is scoped transitively through `user_id → users.organization_id`
(constitution III), and the migration says so in a comment. `verifications` and `auth_rate_limits`
are keyed by a globally unique value (an email, an IP), so they are exempt from organization
filtering, as `users.email` is.

Timestamps are epoch **seconds** (Drizzle `mode: 'timestamp'`), like the rest of the schema. IDs
are UUIDs (`advanced.database.generateId: 'uuid'`).

Better Auth model → table mapping (`modelName` and `fields`, snake_case):

| Better Auth model | Table | Notes |
|---|---|---|
| `user` | `users` (existing) | Extra fields declared as `additionalFields` with `input: false` |
| `session` | `sessions` | |
| `account` | `accounts` | Required by Better Auth's schema; always empty here |
| `verification` | `verifications` | Holds email codes and passkey challenges |
| `passkey` | `passkeys` | Plugin `schema` option, plus our `last_used_at` |
| — | `auth_rate_limits` | Ours (D9) |

## users (existing; changed)

| Column | Type | Change | Notes |
|---|---|---|---|
| `email` | TEXT NOT NULL UNIQUE | **lowercased** by the migration and at every entry point | R11 |
| `email_verified` | INTEGER (bool) NOT NULL DEFAULT 0 | **new** | Backfilled to 1 where `status = 'active'`. Set by an email-code sign-in (FR-015) and by invitation completion |
| `image` | TEXT NULL | **new** | Required by Better Auth's user model; never written |
| `password_hash`, `password_salt` | TEXT NOT NULL | **no longer read**; inserts write `''` | Dropped by the follow-up deploy (D16) |
| `status` | `unverified` · `active` · `suspended` | unchanged | `unverified → active` on the first email-code sign-in |
| `role` | `admin` · `agent` | unchanged | Any other stored value is refused at session creation and in the middleware (`retire-affiliates D3`) |

`password_reset_tokens` is no longer mapped. It is dropped in the follow-up deploy (D16).

## sessions (new)

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | UUID |
| `user_id` | TEXT NOT NULL → `users(id)` ON DELETE CASCADE | indexed |
| `token` | TEXT NOT NULL UNIQUE | 32 random characters; the cookie carries it signed (R4) |
| `expires_at` | INTEGER NOT NULL | `created_at + 60 days`, extended by renewal (`updateAge` 1 day) |
| `ip_address`, `user_agent` | TEXT NULL | Written by Better Auth (`cf-connecting-ip`) |
| `created_at`, `updated_at` | INTEGER NOT NULL | |
| `auth_method` | TEXT NOT NULL: `passkey` · `email_code` · `invitation` | ours; set by the create hook from the endpoint path, or by `issueInvitationSession` |
| `authenticated_at` | INTEGER NOT NULL | ours; the sign-in instant, never moved by renewal (D8) |
| `passkey_required` | INTEGER (bool) NOT NULL DEFAULT 0 | ours; 1 for `email_code` and `invitation` sessions unless the client reported no WebAuthn (FR-007, FR-009) |
| `passkey_unsupported` | INTEGER (bool) NOT NULL DEFAULT 0 | ours; the client's report, kept as evidence (FR-009) |

**Session lifecycle**

```text
created ─┬─ passkey_required = 1 ──(passkey registered)──▶ active
         └─ passkey_required = 0 ─────────────────────────▶ active
active ──(request after updateAge)──▶ active (expires_at extended; token unchanged)
any ──(logout · revoke-all · restore-access · replaced by a re-sign-in)──▶ row deleted
any ──(expires_at passed)──▶ refused (UNAUTHORIZED), row removed
```

The middleware refuses a session whose user is `suspended` or holds a retired role, at every
request (FR-025). A `passkey_required` session reaches only the four enrollment routes (D6).

## accounts (new; always empty)

These columns are Better Auth's `account` model: `id`, `user_id` (→ `users` ON DELETE CASCADE,
indexed), `account_id`, `provider_id`, `access_token`, `refresh_token`, `id_token`,
`access_token_expires_at`, `refresh_token_expires_at`, `scope`, `password`, `created_at` and
`updated_at`.

Neither email codes nor passkeys write it. It exists because Better Auth's schema requires it
(R1, D4).

## verifications (new)

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | |
| `identifier` | TEXT NOT NULL | indexed. For a code: `sign-in-otp-<email>`. For a passkey challenge: an opaque token carried in the signed challenge cookie |
| `value` | TEXT NOT NULL | For a code: `<HMAC of the code>:<attempts>` (D7). For a passkey challenge: the ceremony JSON |
| `expires_at` | INTEGER NOT NULL | Codes: +600 s. Passkey challenges: +300 s |
| `created_at`, `updated_at` | INTEGER NOT NULL | The newest row per identifier wins (R6) |

Rules:
- **Code format**: 6 digits.
- **Expiry**: 10 minutes.
- **Single use**: redeeming deletes every row for the identifier.
- **Attempts**: 5 wrong attempts, then `OTP_ATTEMPTS_EXCEEDED`.
- **Newer code wins**: a new code supersedes the old one.

Expired rows are cleaned by Better Auth on lookup.

## passkeys (new)

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | |
| `user_id` | TEXT NOT NULL → `users(id)` ON DELETE CASCADE | indexed |
| `name` | TEXT NULL | user-editable, 1–60 characters. The app proposes "Este teléfono" or "Llave de seguridad" from `device_type` |
| `credential_id` | TEXT NOT NULL UNIQUE | base64url credential ID |
| `public_key` | TEXT NOT NULL | COSE public key, base64 |
| `counter` | INTEGER NOT NULL | the use count. A non-increasing count, when either side is non-zero, fails verification (R9) |
| `device_type` | TEXT NOT NULL: `singleDevice` · `multiDevice` | SimpleWebAuthn's credential device type |
| `backed_up` | INTEGER (bool) NOT NULL | synced passkey |
| `transports` | TEXT NULL | comma-separated (`internal`, `hybrid`, `usb`, `nfc`, `ble`) |
| `aaguid` | TEXT NULL | authenticator model id; recorded, never restricted (spec Assumptions) |
| `created_at` | INTEGER NULL | |
| `last_used_at` | INTEGER NULL | **ours**; set after each verified sign-in (FR-004) |

Rules:
- **At most 10 per user**: checked before registration options are issued (FR-004).
- **The last one cannot be removed by its owner** (FR-008). The delete is one guarded statement:

  ```sql
  DELETE FROM passkeys
   WHERE id = :id AND user_id = :user
     AND (SELECT COUNT(*) FROM passkeys WHERE user_id = :user) > 1
  RETURNING id
  ```

  No row returned means `PASSKEY_LAST_ONE`, or `NOT_FOUND` when the id is not the user's.
- **Restore**: an admin's restore deletes all of an agent's passkeys (D13).

## auth_rate_limits (new; ours)

| Column | Type | Notes |
|---|---|---|
| `key` | TEXT PK | `otp:min:<email>` · `otp:hour:<email>` · `otp:ip:<ip>` |
| `window_start` | INTEGER NOT NULL | start of the current window (epoch s) |
| `count` | INTEGER NOT NULL | requests in the window |

Each consume is one statement (constitution V):

```sql
INSERT INTO auth_rate_limits (key, window_start, count) VALUES (:key, :now, 1)
ON CONFLICT(key) DO UPDATE SET
  window_start = CASE WHEN excluded.window_start - window_start >= :window THEN excluded.window_start ELSE window_start END,
  count        = CASE WHEN excluded.window_start - window_start >= :window THEN 1 ELSE count + 1 END
WHERE excluded.window_start - window_start >= :window OR count < :limit
RETURNING count
```

No row returned means `429 OTP_RATE_LIMITED`, with
`Retry-After = window_start + window − now`.

The limits are:

| Key | Limit |
|---|---|
| `otp:min:<email>` | 1 per 60 s |
| `otp:hour:<email>` | 5 per 3,600 s |
| `otp:ip:<ip>` | 20 per 3,600 s |

## Migration 0070 checklist (D17)

- **Additive**: only `CREATE TABLE`, `CREATE INDEX` and `ALTER TABLE … ADD COLUMN` with defaults.
  The code that is deployed before cutover ignores all of them.
- **Data updates**: `UPDATE users SET email = lower(email)`,
  `UPDATE invitations SET identity = lower(identity)`, and
  `UPDATE users SET email_verified = 1 WHERE status = 'active'`.
- **Scoping comment**: the migration states the transitive scope of each new table.
- **Not touched**: `password_hash`, `password_salt` and `password_reset_tokens`. They go in the
  follow-up (D16).
