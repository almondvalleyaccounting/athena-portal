-- ============================================================
-- 305 — Job plan engine: risk, nudges, the Team signals, and the nightly tick
--
-- Builds on sql/304. Design: docs/WORKFLOW_TEMPLATE_ACCOUNTS_2026-09-25.md
-- §5 and §7.
--
--   job_plans.risk         what the nightly tick concluded about a plan:
--                          none | slipped | waiting_on_client | at_risk | urgent
--   job_plan_settings      the switches the tick obeys (nudges armed, cadence,
--                          which mailbox the nudge leaves from)
--   job_plan_nudges        one row per nudge sent, so a preparer is nudged
--                          weekly, not nightly
--   v_work_signals         one row per active staff member: the counts the
--                          Team page shows
--   run_job_plan_tick()    the pg_cron wrapper that calls the job-plan-tick
--                          edge function as service_role (Vault key, like
--                          sql/293)
--
-- Companies House filing has no data source in Athena yet (the nightly
-- refresh records status events only), so the "filed" signal is the BM row
-- leaving the export, the same as CT600.
-- ============================================================

alter table public.job_plans
  add column if not exists risk         text not null default 'none'
    check (risk in ('none', 'slipped', 'waiting_on_client', 'at_risk', 'urgent')),
  add column if not exists risk_reason  text,
  add column if not exists risk_at      timestamptz,
  add column if not exists last_tick_at timestamptz;

comment on column public.job_plans.risk is
  'Nightly verdict: urgent (inside the statutory buffer), at_risk (the chain has been clamped to it), waiting_on_client (records or approval overdue), slipped (a staff stage is overdue), none.';

-- ── Settings the tick obeys ─────────────────────────────────────────────────
create table if not exists public.job_plan_settings (
  id               boolean primary key default true check (id),
  nudges_armed     boolean not null default false,
  nudge_every_days integer not null default 7 check (nudge_every_days between 1 and 60),
  -- The mailbox the nudge leaves from (a gmail_connections.account_email).
  -- Null = the practice-default mailbox. Set to the practice director's
  -- address so it reads as a note from them.
  nudge_mailbox    text,
  updated_at       timestamptz not null default now()
);
insert into public.job_plan_settings (id) values (true) on conflict (id) do nothing;

create table if not exists public.job_plan_nudges (
  id               uuid primary key default gen_random_uuid(),
  entity_id        uuid not null references public.entities(id) on delete cascade,
  period_end       date not null,
  preparer_id      uuid references public.staff_profiles(id) on delete set null,
  sent_at          timestamptz not null default now(),
  mailbox          text,
  gmail_message_id text
);
create index if not exists job_plan_nudges_job_idx on public.job_plan_nudges (entity_id, period_end, sent_at desc);

alter table public.job_plan_settings enable row level security;
alter table public.job_plan_nudges   enable row level security;
drop policy if exists job_plan_settings_select_staff on public.job_plan_settings;
create policy job_plan_settings_select_staff on public.job_plan_settings
  for select to authenticated using (is_active_staff());
drop policy if exists job_plan_nudges_select_staff on public.job_plan_nudges;
create policy job_plan_nudges_select_staff on public.job_plan_nudges
  for select to authenticated using (is_active_staff());
revoke all on public.job_plan_settings from public, anon;
revoke all on public.job_plan_nudges   from public, anon;
revoke insert, update, delete, truncate, references, trigger on public.job_plan_settings from authenticated;
revoke insert, update, delete, truncate, references, trigger on public.job_plan_nudges   from authenticated;
grant select on public.job_plan_settings, public.job_plan_nudges to authenticated;
grant select, insert, update, delete on public.job_plan_settings, public.job_plan_nudges to service_role;

