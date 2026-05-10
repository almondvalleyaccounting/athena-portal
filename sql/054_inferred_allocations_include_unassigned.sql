-- 054_inferred_allocations_include_unassigned.sql
-- Refresh v_inferred_allocations so rows with assignee_id IS NULL are kept,
-- letting the Allocations matrix distinguish "n/a" (no BM task) from
-- "unassigned" (BM task exists but no assignee).

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
  WHERE COALESCE(bts.state, 'committed') <> 'discarded'
),
ranked AS (
  SELECT
    entity_id, canonical_service_id, assignee_id,
    COUNT(*) AS task_count,
    ROW_NUMBER() OVER (
      PARTITION BY entity_id, canonical_service_id
      ORDER BY (assignee_id IS NULL), COUNT(*) DESC, assignee_id
    ) AS rn
  FROM classified
  WHERE canonical_service_id IS NOT NULL
  GROUP BY entity_id, canonical_service_id, assignee_id
),
direct AS (
  SELECT entity_id, canonical_service_id, assignee_id, task_count
  FROM ranked WHERE rn = 1
)
SELECT entity_id, canonical_service_id, assignee_id, task_count, FALSE AS via_fallback
FROM direct
UNION ALL
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
