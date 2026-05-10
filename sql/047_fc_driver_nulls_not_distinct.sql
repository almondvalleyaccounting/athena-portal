-- ══════════════════════════════════════════════════════════════
-- 047_fc_driver_nulls_not_distinct.sql
--
-- Fix duplicate-row creation for group-scope drivers.
--
-- The original unique constraint (scenario_id, entity_id, module_key,
-- driver_key) on fc_driver treated NULL as distinct (Postgres default),
-- so re-running "Seed pack defaults" created a second copy of every
-- group-scope driver because (uuid, NULL, text, text) ≠ (uuid, NULL,
-- text, text) under that semantics.
--
-- This migration:
--   1) Dedupes existing rows: for each (scenario, entity-or-null, module,
--      driver_key) tuple keep the oldest fc_driver row, move any
--      fc_driver_value rows from victims to the keeper (no overwrite),
--      then delete the victims.
--   2) Drops the legacy constraint and re-adds it with NULLS NOT
--      DISTINCT so future upserts collide correctly on entity_id IS NULL.
--
-- Requires Postgres 15+. The Athena Supabase project is on PG15+.
-- ══════════════════════════════════════════════════════════════

BEGIN;

WITH ranked AS (
  SELECT id, scenario_id, entity_id, module_key, driver_key,
         row_number() OVER (
           PARTITION BY scenario_id, COALESCE(entity_id, '00000000-0000-0000-0000-000000000000'::uuid),
                        module_key, driver_key
           ORDER BY created_at ASC
         ) AS rn
  FROM public.fc_driver
),
keepers AS (
  SELECT scenario_id, entity_id, module_key, driver_key, id AS keep_id
  FROM ranked WHERE rn = 1
),
victims AS (
  SELECT r.id AS dup_id, k.keep_id
  FROM ranked r
  JOIN keepers k
    ON k.scenario_id = r.scenario_id
   AND COALESCE(k.entity_id, '00000000-0000-0000-0000-000000000000'::uuid)
       = COALESCE(r.entity_id, '00000000-0000-0000-0000-000000000000'::uuid)
   AND k.module_key = r.module_key
   AND k.driver_key = r.driver_key
  WHERE r.rn > 1
)
INSERT INTO public.fc_driver_value (driver_id, period, value)
SELECT v.keep_id, dv.period, dv.value
FROM public.fc_driver_value dv
JOIN victims v ON v.dup_id = dv.driver_id
ON CONFLICT (driver_id, period) DO NOTHING;

DELETE FROM public.fc_driver
WHERE id IN (
  SELECT r.id
  FROM (
    SELECT id, row_number() OVER (
      PARTITION BY scenario_id, COALESCE(entity_id, '00000000-0000-0000-0000-000000000000'::uuid),
                   module_key, driver_key
      ORDER BY created_at ASC
    ) AS rn
    FROM public.fc_driver
  ) r WHERE rn > 1
);

ALTER TABLE public.fc_driver
  DROP CONSTRAINT IF EXISTS fc_driver_scenario_id_entity_id_module_key_driver_key_key;

ALTER TABLE public.fc_driver
  ADD CONSTRAINT fc_driver_scenario_id_entity_id_module_key_driver_key_key
  UNIQUE NULLS NOT DISTINCT (scenario_id, entity_id, module_key, driver_key);

COMMIT;
