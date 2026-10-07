-- 350_priority_email.sql
--
-- The Monday priorities email, and delay reports that tell the manager
-- (Bobby, 2026-10-07).
--
-- After the Monday "Team Deadlines" digest (11:00 UTC), each person with a
-- Priority column (sql/349) gets an email from Athena: their jobs due for
-- internal review in the next two weeks, in board order, then the next few,
-- with anything that can't make its safe date at the top. It's a briefing,
-- not a questionnaire: no reply is expected. Each job carries one link,
-- "Report a delay or I'm stuck", which opens Athena with the progress update
-- pre-filled (signed-in staff only; no link writes anything by itself).
--
-- A Delayed (amber) or Stuck (red) progress update is a report: it emails the
-- people in priority_email_config.report_recipient_ids straight away (plus the
-- bell) and stays open on the Priority board until marked dealt with. Each
-- report is its own row with a status, so an agent can later take it on as a
-- task (through an edge function, never as staff or service_role).
--
-- "Update due" (sql/349: no update for 14 days) is retired: silence means on
-- track. Its two settings columns go.
--
-- Built UNARMED: weekly_enabled and sending_enabled are false. Test sends to
-- one address work regardless.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ── Reports: an amber/red progress update is open until dealt with ─────────
alter table public.job_progress_updates
  add column if not exists status          text check (status in ('open', 'dealt_with')),
  add column if not exists dealt_with_by   uuid references public.staff_profiles(id) on delete set null,
  add column if not exists dealt_with_at   timestamptz,
  add column if not exists dealt_with_note text check (dealt_with_note is null or char_length(dealt_with_note) <= 2000);
comment on column public.job_progress_updates.status is
  'Delay/stuck reports only (amber/red): open until someone marks it dealt with. Null for on-track updates.';
update public.job_progress_updates set status = 'open' where confidence in ('amber', 'red') and status is null;
create index if not exists job_progress_updates_open_idx on public.job_progress_updates (created_at desc) where status = 'open';

alter table public.job_plan_settings
  drop column if exists progress_stale_days,
  drop column if exists progress_window_days;