-- ── The Team page: one row per active staff member ──────────────────────────
create or replace view public.v_work_signals
with (security_invoker = true) as
with staff as (
  select id, name, working_days, weekly_capacity_hours
  from staff_profiles
  where is_active and coalesce(work_planner, true)
),
wd as (
  select id,
    greatest(1, array_length(string_to_array(coalesce(nullif(working_days, ''), 'mon,tue,wed,thu,fri'), ','), 1)) as days
  from staff
),
mine as (
  -- Plans where this person is the preparer.
  select distinct m.owner_id as staff_id, p.id as plan_id, p.risk
  from job_milestones m
  join job_plans p on p.id = m.plan_id and p.status = 'committed'
  where m.owner_role = 'preparer' and m.owner_id is not null
)
select
  s.id                                                        as staff_id,
  s.name,
  (select count(*) from v_accounts_jobs j
     where j.preparer_id = s.id
       and coalesce(j.plan_status, '') <> 'committed'
       and j.ch_deadline <= current_date + interval '7 months')            as unplanned_jobs,
  (select count(*) from job_milestones m join job_plans p on p.id = m.plan_id
     where m.owner_id = s.id and p.status = 'committed'
       and m.status = 'pending' and m.due_date < current_date)             as slipped_stages,
  (select count(*) from job_milestones m join job_plans p on p.id = m.plan_id
     where m.owner_id = s.id and p.status = 'committed'
       and m.status = 'pending'
       and m.due_date between current_date and current_date + 7)           as stages_this_week,
  (select count(*) from mine x where x.staff_id = s.id and x.risk = 'waiting_on_client') as waiting_on_client,
  (select count(*) from mine x where x.staff_id = s.id and x.risk in ('at_risk', 'urgent')) as at_risk,
  (select count(*) from bm_task_schedule b
     join entities e on e.id = b.entity_id and e.entity_status not in ('nlac', 'archived')
     where b.assignee_id = s.id and b.state = 'planned' and b.excluded_at is null
       and b.bm_deadline < current_date)                                   as past_deadline_jobs,
  (select count(*) from quick_tasks q where q.assignee_id = s.id)          as open_actions,
  (select count(*) from quick_tasks q where q.assignee_id = s.id
     and q.due_date < now())                                               as overdue_actions,
  (select coalesce(sum(b.scheduled_hours), 0) from bm_task_schedule b
     where b.assignee_id = s.id and b.state = 'planned' and b.excluded_at is null
       and b.scheduled_for_date between current_date and current_date + 13) as scheduled_hours_14d,
  round(coalesce(s.weekly_capacity_hours, w.days * 7.5) * 2, 1)            as capacity_hours_14d,
  (select coalesce(round(sum(t.minutes) / 60.0, 1), 0) from timesheet_entries t
     where t.staff_id = s.id and t.work_date >= current_date - 7)          as hours_logged_7d,
  greatest(
    (select max(t.created_at) from timesheet_entries t where t.staff_id = s.id),
    (select max(m.done_at) from job_milestones m where m.owner_id = s.id),
    (select max(q.updated_at) from quick_tasks q where q.assignee_id = s.id),
    (select max(p.committed_at) from job_plans p where p.committed_by = s.id)
  )                                                                        as last_activity
from staff s
join wd w on w.id = s.id;

comment on view public.v_work_signals is
  'The Team overview: per active staff member, unplanned jobs, slipped and upcoming stages, plans waiting on the client or at risk, past-deadline BM jobs, open actions, load against capacity, hours logged.';

revoke all on public.v_work_signals from public, anon;
grant select on public.v_work_signals to authenticated, service_role;

-- ── The nightly tick, registered in Scheduled Jobs ──────────────────────────
create or replace function public.run_job_plan_tick()
returns void
language plpgsql
security definer
set search_path = public, net, extensions, vault
as $$
declare
  v_service_key text;
