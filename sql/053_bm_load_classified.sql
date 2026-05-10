-- 053_bm_load_classified.sql
-- Per-(entity, canonical_service, assignee, month) breakdown of BM hours so
-- the Capacity heatmap can simulate proposed reallocations: shift an
-- entity-service's hours from one staff member to another in real time.
--
-- canonical_service_id is NULL for tasks that don't map to one of the four
-- canonical services. Drafts won't match those, so they flow through to
-- the original assignee unchanged.

CREATE OR REPLACE VIEW v_bm_load_classified AS
SELECT
  bts.entity_id,
  CASE
    WHEN bts.service = 'Bookkeeping'
      THEN 'bookkeeping'
    WHEN bts.service = 'VAT' AND bts.bm_task_name ILIKE '%Submission%'
      THEN 'vat_review'
    WHEN bts.service = 'Annual Accounts' AND bts.bm_task_name ILIKE 'Accounts Preparation%'
      THEN 'accounts_preparation'
    WHEN (bts.service = 'Annual Accounts' AND bts.bm_task_name ILIKE '%Companies House Submission%')
      OR (bts.service = 'Corporation Tax' AND bts.bm_task_name ILIKE 'CT600 Submission%')
      THEN 'accounts_submission'
    ELSE NULL
  END AS canonical_service_id,
  bts.assignee_id,
  date_trunc('month', bts.scheduled_for_date)::date AS month,
  COALESCE(bts.scheduled_hours, 0)::numeric AS hours
FROM bm_task_schedule bts
WHERE bts.scheduled_for_date IS NOT NULL
  AND bts.assignee_id IS NOT NULL
  AND COALESCE(bts.state, 'committed') <> 'discarded';
