-- ══════════════════════════════════════════════════════════════
-- 030_live_billing_needs_review.sql
--
-- Per-service cadence classification in qbo-pull can't always
-- decide monthly vs annual cleanly — e.g. when a service appears
-- in the prior calendar month but the amount differs by >10%.
-- Those rows default to "recurring" provisionally and are flagged
-- for staff review.
--
--   needs_review   — true if any service line on the row couldn't
--                    be confidently classified
--   review_reason  — free-text explanation ("Prior month £310
--                    differs from latest £450 by 45%") for the
--                    first ambiguous service; the full per-service
--                    audit lives in the services jsonb.
--
-- Partial index on needs_review=true keeps the "Needs review" KPI
-- and filter cheap even when the vast majority of rows are clean.
-- ══════════════════════════════════════════════════════════════

ALTER TABLE live_billing
  ADD COLUMN IF NOT EXISTS needs_review boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS review_reason text;

CREATE INDEX IF NOT EXISTS live_billing_needs_review_idx
  ON live_billing (needs_review) WHERE needs_review = true;
