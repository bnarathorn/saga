-- Saga 0010 — drop an index that was a duplicate from the day it was written.
--
-- 0008 declared both `CONSTRAINT work_item_steps_ordinal_uniq UNIQUE (work_item_id, ordinal)`
-- and `CREATE INDEX work_item_steps_work_item_idx ON (work_item_id, ordinal)`. PostgreSQL
-- implements a UNIQUE constraint as a btree index over exactly those columns in that order, so
-- the second index answers no query the first cannot. It only costs: another index to write on
-- every step declared and every step settled, and another to keep in cache.
--
-- The partial index stays. `work_item_steps_unsettled_idx` indexes only rows that are neither
-- done nor skipped, which is what lets the sweeper's candidate scan test "has an unsettled
-- step" without reading the settled ones — no unique constraint covers that.

DROP INDEX IF EXISTS quest.work_item_steps_work_item_idx;
