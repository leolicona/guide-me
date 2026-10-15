-- passkey-auth — specs/004-passkey-auth/data-model.md, plan D4 and D16.
--
-- Better Auth 1.7.7's standard schema on D1, in snake_case (Drizzle maps each column to the field
-- name Better Auth addresses). Additive only: the code this deploy replaces ignores all of it.
--
-- Tenant scope (constitution III). No table here carries `organization_id`:
--   sessions, accounts, passkeys — each row belongs to one user, so it is scoped transitively
--     through `user_id → users.organization_id`, and goes with the user (ON DELETE CASCADE).
--   verifications — keyed by a globally unique identifier (`sign-in-otp-<email>`, or an opaque
--     passkey-challenge token), exempt like `users.email` is.
--   rate_limits — keyed by `<ip>|<path>`, exempt for the same reason.
--
-- Timestamps are epoch seconds, like every other table, except `rate_limits.last_request`, which
-- Better Auth keeps in milliseconds. IDs are UUIDs (`advanced.database.generateId: 'uuid'`).
--
-- D15 — `users.password_hash`, `users.password_salt` and `password_reset_tokens` are NOT touched:
-- the code being replaced still reads them. The deploy after cutover drops them (debt
-- `password-material`).

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX sessions_user_id_idx ON sessions(user_id);

-- Required by Better Auth's schema. Neither email codes nor passkeys write it, so it stays empty.
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  access_token TEXT,
  refresh_token TEXT,
  id_token TEXT,
  access_token_expires_at INTEGER,
  refresh_token_expires_at INTEGER,
  scope TEXT,
  password TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX accounts_user_id_idx ON accounts(user_id);

-- Sign-in codes (value = `<encrypted code>:<attempts>`, FR-016) and passkey challenges.
CREATE TABLE verifications (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX verifications_identifier_idx ON verifications(identifier);

CREATE TABLE passkeys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT,
  credential_id TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL,
  device_type TEXT NOT NULL,
  backed_up INTEGER NOT NULL,
  transports TEXT,
  aaguid TEXT,
  created_at INTEGER
);
CREATE INDEX passkeys_user_id_idx ON passkeys(user_id);

CREATE TABLE rate_limits (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  count INTEGER NOT NULL,
  last_request INTEGER NOT NULL
);

-- Better Auth's `emailVerified` and `image`. `image` is required by the model and never written.
ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN image TEXT;

-- An active account already proved its address (the old magic link); an `unverified` one proves
-- it with its first email code (FR-015).
UPDATE users SET email_verified = 1 WHERE status = 'active';

-- R11 — Better Auth lowercases every email before it looks one up, while these rows store the
-- address as typed. Two addresses differing only in case fail the unique index here, before any
-- code ships; the pre-merge gate (D19) counts them first.
UPDATE users SET email = lower(email) WHERE email <> lower(email);
UPDATE invitations SET identity = lower(identity) WHERE identity <> lower(identity);
