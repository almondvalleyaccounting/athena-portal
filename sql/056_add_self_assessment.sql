-- 056_add_self_assessment.sql
-- Adds Self Assessment as a 5th canonical service across the inference,
-- classified load, cadence and effort default views/tables.
--
-- Mapping: service IN ('Self Assessment') AND bm_task_name ILIKE '%Submission%'
-- Covers 'Self Assessment Submission Tax Year YYYY/YY' (~273 tasks) plus
-- partnership 'SA800 Return Submission ...' (~7 tasks).

-- 1. Effort default — annual, 45 min/job.
INSERT INTO service_effort_defaults (canonical_service_id, cadence, hours, minutes_per_job)
VALUES ('self_assessment', 'annual', 0.75, 45)
ON CONFLICT (canonical_service_id, cadence) DO UPDATE
  SET minutes_per_job = EXCLUDED.minutes_per_job,
      hours = EXCLUDED.hours;

-- 2. Refresh v_inferred_allocations to include self_assessment.
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
      WHEN bts.service = 'Self Assessment' AND bts.bm_task_name ILIKE '%Submission%'
        THEN 'self_assessment'
      ELSE NULL
    END AS canonical_service_id
  FROM bm_task_schedule bts
  WHERE COALESCE(bts.state, 'committed') <> 'discarded'
),
ranked AS (
  SELECT
    entity_id,
    canonical_service_id,
    assignee_id,
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
  FROM ranked
  WHERE rn = 1
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

-- 3. Refresh v_bm_load_classified to include self_assessment.
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
    WHEN bts.service = 'Self Assessment' AND bts.bm_task_name ILIKE '%Submission%'
      THEN 'self_assessment'
    ELSE NULL
  END AS canonical_service_id,
  bts.assignee_id,
  date_trunc('month', bts.scheduled_for_date)::date AS month,
  COALESCE(bts.scheduled_hours, 0)::numeric AS hours
FROM bm_task_schedule bts
WHERE bts.scheduled_for_date IS NOT NULL
  AND bts.assignee_id IS NOT NULL
  AND COALESCE(bts.state, 'committed') <> 'discarded';

-- 4. Refresh v_service_cadence to add self_assessment (annual).
CREATE OR REPLACE VIEW v_service_cadence AS
WITH bookkeeping_counts AS (
  SELECT entity_id, COUNT(DISTINCT bm_target_date) AS n
  FROM bm_task_schedule
  WHERE service = 'Bookkeeping'
    AND COALESCE(state, 'committed') <> 'discarded'
    AND bm_target_date IS NOT NULL
    AND bm_target_date BETWEEN current_date - interval '6 months'
                           AND current_date + interval '12 months'
  GROUP BY entity_id
),
vat_cadence AS (
  SELECT entity_id,
    CASE WHEN bool_or(bm_task_name ILIKE '%Monthly%') THEN 'monthly'
         ELSE 'quarterly' END AS cadence
  FROM bm_task_schedule
  WHERE service = 'VAT'
    AND bm_task_name ILIKE '%Submission%'
    AND COALESCE(state, 'committed') <> 'discarded'
  GROUP BY entity_id
)
SELECT entity_id,
       'bookkeeping'::text AS canonical_service_id,
       CASE WHEN n >= 9 THEN 'monthly' ELSE 'quarterly' END AS cadence
FROM bookkeeping_counts
UNION ALL
SELECT entity_id, 'vat_review'::text, cadence FROM vat_cadence
UNION ALL
SELECT DISTINCT entity_id, canonical_service_id, 'annual'::text AS cadence
FROM v_inferred_allocations
WHERE canonical_service_id IN ('accounts_preparation', 'accounts_submission', 'self_assessment');
