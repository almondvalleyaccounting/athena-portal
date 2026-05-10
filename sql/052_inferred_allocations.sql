-- 052_inferred_allocations.sql
-- View that derives "current assignment" from bm_task_schedule rows so the
-- Allocations matrix shows the BM reality on first load. The matrix never
-- writes back to BM — proposed changes live in allocation_changes and end
-- up in a reallocation report for the BM admin.
--
-- Mapping (canonical_service_id ← BM service + task name):
--   bookkeeping          ← service='Bookkeeping'
--   vat_review           ← service='VAT' AND task name LIKE '%Submission%'
--   accounts_preparation ← service='Annual Accounts' AND task name LIKE 'Accounts Preparation%'
--                          (fallback: same as accounts_submission if no prep task exists)
--   accounts_submission  ← service='Annual Accounts' AND task name LIKE '%Companies House Submission%'
--                          OR service='Corporation Tax' AND task name LIKE 'CT600 Submission%'

CREATE OR REPLACE VIEW v_inferred_allocations AS
WITH classified AS (
  SELECT
    bts.entity_id,
    bts.assignee_id,
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
    END AS canonical_service_id
  FROM bm_task_schedule bts
  WHERE bts.assignee_id IS NOT NULL
    AND COALESCE(bts.state, 'committed') <> 'discarded'
),
ranked AS (
  SELECT
    entity_id,
    canonical_service_id,
    assignee_id,
    COUNT(*) AS task_count,
    -- Pick the most common assignee per (entity, service); ties broken by smaller uuid.
    ROW_NUMBER() OVER (
      PARTITION BY entity_id, canonical_service_id
      ORDER BY COUNT(*) DESC, assignee_id
    ) AS rn
  FROM classified
  WHERE canonical_service_id IS NOT NULL
  GROUP BY entity_id, canonical_service_id, assignee_id
),
direct AS (
  SELECT entity_id, canonical_service_id, assignee_id, task_count
  FROM ranked
  WHERE rn = 1
)
SELECT entity_id, canonical_service_id, assignee_id, task_count, FALSE AS via_fallback
FROM direct

UNION ALL

-- Fallback: clients with an accounts_submission but no accounts_preparation
-- inherit the submission assignee for the prep column.
SELECT
  d.entity_id,
  'accounts_preparation' AS canonical_service_id,
  d.assignee_id,
  d.task_count,
  TRUE AS via_fallback
FROM direct d
WHERE d.canonical_service_id = 'accounts_submission'
  AND NOT EXISTS (
    SELECT 1 FROM direct d2
    WHERE d2.entity_id = d.entity_id
      AND d2.canonical_service_id = 'accounts_preparation'
  );
