-- ══════════════════════════════════════════════════════════════
-- 043_extend_schedule_view_lifecycle.sql
--
-- bm_task_schedule_with_progress was created in 034 (before the new
-- lifecycle columns landed in 038). Views don't auto-pick up new
-- columns on the base table — the Preview UI was throwing
-- "column bm_task_schedule_with_progress.status does not exist".
--
-- Drop + rebuild so the view exposes: status, draft_cycle_id,
-- approved_at, approved_by, committed_at. Everything else stays.
-- ══════════════════════════════════════════════════════════════

BEGIN;

DROP VIEW IF EXISTS public.bm_task_schedule_with_progress;

CREATE VIEW public.bm_task_schedule_with_progress AS
SELECT
  s.id,
  s.bm_task_id,
  s.entity_id,
  s.rule_id,
  s.bm_task_name,
  s.service,
  s.bm_deadline,
  s.bm_target_date,
  s.bm_status,
  s.bm_latest_action_date,
  s.assignee_id,
  s.bm_assignee_name,
  s.scheduled_for_date,
  s.scheduled_hours,
  s.manually_overridden_at,
  s.manually_overridden_by,
  s.state,
  s.status,
  s.draft_cycle_id,
  s.approved_at,
  s.approved_by,
  s.committed_at,
  s.last_import_id,
  s.last_seen_at,
  s.created_at,
  s.updated_at,
  COALESCE(round(sum(t.minutes)::numeric / 60::numeric, 2), 0::numeric) AS logged_hours,
  GREATEST(0::numeric, s.scheduled_hours - COALESCE(round(sum(t.minutes)::numeric / 60::numeric, 2), 0::numeric)) AS remaining_hours
FROM public.bm_task_schedule s
LEFT JOIN public.timesheet_entries t ON t.source_task_id = s.id
GROUP BY s.id;

COMMIT;
