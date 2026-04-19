-- ══════════════════════════════════════════════════════════════
-- 028_qbo_mapping_needs_review.sql
--
-- Flag ignored QBO customers whose name changes between pulls so
-- staff can re-evaluate. Used primarily for pre-provisioned QBO
-- licences (bulk-purchased seats with placeholder names like
-- "20 for £60…") that later get renamed when assigned to a real
-- client.
--
-- Behaviour owned by qbo-pull (deployed v17): on refresh of an
-- existing mapping row whose role='not_a_client', if the qbo_customer_name
-- differs from the stored one, record the old name in
-- previous_qbo_customer_name and raise needs_review.
--
-- Applied live via MCP 2026-04-19.
-- ══════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE qbo_customer_mappings
  ADD COLUMN IF NOT EXISTS needs_review boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS previous_qbo_customer_name text;

CREATE INDEX IF NOT EXISTS idx_qbo_mappings_needs_review
  ON qbo_customer_mappings (needs_review)
  WHERE needs_review = true;

COMMENT ON COLUMN qbo_customer_mappings.needs_review IS
  'True when an ignored mapping row had its qbo_customer_name changed in QBO since the last pull. Cleared when staff takes any action (map, re-ignore, restore).';

COMMIT;
