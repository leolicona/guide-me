-- US-A66 (docs/timezone/spec.md) — the organization's single IANA time zone. All wall-clock
-- scheduling (catalog "today", sale cutoff / same-day grace, booking + ticket expiry) and
-- audit-timestamp display resolve against it, closing BUG-007 (naive-UTC comparison). The NOT NULL
-- default backfills every existing org to America/Mexico_City (D4) — the app is entirely es-MX.
ALTER TABLE organizations ADD COLUMN timezone TEXT NOT NULL DEFAULT 'America/Mexico_City';