begin
  -- Machine traffic only: pg_cron / psql (no JWT) or service_role.
  if not public.is_staff_or_service() or coalesce(auth.role(), '') = 'authenticated' then
    raise exception 'not authorised' using errcode = '42501';
  end if;

  select decrypted_secret into v_service_key
  from vault.decrypted_secrets
  where name = 'planning_service_role_key'
  limit 1;
  if v_service_key is null then
    raise warning 'run_job_plan_tick: vault secret planning_service_role_key not set';
    return;
  end if;

  perform net.http_post(
    url := 'https://neksyvneljgxvpchwgch.supabase.co/functions/v1/job-plan-tick',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_service_key,
      'apikey', v_service_key
    ),
    body := jsonb_build_object('initiated_by', 'pg_cron'),
    timeout_milliseconds := 120000
  );
end $$;

revoke all on function public.run_job_plan_tick() from public, anon, authenticated;
grant execute on function public.run_job_plan_tick() to service_role;

-- 05:45 UTC: after the BM-derived nightlies and the Companies House window.
do $$ begin perform cron.unschedule('job-plan-tick'); exception when others then null; end $$;
select cron.schedule('job-plan-tick', '45 5 * * *', $$select public.run_job_plan_tick()$$);

insert into public.scheduled_job_docs
  (job_key, source, title, category, purpose, data_source, mechanism, run_as, gate_label, sort_order)
values
('job-plan-tick', 'pg_cron',
 'Job plan nightly tick',
 'Work',
 'For every committed job plan: marks stages done from the BrightManager status ladder and from BM rows leaving the export, shifts the stages still ahead when a gate has slipped (the one-month records-to-meeting rule and the statutory buffers apply), and records each plan''s risk — slipped, waiting on client, at risk, urgent. Then, if armed, nudges the preparer of any accounts job a month past its year end with no committed plan, from the configured mailbox, once per job per cadence.',
 'job_plans, job_milestones, bm_task_schedule, v_accounts_jobs.',
 'Automatic. pg_cron calls the job-plan-tick edge function at 05:45 UTC as service_role.',
 'service_role via Vault (planning_service_role_key). Nudges leave from the configured Gmail mailbox.',
 'job_plan_settings.nudges_armed', 35)
on conflict (job_key) do update set
  title = excluded.title, category = excluded.category, purpose = excluded.purpose,
  data_source = excluded.data_source, mechanism = excluded.mechanism, run_as = excluded.run_as,
  gate_label = excluded.gate_label, sort_order = excluded.sort_order, updated_at = now();

insert into public.scheduled_job_settings
  (job_key, setting_key, label, help, value_type, target_table, target_column, id_kind, touch_updated_at, min_value, max_value, risk, risk_note, sort_order)
values
('job-plan-tick', 'nudges_armed',
 'Nudge preparers about unplanned jobs',
 'Stages are marked done and dates shifted either way. This switch decides whether a preparer gets an email about an accounts job a month past its year end with no committed plan.',
 'boolean', 'job_plan_settings', 'nudges_armed', 'bool_true', true, null, null,
 'internal', 'Emails team members from the configured mailbox.', 10),
('job-plan-tick', 'nudge_every_days',
 'Days between nudges for the same job',
 'A job is nudged again after this many days if it is still unplanned.',
 'int', 'job_plan_settings', 'nudge_every_days', 'bool_true', true, 1, 60,
 'internal', null, 20),
('job-plan-tick', 'nudge_mailbox',
 'Mailbox the nudge leaves from',
 'A connected Gmail address (Communications). Leave blank for the practice default. Set it to the practice director''s address so the nudge reads as a note from them.',
 'text', 'job_plan_settings', 'nudge_mailbox', 'bool_true', true, null, null,
 'internal', null, 30)
on conflict (job_key, setting_key) do update set
  label = excluded.label, help = excluded.help, value_type = excluded.value_type,
  target_table = excluded.target_table, target_column = excluded.target_column,
  id_kind = excluded.id_kind, min_value = excluded.min_value, max_value = excluded.max_value,
  risk = excluded.risk, risk_note = excluded.risk_note, sort_order = excluded.sort_order;
