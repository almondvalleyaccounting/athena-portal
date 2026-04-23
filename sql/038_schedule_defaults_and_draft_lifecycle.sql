-- ══════════════════════════════════════════════════════════════
-- 038_schedule_defaults_and_draft_lifecycle.sql
--
-- Task-type-driven scheduling with draft→approve→commit lifecycle.
--
-- Supersedes the BM-deadline-driven placement used by 034/035.
-- Going forward:
--   1. BM tasks land (deadline still recorded as input signal).
--   2. Planner matches each task to a task_type_schedule_default
--      (prefix match on bm_task_name, first-match-wins by priority).
--   3. Default yields a calendar slot: (month anchor, week-of-month,
--      target hours). Week-of-month = 2nd Mon–Fri block of the month.
--   4. Client cadence preference shifts the slot ±1 week.
--   5. Rows are written with status='draft', grouped by draft_cycle_id.
--   6. Each assignee approves their own slice; status flips to
--      'approved'. Auto-commits to 'committed' when last approval
--      for that cycle lands.
--   7. Work planner surfaces only status='committed' rows.
--
-- Design rules (decided 2026-04-23):
--   • One cadence_preference per client (column on entities, not
--     a history table). Most clients behave consistently.
--   • Status is the lifecycle axis; existing `state` stays as the
--     execution axis (planned/completed/cancelled/unscheduled).
--   • Re-import regenerates drafts from scratch — no preservation
--     of draft-stage edits across cycles (MVP simplicity).
--   • No admin commit step — commit happens automatically when
--     the last assignee in a cycle approves their slice.
--
-- This migration is additive. Existing rows backfill to
-- status='committed' so current work-planner behaviour is preserved.
-- ══════════════════════════════════════════════════════════════

BEGIN;

-- ────────────────────────────────────────────────────────────
-- entities.cadence_preference — one value per client
-- ────────────────────────────────────────────────────────────
ALTER TABLE public.entities
  ADD COLUMN IF NOT EXISTS cadence_preference text
    NOT NULL DEFAULT 'normal'
    CHECK (cadence_preference IN ('early','normal','late'));

COMMENT ON COLUMN public.entities.cadence_preference IS
  'Scheduling cadence for this client. early = shift −1 week from task-type default; normal = as-is; late = shift +1 week.';


-- ────────────────────────────────────────────────────────────
-- task_type_schedule_defaults — one row per task-type template
--
-- Prefix-match on bm_task_name (same convention as
-- bm_scheduling_rules.task_name_prefix). First-match-wins, ordered
-- by match_priority DESC then name ASC.
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.task_type_schedule_defaults (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text NOT NULL,            -- human label ("VAT return", "Year-end accounts")
  task_name_prefix  text NOT NULL,            -- matches bm_task_name LIKE prefix%
  cadence           text NOT NULL
                    CHECK (cadence IN ('monthly','quarterly','annually','year_end_offset')),
  month_offset      int,                      -- year_end_offset: months after client's YE
                                              -- quarterly: 0 | 1 | 2 (which month of the quarter)
                                              -- monthly / annually: NULL
  week_of_month     int NOT NULL DEFAULT 2
                    CHECK (week_of_month BETWEEN 1 AND 5),  -- 5 = last Mon–Fri block
  target_hours      numeric(5,2) NOT NULL DEFAULT 1.0,
  match_priority    int NOT NULL DEFAULT 0,
  notes             text,
  is_active         boolean NOT NULL DEFAULT true,
  created_by        uuid REFERENCES public.staff_profiles(id),
  updated_by        uuid REFERENCES public.staff_profiles(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS task_type_schedule_defaults_active_priority_idx
  ON public.task_type_schedule_defaults (is_active, match_priority DESC);

ALTER TABLE public.task_type_schedule_defaults ENABLE ROW LEVEL SECURITY;

CREATE POLICY task_type_schedule_defaults_read ON public.task_type_schedule_defaults
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.staff_profiles sp
            WHERE sp.id = auth.uid() AND sp.is_active = true)
  );

CREATE POLICY task_type_schedule_defaults_write ON public.task_type_schedule_defaults
  FOR ALL USING (
    EXISTS (SELECT 1 FROM public.staff_profiles sp
            WHERE sp.id = auth.uid()
              AND (sp.is_portal_admin = true OR sp.can_import_data = true))
  );


-- ────────────────────────────────────────────────────────────
-- bm_task_schedule — add lifecycle columns
--
-- status flows: draft → approved → committed
-- Existing rows backfill to 'committed' so current work-planner
-- queries (WHERE status='committed') keep surfacing them.
-- ────────────────────────────────────────────────────────────
ALTER TABLE public.bm_task_schedule
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'committed'
    CHECK (status IN ('draft','approved','committed')),
  ADD COLUMN IF NOT EXISTS draft_cycle_id uuid,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS approved_by uuid REFERENCES public.staff_profiles(id),
  ADD COLUMN IF NOT EXISTS committed_at timestamptz;

-- Existing rows were implicitly committed — stamp committed_at retroactively.
UPDATE public.bm_task_schedule
   SET committed_at = COALESCE(committed_at, created_at)
 WHERE status = 'committed' AND committed_at IS NULL;

CREATE INDEX IF NOT EXISTS bm_task_schedule_status_idx
  ON public.bm_task_schedule (status);
CREATE INDEX IF NOT EXISTS bm_task_schedule_draft_cycle_idx
  ON public.bm_task_schedule (draft_cycle_id)
  WHERE draft_cycle_id IS NOT NULL;

COMMENT ON COLUMN public.bm_task_schedule.status IS
  'Lifecycle axis. draft = in current planning cycle, awaiting assignee approval. approved = assignee signed off. committed = live in work planner. Separate from `state` which is the execution axis (planned/completed/cancelled/unscheduled).';
COMMENT ON COLUMN public.bm_task_schedule.draft_cycle_id IS
  'Groups rows generated by one planner run. A new cycle supersedes any prior unapproved drafts for the same assignee; committed rows are untouched.';

COMMIT;