-- ── Config ──────────────────────────────────────────────────────────────────
create table if not exists public.priority_email_config (
  id                   boolean primary key default true check (id),
  weekly_enabled       boolean not null default false,  -- the cron self-gate
  sending_enabled      boolean not null default false,  -- real sends to the team
  report_emails_enabled boolean not null default true,  -- email the recipients on each delay/stuck report
  window_days          integer not null default 14 check (window_days between 1 and 60),
  upcoming_count       integer not null default 5 check (upcoming_count between 0 and 30),
  report_recipient_ids uuid[] not null default '{}',
  cron_secret          text not null default (replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')),
  last_sent_on         date,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
comment on table public.priority_email_config is
  'Singleton config for the Monday priorities email (priority-email edge fn) and who is told about delay/stuck reports. service_role only; the Scheduled Jobs page reaches the switches through its definer RPCs.';

-- Delay reports go to the manager who asked for them (Bobby), not to every
-- can_manage_portal holder. Add people to the array to widen it.
insert into public.priority_email_config (id, report_recipient_ids)
select true, coalesce(array_agg(id), '{}') from public.staff_profiles
where is_active and lower(email) = 'bobby@almondvalleyaccounting.co.uk'
on conflict (id) do nothing;

alter table public.priority_email_config enable row level security;
revoke all on public.priority_email_config from public, anon, authenticated;
grant select, insert, update on public.priority_email_config to service_role;

-- ── Cron wrapper ────────────────────────────────────────────────────────────
create or replace function public.run_priority_email()
returns void
language plpgsql
security definer
set search_path = public, net, extensions
as $$
declare cfg public.priority_email_config%rowtype;
begin
  select * into cfg from public.priority_email_config where id = true;
  if cfg is null or not cfg.weekly_enabled then
    return;
  end if;
  perform net.http_post(
    url     := 'https://neksyvneljgxvpchwgch.supabase.co/functions/v1/priority-email',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', cfg.cron_secret),
    body    := jsonb_build_object('dry_run', false),
    timeout_milliseconds := 60000
  );
end;
$$;
revoke all on function public.run_priority_email() from public, anon, authenticated;
grant execute on function public.run_priority_email() to service_role;

-- ── Scheduled Jobs page: gate (live body + one case), docs, settings ────────
create or replace function public.scheduled_job_gate(p_key text)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare v boolean;
begin
  case p_key
    when 'onboarding-weekly' then
      select weekly_enabled into v from onboarding_chase_config where id;
    when 'onboarding-checkin' then
      select checkin_auto_send_enabled into v from onboarding_chase_config where id;
    when 'chase-reply-scan' then
      select reply_scan_enabled into v from onboarding_chase_config where id;
    when 'comms-ingest' then
      select comms_ingest_enabled into v from onboarding_chase_config where id;
    when 'ch-code-weekly' then
      select weekly_enabled into v from ch_code_chase_config where id;
    when 'ch-code-calls' then
      select calls_email_enabled into v from ch_code_chase_config where id;
    when 'ch-code-queue-fill' then
      select auto_queue_enabled into v from ch_code_chase_config where id;
    when 'deadline-digest' then
      select weekly_enabled into v from deadline_digest_config where id;
    when 'notification-sweep' then
      select (sweep_enabled or digest_enabled) into v from notification_config where id;
    when 'ch-refresh-nightly' then
      select refresh_enabled into v from ch_refresh_config where id;
    when 'ch-refresh-report' then
      select report_enabled into v from ch_refresh_config where id;
    when 'reminders-autoqueue' then
      select enabled into v from reminder_autoqueue_config where id;
    when 'bug-review-digest' then
      select enabled into v from bug_review_config where id;
    when 'bk-drift-tick' then
      select nudges_armed into v from bk_drift_settings where id = 1;
    when 'ch-accounts-due' then
      select (daily_enabled and sending_enabled) into v from ch_accounts_due_config where id;
    when 'reassign-digest' then
      select (weekly_enabled and sending_enabled) into v from reassign_digest_config where id;
    when 'priority-email' then
      select (weekly_enabled and sending_enabled) into v from priority_email_config where id;
    else
      v := null;
  end case;
  return v;
end;
$$;
revoke execute on function public.scheduled_job_gate(text) from public, anon, authenticated;
grant execute on function public.scheduled_job_gate(text) to service_role;

insert into public.scheduled_job_docs
  (job_key, source, title, category, purpose, data_source, mechanism, run_as, gate_label, sort_order)
values
('priority-email', 'pg_cron',
 'Monday priorities email (per person)',
 'Internal digests & alerts',
 'After Team Deadlines, each person with a Priority column gets their own list: jobs due for internal review in the next two weeks in board order, the next few after that, and anything that can''t make its safe date. No reply is expected; each job has a "Report a delay or I''m stuck" link into Athena, and a report emails the manager straight away.',
 'The Priority board (job_priority order, capacity queue, saved internal review dates on job_milestones).',
 'Automatic, Mondays at 11:15 UTC. pg_cron calls the priority-email edge function, which sends through the practice mailbox.',
 'System — sends from the practice automation mailbox.',
 'priority_email_config.weekly_enabled (and sending_enabled)', 40)
on conflict (job_key) do update set
  title = excluded.title, category = excluded.category, purpose = excluded.purpose,
  data_source = excluded.data_source, mechanism = excluded.mechanism,
  run_as = excluded.run_as, gate_label = excluded.gate_label, sort_order = excluded.sort_order;

insert into public.scheduled_job_settings
  (job_key, setting_key, label, help, value_type, target_table, target_column,
   id_kind, touch_updated_at, min_value, max_value, risk, risk_note, sort_order)
values
('priority-email', 'weekly_enabled', 'Run on Mondays',
 'Off means the job still fires but returns immediately.',
 'boolean', 'priority_email_config', 'weekly_enabled', 'bool_true', true, null, null, 'internal', null, 10),
('priority-email', 'sending_enabled', 'Email the team',
 'Off means nothing goes to the team. A test to one address still works.',
 'boolean', 'priority_email_config', 'sending_enabled', 'bool_true', true, null, null, 'internal', 'Goes to every person with a Priority column (staff only).', 20),
('priority-email', 'report_emails_enabled', 'Email delay and stuck reports straight away',
 'Off means reports still go on the Priority board and the bell, without an email.',
 'boolean', 'priority_email_config', 'report_emails_enabled', 'bool_true', true, null, null, 'internal', null, 30),
('priority-email', 'window_days', 'Days ahead to list',
 'Jobs with an internal review date within this many days are listed first.',
 'int', 'priority_email_config', 'window_days', 'bool_true', true, 1, 60, 'internal', null, 40),
('priority-email', 'upcoming_count', 'Jobs after that to show',
 'How many of the next jobs in the column to show under "Coming up".',
 'int', 'priority_email_config', 'upcoming_count', 'bool_true', true, 0, 30, 'internal', null, 50)
on conflict (job_key, setting_key) do update set
  label = excluded.label, help = excluded.help, value_type = excluded.value_type,
  target_table = excluded.target_table, target_column = excluded.target_column,
  id_kind = excluded.id_kind, touch_updated_at = excluded.touch_updated_at,
  min_value = excluded.min_value, max_value = excluded.max_value,
  risk = excluded.risk, risk_note = excluded.risk_note, sort_order = excluded.sort_order;

-- Mondays 11:15 UTC, a quarter of an hour after Team Deadlines (11:00).
select cron.schedule('priority-email', '15 11 * * 1', $$select public.run_priority_email()$$);
