-- specs/002-drop-affiliate-tables — drops what specs/001-retire-affiliates left in D1 (debt
-- affiliate-tables). SUBTRACTIVE: deploy only after 001's code is in production; the code before it
-- writes these columns on every sale (002 D2).
--
-- ORDER IS LOAD-BEARING (001 research R4, measured in build): the child columns go FIRST. A parent
-- table dropped while a child still declares REFERENCES to it makes every INSERT or DELETE on that
-- child fail with "no such table" — even with the key NULL — which would stop every sale. DROP COLUMN
-- accepts these column-level REFERENCES (none is indexed, or named by a view or trigger) and keeps
-- the rest of each row; no table rebuild.

-- The six child columns (0034, 0048, 0049, 0061).
ALTER TABLE folio_events DROP COLUMN operator_id;
ALTER TABLE folio_payments DROP COLUMN operator_id;
ALTER TABLE folios DROP COLUMN operator_id;
ALTER TABLE folios DROP COLUMN affiliate_company_id;
ALTER TABLE users DROP COLUMN affiliate_company_id;
ALTER TABLE users DROP COLUMN position;

-- Then the tables, leaves before parents: invitations and commissions reference companies;
-- operators reference companies and users. Their indexes go with them.
DROP TABLE affiliate_invitations;
DROP TABLE affiliate_commissions;
DROP TABLE affiliate_operators;
DROP TABLE affiliate_companies;
