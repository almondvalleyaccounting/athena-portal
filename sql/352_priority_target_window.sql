-- 352_priority_target_window.sql
--
-- Priority board target window and expedite rule (Bobby, 2026-10-07).
--
-- "If capacity allows, we want internal reviews done between months 3 and 6
-- after year end, not 10 days before (the bare minimum). Expedited clients
-- should be squeezed in as soon as the year end has passed, but they don't
-- automatically go above clients where doing so risks those other clients
-- being late (less than one month from submission deadline)."
--
-- Read by _shared/priority-board.ts (accounts only; self assessment keeps the
-- statutory limit). The buffer before the statutory date (priority_buffer_wd,
-- sql/349) is still the hard cap. Editable on the Scheduled Jobs page with
-- the other workflow settings.

alter table public.job_plan_settings
  add column if not exists priority_target_from_months  integer not null default 3  check (priority_target_from_months between 0 and 12),
  add column if not exists priority_target_to_months    integer not null default 6  check (priority_target_to_months between 1 and 12),
  add column if not exists priority_expedite_guard_days integer not null default 30 check (priority_expedite_guard_days between 0 and 120);

insert into public.scheduled_job_settings
  (job_key, setting_key, label, help, value_type, target_table, target_column,
   id_kind, touch_updated_at, min_value, max_value, risk, risk_note, sort_order)
values
('job-plan-tick', 'priority_target_from_months', 'Priority: earliest internal review (months after year end)',
 'The Priority board won''t date an accounts review before year end plus this many months, unless the client is expedited.',
 'int', 'job_plan_settings', 'priority_target_from_months', 'bool_true', true, 0, 12, 'internal', null, 200),
('job-plan-tick', 'priority_target_to_months', 'Priority: target internal review (months after year end)',
 'An accounts review dated after year end plus this many months shows "Behind target" on the Priority board.',
 'int', 'job_plan_settings', 'priority_target_to_months', 'bool_true', true, 1, 12, 'internal', null, 210),
('job-plan-tick', 'priority_expedite_guard_days', 'Priority: protect jobs this close to their deadline (days)',
 'An expedited client goes in just below the last job within this many days of its filing deadline, never above it.',
 'int', 'job_plan_settings', 'priority_expedite_guard_days', 'bool_true', true, 0, 120, 'internal', null, 220)
on conflict (job_key, setting_key) do update set
  label = excluded.label, help = excluded.help, value_type = excluded.value_type,
  target_table = excluded.target_table, target_column = excluded.target_column,
  id_kind = excluded.id_kind, touch_updated_at = excluded.touch_updated_at,
  min_value = excluded.min_value, max_value = excluded.max_value,
  risk = excluded.risk, risk_note = excluded.risk_note, sort_order = excluded.sort_order;
