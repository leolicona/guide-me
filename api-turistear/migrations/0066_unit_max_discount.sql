-- US-A92 (docs/pos/discount-min-price.spec.md, D2). A unit type's discount ceiling, as a whole
-- percent of the SERVER-QUOTED stay total. Relative rather than absolute: the total is assembled
-- per night from seasonal > weekend > base, times rooms, plus the extra-person surcharge over an
-- even guest split (utils/lodging.ts quoteStay). An absolute per-night floor would need a second
-- engine to resolve the same precedence, and would drift from the first one silently.
--
-- DEFAULT 0 IS the backfill (D2): every existing row — prod's live org included — keeps today's
-- behaviour, which is "the quoted total or nothing". No UPDATE, nothing to make idempotent.
ALTER TABLE accommodation_unit_types ADD COLUMN max_discount_pct INTEGER NOT NULL DEFAULT 0;
