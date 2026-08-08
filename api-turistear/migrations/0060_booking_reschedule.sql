-- US-AG52 / US-A87 / US-T09 — reagendar mientras el lugar es tuyo
-- (docs/bookings/booking-reschedule.spec.md; supersedes US-AG07.5).
--
-- 1. THE REQUESTS TABLE STOPS BEING ABOUT CANCELLATIONS ONLY (D13)
--
-- Renamed rather than duplicated. A parallel `folio_reschedules` was the first draft, and the
-- decisive argument against it is an invariant this table already enforces and a second table
-- cannot: `uq_cancellation_requests_open` is UNIQUE (folio_id) WHERE status = 'pending' — exactly
-- ONE open petition per folio. With two tables a folio could carry a pending cancellation AND a
-- pending reschedule at once: two petitions that contradict each other, with nothing preventing it.
--
-- The rename is not cosmetic: a table called `cancellation_requests` holding reschedules is the
-- index-rot this repo has already paid for once.
ALTER TABLE cancellation_requests RENAME TO folio_requests;

-- DEFAULT 'cancellation' so every existing row keeps its meaning without a data migration.
ALTER TABLE folio_requests ADD COLUMN kind TEXT NOT NULL DEFAULT 'cancellation';

-- Reschedule-only. Null on a cancellation — the honest shape: these are not two tables' worth of
-- difference, they are one table with one branch.
ALTER TABLE folio_requests ADD COLUMN folio_line_id TEXT REFERENCES folio_lines(id);
ALTER TABLE folio_requests ADD COLUMN from_slot_id  TEXT REFERENCES slots(id);
ALTER TABLE folio_requests ADD COLUMN to_slot_id    TEXT REFERENCES slots(id);

-- The invariant that decided the reuse, re-created under the table's new name. It now says
-- something STRONGER than it did: one open petition per folio, OF ANY KIND.
DROP INDEX uq_cancellation_requests_open;
CREATE UNIQUE INDEX uq_folio_requests_open ON folio_requests (folio_id) WHERE status = 'pending';

-- 2. THE CREDIT A CLOSED APARTADO LEAVES (D6/D10)
--
-- What the ladder does NOT retain, held on the folio instead of paid out as cash: the close is
-- produced by a clock, so there is nobody present to hand cash to, and a refund obligation would
-- create a debt with a PIN nobody asked for.
--
-- SNAPSHOTTED at the close. Re-deriving it later gives a different answer, because the ladder is
-- time-based and the clock has moved. Zero for every organization on the inherited default, whose
-- terminal tier retains 100% (US-A76) — this feature makes that knob usable, not more generous.
ALTER TABLE folios ADD COLUMN credit_amount INTEGER NOT NULL DEFAULT 0;
ALTER TABLE folios ADD COLUMN credit_expires_at INTEGER;

-- How long the operator carries that liability. Its OWN column: an accounting horizon, not one of
-- the four departure clocks, and nothing about a departure should move it. A perpetual credit is an
-- unbounded liability on the books.
ALTER TABLE organizations ADD COLUMN booking_credit_valid_days INTEGER NOT NULL DEFAULT 90;
