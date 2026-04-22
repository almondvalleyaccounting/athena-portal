-- ══════════════════════════════════════════════════════════════
-- 034_bm_task_scheduling.sql
--
-- Auto-scheduling engine for BrightManager tasks.
--
-- BrightManager remains the source of truth for statutory tasks.
-- Athena consumes a daily CSV export, matches each task to a rule,
-- and schedules a planned block (assignee × date × hours) that
-- feeds the workload view. Planned time is rendered as ghost cells
-- in the timesheet grid — it NEVER auto-posts a real timesheet
-- entry. Staff confirm by typing over the ghost and submitting.
--
-- Design rules (from scope discussion 2026-04-21/22):
--   • Additive only. No ALTERs on existing tables.
--   • Feature-flagged off by default via app_settings.
--   • Idempotent per BM task_id. Re-import does not duplicate.
--   • Manual override is sticky: once a staffer drags a planned
--     block, the scheduler stops re-applying the rule for that
--     task_id. Deadline moves surface as flags, not silent moves.
--   • Assignee always mirrors BM (not sticky). Time is sticky.
--   • Reconciliation diff on each upload emits flags, never writes
--     into BM and never silently discards data.
--
-- Tables:
--   app_settings              — lightweight key/value for flags
--   bm_scheduling_rules       — team-editable logic table
--   bm_task_schedule          — per-BM-task planned row
--   bm_reconciliation_flags   — flags surfaced on each CSV import
-- ══════════════════════════════════════════════════════════════

BEGIN;

-- ────────────────────────────────────────────────────────────
-- app_settings — reusable key/value store for feature flags
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.app_settings (
  setting_key   text PRIMARY KEY,
  setting_value jsonb NOT NULL,
  description   text,
  updated_by    uuid REFERENCES public.staff_profiles(id),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;

-- Staff with portal admin read; portal admin write.
CREATE POLICY app_settings_read ON public.app_settings
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.staff_profiles sp
            WHERE sp.id = auth.uid() AND sp.is_active = true)
  );

CREATE POLICY app_settings_write ON public.app_settings
  FOR ALL USING (
    EXISTS (SELECT 1 FROM public.staff_profiles sp
            WHERE sp.id = auth.uid() AND sp.is_portal_admin = true)
  );

-- Seed the auto-schedule feature flag in the OFF position.
INSERT INTO public.app_settings (setting_key, setting_value, description)
VALUES (
  'workflow.auto_schedule_v2',
  '{"enabled": false, "dry_run": true}'::jsonb,
  'BM task auto-scheduling engine. dry_run=true logs intended scheduling without writing rows.'
)
ON CONFLICT (setting_key) DO NOTHING;


-- ────────────────────────────────────────────────────────────
-- bm_scheduling_rules — team-editable logic table
--
-- Match is prefix-on-task-name. First-match-wins, ordered by
-- match_priority DESC then created_at ASC. NST: prefix tasks are
-- intentionally unmatched — they surface as no_rule_match flags.
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.bm_scheduling_rules (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                     text NOT NULL,
  task_name_prefix         text NOT NULL,
  service                  text NOT NULL,
  lead_time_days           integer NOT NULL DEFAULT 14,
  standard_hours           numeric(5,2) NOT NULL DEFAULT 1.00,
  preferred_dow            text CHECK (preferred_dow IN ('mon','tue','wed','thu','fri')),  -- NULL = any
  preferred_week_of_month  smallint CHECK (preferred_week_of_month BETWEEN 1 AND 5),        -- 1..4, 5=last, NULL = any
  assignee_source          text NOT NULL DEFAULT 'bm_assignee'
                             CHECK (assignee_source IN ('bm_assignee','rule_assignee')),
  rule_assignee_id         uuid REFERENCES public.staff_profiles(id),
  match_priority           integer NOT NULL DEFAULT 100,
  active                   boolean NOT NULL DEFAULT true,
  notes                    text,
  created_by               uuid REFERENCES public.staff_profiles(id),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bm_rules_assignee_consistency
    CHECK (assignee_source = 'bm_assignee' OR rule_assignee_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS bm_scheduling_rules_active_idx
  ON public.bm_scheduling_rules (active, match_priority DESC);

ALTER TABLE public.bm_scheduling_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY bm_rules_read ON public.bm_scheduling_rules
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.staff_profiles sp
            WHERE sp.id = auth.uid() AND sp.is_active = true)
  );

