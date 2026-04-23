-- ══════════════════════════════════════════════════════════════
-- 041_nst_to_quick_tasks.sql
--
-- Route NST-prefixed BM tasks into quick_tasks instead of
-- bm_task_schedule. NST = "not-standard task" in BrightManager —
-- ad-hoc work that's already pre-arranged and doesn't need Athena's
-- auto-scheduler. Treating them as quick tasks keeps them visible
-- without cluttering the statutory schedule or planner.
--
-- This migration does three things:
--   1. Adds two columns to quick_tasks so BM-sourced tasks can be
--      upserted idempotently:
--        • bm_task_id text UNIQUE  (BM's canonical identifier)
--        • source    text          ('manual' | 'bm_nst')
--   2. Moves any existing NST rows from bm_task_schedule into
--      quick_tasks (source='bm_nst').
--   3. Deletes the now-migrated NST rows from bm_task_schedule.
--
-- Safe because:
--   • No timesheet entries reference NST rows (verified pre-migration).
--   • The planner already skips NST (shipped b42bb7c), so there's no
--     in-flight draft state to disturb.
--
-- After this lands, the JS import writer (writers/bmTasks.js) will
-- split NST rows from regular rows before dispatching: NST rows
-- upsert into quick_tasks; everything else goes through the existing
-- import_bm_tasks RPC unchanged.
-- ══════════════════════════════════════════════════════════════

BEGIN;

-- ────────────────────────────────────────────────────────────
-- 1. Schema additions
-- ────────────────────────────────────────────────────────────
ALTER TABLE public.quick_tasks
  ADD COLUMN IF NOT EXISTS bm_task_id text,
  ADD COLUMN IF NOT EXISTS source     text NOT NULL DEFAULT 'manual'
                           CHECK (source IN ('manual', 'bm_nst'));

-- Idempotency key for BM-sourced quick tasks. Null for manual rows.
CREATE UNIQUE INDEX IF NOT EXISTS quick_tasks_bm_task_id_uq
  ON public.quick_tasks (bm_task_id)
  WHERE bm_task_id IS NOT NULL;

COMMENT ON COLUMN public.quick_tasks.bm_task_id IS
  'BrightManager task_id for BM-sourced NST quick tasks. Null for manually-created ones. Unique when present.';
COMMENT ON COLUMN public.quick_tasks.source IS
  'Where this quick task came from. manual = user-created in Athena; bm_nst = imported from a BM NST-prefixed task.';


-- ────────────────────────────────────────────────────────────
-- 2. Move existing NST rows from bm_task_schedule → quick_tasks
-- ────────────────────────────────────────────────────────────
INSERT INTO public.quick_tasks (
  bm_task_id,
  source,
  title,
  entity_id,
  service,
  assignee_id,
  due_date,
  planned_date,
  duration,
  notes,
  sort_order,
  created_by,
  created_at
)
SELECT
  bts.bm_task_id,
  'bm_nst',
  bts.bm_task_name,
  bts.entity_id,
  NULL::text,           -- service left null; BM "Personal Tax" etc. don't match quick_tasks.service enum
  bts.assignee_id,
  bts.bm_deadline::timestamptz,
  bts.scheduled_for_date::timestamptz,
  COALESCE((bts.scheduled_hours * 60)::int, 60),
  'Migrated from bm_task_schedule (NST prefix)',
  0,
  bts.manually_overridden_by,
  bts.created_at
FROM public.bm_task_schedule bts
WHERE bts.bm_task_name ILIKE 'NST%';
-- No ON CONFLICT: quick_tasks.bm_task_id is a brand-new column,
-- so no existing rows can collide. This is a one-shot data move.


-- ────────────────────────────────────────────────────────────
-- 3. Delete migrated rows from bm_task_schedule
-- ────────────────────────────────────────────────────────────
DELETE FROM public.bm_task_schedule
 WHERE bm_task_name ILIKE 'NST%';

COMMIT;
