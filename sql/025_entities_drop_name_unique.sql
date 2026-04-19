-- ══════════════════════════════════════════════════════════════
-- 025_entities_drop_name_unique.sql
--
-- entities.name was UNIQUE since the original schema. That assumption
-- is wrong: the 2026-04-19 BM import contained two clients named
-- "Boyd, David" (BOYDD01 and BOYDD02), and real-world data also has
-- separate legal entities sharing a name (Foursite Inc / Foursite Inc
-- Ltd). company_number and bm_client_id remain uniquely indexed —
-- those are the true stable keys.
--
-- Dropping the UNIQUE constraint. Keeping a plain btree index on
-- entities.name for the search/filter patterns in EntitiesPage.
-- Applied to live via MCP.
-- ══════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE entities DROP CONSTRAINT IF EXISTS entities_name_key;
CREATE INDEX IF NOT EXISTS idx_entities_name ON entities (name);

COMMIT;