CREATE POLICY bm_rules_write ON public.bm_scheduling_rules
  FOR ALL USING (
    EXISTS (SELECT 1 FROM public.staff_profiles sp
            WHERE sp.id = auth.uid()
              AND (sp.is_portal_admin = true OR sp.can_import_data = true))
  );


-- ────────────────────────────────────────────────────────────
-- bm_task_schedule — per-task planned row, idempotent by bm_task_id
--
-- Invariants:
--   • One row per BM task_id. Re-import upserts.
--   • assignee_id mirrors BM on every import (unless rule pins).
--   • scheduled_for_date is recomputed each import UNLESS
--     manually_overridden_at IS NOT NULL, in which case the
--     scheduler leaves date/hours alone and only updates BM-sourced
--     fields (assignee, deadline, bm_status).
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.bm_task_schedule (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bm_task_id               text NOT NULL UNIQUE,
  entity_id                uuid REFERENCES public.entities(id),
  rule_id                  uuid REFERENCES public.bm_scheduling_rules(id),
  bm_task_name             text NOT NULL,
  service                  text,
  bm_deadline              date,
  bm_target_date           date,
  bm_status                text,
  bm_latest_action_date    date,
  assignee_id              uuid REFERENCES public.staff_profiles(id),
  bm_assignee_name         text,               -- raw name from CSV for audit
  scheduled_for_date       date,
  scheduled_hours          numeric(5,2),
  manually_overridden_at   timestamptz,
  manually_overridden_by   uuid REFERENCES public.staff_profiles(id),
  state                    text NOT NULL DEFAULT 'planned'
                             CHECK (state IN ('planned','completed','cancelled','unscheduled')),
  last_import_id           uuid REFERENCES public.import_log(id),
  last_seen_at             timestamptz NOT NULL DEFAULT now(),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bm_task_schedule_assignee_date_idx
  ON public.bm_task_schedule (assignee_id, scheduled_for_date);
CREATE INDEX IF NOT EXISTS bm_task_schedule_entity_idx
  ON public.bm_task_schedule (entity_id);
CREATE INDEX IF NOT EXISTS bm_task_schedule_state_idx
  ON public.bm_task_schedule (state);

ALTER TABLE public.bm_task_schedule ENABLE ROW LEVEL SECURITY;

CREATE POLICY bm_task_schedule_read ON public.bm_task_schedule
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.staff_profiles sp
            WHERE sp.id = auth.uid() AND sp.is_active = true)
  );

-- Any active staffer can drag their own / others' planned blocks
-- (the workload view is a team tool). Tighter policies can come
-- later if needed.
CREATE POLICY bm_task_schedule_write ON public.bm_task_schedule
  FOR ALL USING (
    EXISTS (SELECT 1 FROM public.staff_profiles sp
            WHERE sp.id = auth.uid() AND sp.is_active = true)
  );


-- ────────────────────────────────────────────────────────────
-- bm_reconciliation_flags — flags emitted on each CSV import
--
-- Flag types:
--   no_rule_match       — BM task imported, no rule matches prefix
--   completed_no_time   — BM marks completed, no submitted timesheet
--   deadline_moved      — BM deadline changed after manual override
--   cancelled_in_bm     — task disappeared from CSV (or status = cancelled)
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.bm_reconciliation_flags (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bm_task_id        text NOT NULL,
  flag_type         text NOT NULL
                      CHECK (flag_type IN ('no_rule_match','completed_no_time','deadline_moved','cancelled_in_bm')),
  severity          text NOT NULL DEFAULT 'info'
                      CHECK (severity IN ('info','warn','error')),
  details           jsonb NOT NULL DEFAULT '{}'::jsonb,
  import_id         uuid REFERENCES public.import_log(id),
  raised_at         timestamptz NOT NULL DEFAULT now(),
  resolved_at       timestamptz,
  resolved_by       uuid REFERENCES public.staff_profiles(id),
  resolution_notes  text
);

