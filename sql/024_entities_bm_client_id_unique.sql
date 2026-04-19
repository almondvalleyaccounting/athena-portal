-- ══════════════════════════════════════════════════════════════
-- 024_entities_bm_client_id_unique.sql
--
-- The existing idx_entities_bm_client_id was a plain btree partial
-- index, not unique — despite DATABASE_SPEC_LIVE.md §3.2 claiming
-- uniqueness. import_bm_clients' ON CONFLICT (bm_client_id) WHERE
-- bm_client_id IS NOT NULL clause therefore failed with "no unique
-- or exclusion constraint matching the ON CONFLICT specification"
-- for every non-prospect-conversion row in the first 622-row BM
-- import (2026-04-19). The 5 prospect-conversion rows succeeded
-- because that path uses UPDATE by id, not ON CONFLICT.
--
-- Verified zero duplicates on bm_client_id before swap. Applied via
-- Supabase MCP.
-- ══════════════════════════════════════════════════════════════

BEGIN;

DROP INDEX IF EXISTS idx_entities_bm_client_id;
CREATE UNIQUE INDEX idx_entities_bm_client_id
  ON public.entities (bm_client_id)
  WHERE bm_client_id IS NOT NULL;

COMMIT;
