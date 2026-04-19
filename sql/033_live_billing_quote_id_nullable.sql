-- ══════════════════════════════════════════════════════════════
-- 033_live_billing_quote_id_nullable.sql
--
-- live_billing rows sourced from qbo-pull have no originating
-- Athena quote — they're observations of what QBO is currently
-- billing, not the output of a Commit-to-Live flow from a quote.
-- The NOT NULL constraint on live_billing.quote_id was appropriate
-- when every row came through the commit flow, but it blocks QBO
-- sync from ever writing.
--
-- Applied live via MCP 2026-04-19.
-- ══════════════════════════════════════════════════════════════

BEGIN;
ALTER TABLE live_billing ALTER COLUMN quote_id DROP NOT NULL;
COMMIT;
