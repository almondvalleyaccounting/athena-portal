-- ══════════════════════════════════════════════════════════════
-- 045_quick_tasks_bm_task_id_constraint.sql
--
-- Convert the partial unique index on quick_tasks.bm_task_id to a
-- proper UNIQUE constraint. Supabase's upsert(..., onConflict:
-- 'bm_task_id') needs a named unique constraint; a partial index
-- isn't enough and causes "there is no unique or exclusion
-- constraint matching the ON CONFLICT specification" at import.
--
-- Multiple NULL values are still allowed under Postgres UNIQUE (by
-- default), so manually-created quick tasks (bm_task_id IS NULL)
-- remain unconstrained.
-- ══════════════════════════════════════════════════════════════

BEGIN;

DROP INDEX IF EXISTS public.quick_tasks_bm_task_id_uq;

ALTER TABLE public.quick_tasks
  ADD CONSTRAINT quick_tasks_bm_task_id_uq UNIQUE (bm_task_id);

COMMIT;
