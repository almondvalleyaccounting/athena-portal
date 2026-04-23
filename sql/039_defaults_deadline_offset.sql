-- ══════════════════════════════════════════════════════════════
-- 039_defaults_deadline_offset.sql
--
-- Simplify task_type_schedule_defaults: collapse the (cadence,
-- month_offset) pair into a single bm_deadline_offset_months field.
--
-- Rationale (decided 2026-04-23):
--   • Planner operates on BM tasks that already carry a bm_deadline.
--     We don't need to re-derive the period from cadence metadata —
--     everything can be expressed as "do this work N months before
--     the deadline" with a negative offset.
--   • Accountants think in "months after year-end" but that's
--     mathematically equivalent to "months before deadline" for any
--     given task type. Example for UK accounts:
--       deadline = YE + 9m, so "do work 3m after YE" = "do work 6m
--       before deadline" = offset = -6.
--   • entities has no year_end column; deriving from bm_deadline is
--     the only practical anchor we have.
--
-- Table is empty at time of migration (only just created in 038)
-- so a drop + add is safe.
-- ══════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE public.task_type_schedule_defaults
  DROP COLUMN IF EXISTS cadence,
  DROP COLUMN IF EXISTS month_offset;

ALTER TABLE public.task_type_schedule_defaults
  ADD COLUMN IF NOT EXISTS bm_deadline_offset_months int NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.task_type_schedule_defaults.bm_deadline_offset_months IS
  'Months to shift from bm_deadline when placing the scheduled work. Negative = before deadline (e.g. -6 = do the work 6 months before the deadline). The planner lands in that reference month, then uses week_of_month to pick the Mon–Fri block, then applies the client cadence preference as ±1 week.';

COMMIT;
