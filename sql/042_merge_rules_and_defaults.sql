-- ══════════════════════════════════════════════════════════════
-- 042_merge_rules_and_defaults.sql
--
-- Consolidates scheduling config: the old bm_scheduling_rules
-- table (28 active rows) absorbs the responsibilities that were
-- going to sit in task_type_schedule_defaults (empty). Adds a
-- per-client-per-task-type exception table.
--
-- Rationale: both tables prefix-match on bm_task_name and drive the
-- same planner. Keeping them separate was an artefact of design
-- iteration. Merging to one "rules" table makes the UI linear:
-- service default → client cadence → exception.
--
-- Changes (additive, non-destructive to existing import RPCs):
--   1. bm_scheduling_rules: add
--        bm_deadline_offset_months  (negative = before deadline)
--        week_of_month              (Nth Mon–Fri block, 1..5; 5=last)
--        target_hours               (canonical hours field; keeps
--                                    standard_hours in sync via trigger)
--      Backfill from existing lead_time_days / preferred_week_of_month /
--      standard_hours so nothing changes semantically.
--   2. Create client_task_overrides (rule_id, entity_id) PK.
--   3. Drop task_type_schedule_defaults (empty).
--
-- The existing ingest_bm_tasks / match_bm_tasks functions continue
-- to read lead_time_days etc. unchanged. The new planner reads the
-- new columns. Both coexist until we do a future cleanup pass.
-- ══════════════════════════════════════════════════════════════

BEGIN;

-- ────────────────────────────────────────────────────────────
-- 1. bm_scheduling_rules — new canonical columns
-- ────────────────────────────────────────────────────────────
ALTER TABLE public.bm_scheduling_rules
  ADD COLUMN IF NOT EXISTS bm_deadline_offset_months int,
  ADD COLUMN IF NOT EXISTS week_of_month             int,
  ADD COLUMN IF NOT EXISTS target_hours              numeric(5,2);

-- Backfill bm_deadline_offset_months from lead_time_days.
-- Approximate: 30.437 days/month. Negative (= before deadline).
UPDATE public.bm_scheduling_rules
   SET bm_deadline_offset_months = -CEIL(lead_time_days::numeric / 30.437)::int
 WHERE bm_deadline_offset_months IS NULL;

-- Backfill week_of_month from preferred_week_of_month; default 2 if absent.
UPDATE public.bm_scheduling_rules
   SET week_of_month = COALESCE(preferred_week_of_month, 2)
 WHERE week_of_month IS NULL;

-- Backfill target_hours from standard_hours.
UPDATE public.bm_scheduling_rules
   SET target_hours = standard_hours
 WHERE target_hours IS NULL;

-- Now enforce not-null + check constraints on the new columns.
ALTER TABLE public.bm_scheduling_rules
  ALTER COLUMN bm_deadline_offset_months SET NOT NULL,
  ALTER COLUMN bm_deadline_offset_months SET DEFAULT 0,
  ALTER COLUMN week_of_month             SET NOT NULL,
  ALTER COLUMN week_of_month             SET DEFAULT 2,
  ALTER COLUMN target_hours              SET NOT NULL,
  ALTER COLUMN target_hours              SET DEFAULT 1.0;

ALTER TABLE public.bm_scheduling_rules
  ADD CONSTRAINT bm_scheduling_rules_week_chk
    CHECK (week_of_month BETWEEN 1 AND 5);

COMMENT ON COLUMN public.bm_scheduling_rules.bm_deadline_offset_months IS
  'Months to shift from bm_deadline when placing scheduled work. Negative = before deadline (e.g. -6 for accounts = 6 months before filing deadline). Replaces the older lead_time_days field semantically.';
COMMENT ON COLUMN public.bm_scheduling_rules.week_of_month IS
  'Which Mon–Fri block of the reference month to place work in. 1–4 = explicit; 5 = last Mon–Fri block.';
COMMENT ON COLUMN public.bm_scheduling_rules.target_hours IS
  'Canonical target duration per instance. Mirrors standard_hours for backward compat with the ingest RPC.';


-- ────────────────────────────────────────────────────────────
-- 2. client_task_overrides — per-client exception to a rule
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.client_task_overrides (
  rule_id    uuid NOT NULL REFERENCES public.bm_scheduling_rules(id) ON DELETE CASCADE,
  entity_id  uuid NOT NULL REFERENCES public.entities(id)            ON DELETE CASCADE,
  -- All override fields are nullable; null = inherit the rule's value.
  bm_deadline_offset_months int,
  week_of_month             int,
  target_hours              numeric(5,2),
  notes                     text,
  created_by                uuid REFERENCES public.staff_profiles(id),
  updated_by                uuid REFERENCES public.staff_profiles(id),
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (rule_id, entity_id),
  CONSTRAINT client_task_overrides_week_chk
    CHECK (week_of_month IS NULL OR week_of_month BETWEEN 1 AND 5)
);

CREATE INDEX IF NOT EXISTS client_task_overrides_entity_idx
  ON public.client_task_overrides (entity_id);

ALTER TABLE public.client_task_overrides ENABLE ROW LEVEL SECURITY;

CREATE POLICY client_task_overrides_read ON public.client_task_overrides
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.staff_profiles sp
            WHERE sp.id = auth.uid() AND sp.is_active = true)
  );

CREATE POLICY client_task_overrides_write ON public.client_task_overrides
  FOR ALL USING (
    EXISTS (SELECT 1 FROM public.staff_profiles sp
            WHERE sp.id = auth.uid()
              AND (sp.is_portal_admin = true OR sp.can_import_data = true))
  );


-- ────────────────────────────────────────────────────────────
-- 3. Drop task_type_schedule_defaults (empty, role absorbed)
-- ────────────────────────────────────────────────────────────
DROP TABLE IF EXISTS public.task_type_schedule_defaults;


COMMIT;