CREATE INDEX IF NOT EXISTS bm_recon_flags_open_idx
  ON public.bm_reconciliation_flags (resolved_at NULLS FIRST, raised_at DESC);
CREATE INDEX IF NOT EXISTS bm_recon_flags_task_idx
  ON public.bm_reconciliation_flags (bm_task_id);

ALTER TABLE public.bm_reconciliation_flags ENABLE ROW LEVEL SECURITY;

CREATE POLICY bm_recon_flags_read ON public.bm_reconciliation_flags
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.staff_profiles sp
            WHERE sp.id = auth.uid() AND sp.is_active = true)
  );

CREATE POLICY bm_recon_flags_write ON public.bm_reconciliation_flags
  FOR ALL USING (
    EXISTS (SELECT 1 FROM public.staff_profiles sp
            WHERE sp.id = auth.uid() AND sp.is_active = true)
  );


-- ────────────────────────────────────────────────────────────
-- updated_at triggers (house style)
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_app_settings_updated_at ON public.app_settings;
CREATE TRIGGER trg_app_settings_updated_at
  BEFORE UPDATE ON public.app_settings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_bm_rules_updated_at ON public.bm_scheduling_rules;
CREATE TRIGGER trg_bm_rules_updated_at
  BEFORE UPDATE ON public.bm_scheduling_rules
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_bm_task_schedule_updated_at ON public.bm_task_schedule;
CREATE TRIGGER trg_bm_task_schedule_updated_at
  BEFORE UPDATE ON public.bm_task_schedule
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


-- ────────────────────────────────────────────────────────────
-- Seed rules — conservative defaults derived from BM CSV patterns
-- observed 2026-04-15 export. All tunable via the rules editor.
--
-- NOT seeded (intentional):
--   • "NST:" and "New Client Setup"/"Onboard" — human-routed,
--     so they raise no_rule_match flags until the team adds rules.
--   • Anything "Payroll"-prefixed — payroll tasks come from the
--     Payroll Checklist, NOT BrightManager. If a Payroll task
--     appears in the BM export it should flag for review, not
--     auto-schedule. (Auto-Enrolment below is pension-regulator
--     compliance, separate from payroll runs.)
-- ────────────────────────────────────────────────────────────
INSERT INTO public.bm_scheduling_rules
  (name, task_name_prefix, service, lead_time_days, standard_hours,
   preferred_dow, preferred_week_of_month, match_priority, notes)
VALUES
  ('VAT Preparation',          'VAT Preparation',           'VAT',              14, 1.5, 'mon', NULL, 200, 'Quarterly prep, target Monday of deadline-2w'),
  ('VAT Submission',           'VAT Submission',            'VAT',               7, 0.5, NULL,  NULL, 200, 'Submit within 7d of deadline'),
  ('Accounts Preparation',     'Accounts Preparation',      'Annual Accounts',  60, 5.0, NULL,  NULL, 200, 'Start 2 months before CH deadline'),
  ('Companies House Submission','Companies House Submission','Annual Accounts', 14, 0.5, NULL,  NULL, 200, NULL),
  ('CT600 Submission',         'CT600 Submission',          'Corporation Tax',  14, 0.5, NULL,  NULL, 200, NULL),
  ('Self Assessment Preparation','Self Assessment Preparation','Self Assessment',30,1.5, NULL,  NULL, 200, NULL),
  ('Self Assessment Submission','Self Assessment Submission','Self Assessment', 21, 0.5, NULL,  NULL, 200, NULL),
  ('Monthly Records Request',  'Monthly Records Request',   'Bookkeeping',       7, 1.0, 'mon', 1,    200, 'First Monday after period end'),
  ('Management Accounts',      'Management Accounts',       'Management Accounts',14,1.5, NULL,  2,    200, 'Second week after period end'),
  ('Auto-Enrolment',           'Auto-Enrolment',            'Pensions',          7, 0.5, NULL,  NULL, 200, 'Pension-regulator compliance; not a payroll run'),
  ('Confirmation Statement',   'Confirmation Statement',    'Confirmation Statement',10,0.5,NULL,NULL,200,NULL)
ON CONFLICT DO NOTHING;


COMMIT;
