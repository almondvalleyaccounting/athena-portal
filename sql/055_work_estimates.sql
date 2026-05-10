-- 055_work_estimates.sql
-- Work Estimates tab: minutes-per-job per (entity, canonical_service),
-- driven by editable defaults and per-client overrides. Cadence (monthly /
-- quarterly / annual) is inferred from BM data.

-- 1. Switch service_effort_defaults to minutes-based and reseed with the
--    practice-wide defaults: bookkeeping 60/180, VAT review 30, accounts
--    prep 300, accounts submission 60.
ALTER TABLE service_effort_defaults
  ADD COLUMN IF NOT EXISTS minutes_per_job integer;

UPDATE service_effort_defaults
   SET minutes_per_job = (hours * 60)::integer
 WHERE minutes_per_job IS NULL;

DELETE FROM service_effort_defaults;

INSERT INTO service_effort_defaults (canonical_service_id, cadence, hours, minutes_per_job) VALUES
  ('bookkeeping',          'monthly',   1.0,  60),
  ('bookkeeping',          'quarterly', 3.0, 180),
  ('vat_review',           'monthly',   0.5,  30),
  ('vat_review',           'quarterly', 0.5,  30),
  ('accounts_preparation', 'annual',    5.0, 300),
  ('accounts_submission',  'annual',    1.0,  60)
ON CONFLICT (canonical_service_id, cadence) DO UPDATE
  SET minutes_per_job = EXCLUDED.minutes_per_job,
      hours = EXCLUDED.hours;

ALTER TABLE service_effort_defaults
  ALTER COLUMN minutes_per_job SET NOT NULL;

-- 2. Per-client per-service override (one row per cell).
CREATE TABLE IF NOT EXISTS service_effort_overrides (
  entity_id uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  canonical_service_id text NOT NULL,
  minutes_per_job integer NOT NULL CHECK (minutes_per_job >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES staff_profiles(id),
  PRIMARY KEY (entity_id, canonical_service_id)
);

ALTER TABLE service_effort_overrides ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_effort_overrides_all" ON service_effort_overrides;
CREATE POLICY "service_effort_overrides_all" ON service_effort_overrides
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- 3. Cadence per (entity, canonical_service), inferred from BM tasks.
--    Bookkeeping: count distinct period_end dates over a 18-month window;
--      9+ tasks → monthly, otherwise quarterly.
--    VAT: explicit "Monthly"/"Quarterly" in bm_task_name.
--    Accounts prep / submission: always annual.
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
WHERE canonical_service_id IN ('accounts_preparation', 'accounts_submission');
