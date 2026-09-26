-- 308: Arm the job-plan nudge from a date, not from the moment the switch is
-- flipped. Bobby, 2026-09-26: the team has until 16 October to commit their
-- lists; reminders start the morning after. The tick sends only when
-- nudges_armed is true AND today >= nudges_from.

alter table public.job_plan_settings
  add column if not exists nudges_from text
  check (nudges_from is null or nudges_from ~ '^\d{4}-\d{2}-\d{2}$');

comment on column public.job_plan_settings.nudges_from is
  'YYYY-MM-DD. Nudges are held until this date even when armed. Null = as soon as armed.';

insert into public.scheduled_job_settings
  (job_key, setting_key, label, help, value_type, target_table, target_column, id_kind, touch_updated_at, min_value, max_value, risk, risk_note, sort_order)
values
('job-plan-tick', 'nudges_from',
 'Start nudging from (YYYY-MM-DD)',
 'Even when armed, no nudge goes out before this date. Blank means straight away.',
 'text', 'job_plan_settings', 'nudges_from', 'bool_true', true, null, null,
 'internal', null, 15)
on conflict (job_key, setting_key) do update set
  label = excluded.label, help = excluded.help, sort_order = excluded.sort_order;

-- Armed now, held until the morning after the team's deadline.
update public.job_plan_settings
   set nudges_armed = true, nudges_from = '2026-10-17', updated_at = now()
 where id = true;
