-- ============================================================
-- 325 — Self assessment nudges: capability, not armed
--
-- Bobby, 2026-09-26: the accounts nudge (a month past the year end with no
-- committed plan) gets a switch of its own for self assessment jobs, off
-- until he arms it. Same mailbox, same cadence, same "from" date rule.
-- ============================================================

alter table public.job_plan_settings
  add column if not exists sa_nudges_armed boolean not null default false,
  add column if not exists sa_nudges_from  date;
comment on column public.job_plan_settings.sa_nudges_armed is 'Nudge preparers about unplanned self assessment jobs (sql/325). Off until armed.';

insert into public.scheduled_job_settings
  (job_key, setting_key, label, help, value_type, target_table, target_column, id_kind, touch_updated_at, min_value, max_value, risk, risk_note, sort_order)
values
('job-plan-tick', 'sa_nudges_armed',
 'Nudge preparers about unplanned self assessment jobs',
 'The same nudge as for accounts, for sole traders, partnerships and LLPs a month past their period end with no committed plan. Off until armed.',
 'boolean', 'job_plan_settings', 'sa_nudges_armed', 'bool_true', true, null, null,
 'internal', null, 17),
('job-plan-tick', 'sa_nudges_from',
 'Start self assessment nudges from (YYYY-MM-DD)',
 'Even when armed, no self assessment nudge goes out before this date. Blank means straight away.',
 'text', 'job_plan_settings', 'sa_nudges_from', 'bool_true', true, null, null,
 'internal', null, 18)
on conflict (job_key, setting_key) do update set
  label = excluded.label, help = excluded.help, sort_order = excluded.sort_order;
