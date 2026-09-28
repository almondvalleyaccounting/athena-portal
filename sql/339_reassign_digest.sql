-- ============================================================
-- 339 — Wednesday email to info@: reassignments to make in BrightManager
--
-- A reassignment in Athena (job-plan reassign_bm_job, sql/330; or the
-- capacity planner) lands on the Admin Task List as an allocation_changes
-- draft, but nobody is told. Bobby (2026-09-28): send info@ a weekly list of
-- everything still to move, on a Wednesday. The reassign-digest edge function
-- builds it from the same two sources the Admin Task List uses — allocation
-- drafts, and one-off task overrides that BM hasn't caught up with.
--
-- Same shape as sql/274: config singleton (cron_secret belongs to
-- service_role only), a self-gating cron wrapper, the Scheduled Jobs page
-- entry, and the schedule. ARMED: Bobby asked for it to send.
-- ============================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

create table if not exists public.reassign_digest_config (
  id               boolean primary key default true check (id),
  weekly_enabled   boolean not null default true,   -- the cron self-gate
  sending_enabled  boolean not null default true,   -- asked for as a real send
  skip_when_empty  boolean not null default true,   -- no email on a week with nothing to move
  recipient_emails text[] not null default array['info@almondvalleyaccounting.co.uk'],
  cron_secret      text not null default (replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')),
  last_sent_on     date,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

comment on table public.reassign_digest_config is
  'Singleton config for the Wednesday "reassignments to make in BrightManager" email to info@. '
  'Read and written by service_role; the Scheduled Jobs page reaches the switches through its definer RPCs.';

insert into public.reassign_digest_config (id) values (true) on conflict do nothing;

alter table public.reassign_digest_config enable row level security;
revoke all on public.reassign_digest_config from public, anon, authenticated;
grant select, insert, update on public.reassign_digest_config to service_role;

create or replace function public.run_reassign_digest()
returns void
language plpgsql
security definer
set search_path = public, net, extensions
as $$
declare cfg public.reassign_digest_config%rowtype;
begin
  select * into cfg from public.reassign_digest_config where id = true;
  if cfg is null or not cfg.weekly_enabled then
    return;
  end if;
  perform net.http_post(
    url     := 'https://neksyvneljgxvpchwgch.supabase.co/functions/v1/reassign-digest',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', cfg.cron_secret),
    body    := jsonb_build_object('dry_run', false)
  );
end;
$$;

revoke all on function public.run_reassign_digest() from public, anon, authenticated;
grant execute on function public.run_reassign_digest() to service_role;

-- The gate the Scheduled Jobs page reads: the live sql/274 body plus one case.
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
    else
      v := null;
  end case;
  return v;
end;
$$;

-- Not re-granted to authenticated (sql/239); see the note in sql/274.
revoke execute on function public.scheduled_job_gate(text) from public, anon, authenticated;
grant execute on function public.scheduled_job_gate(text) to service_role;

insert into public.scheduled_job_docs
  (job_key, source, title, category, purpose, data_source, mechanism, run_as, gate_label, sort_order)
values
('reassign-digest', 'pg_cron',
 'Reassignments to make in BrightManager',
 'Internal digests & alerts',
 'The Wednesday email to info@ listing every job moved to someone else in Athena that BrightManager still shows with the old owner: service moves from the Admin Task List, and single tasks reassigned one-off. Quiet on a week with nothing to move.',
 'The Admin Task List''s reallocation drafts (allocation_changes) and one-off task reassignments (bm_task_schedule overrides), against what the latest BrightManager import shows.',
 'Automatic, Wednesdays at 08:00 UTC. pg_cron calls the reassign-digest edge function, which sends through the practice mailbox.',
 'System — sends from the practice automation mailbox.',
 'reassign_digest_config.weekly_enabled (and sending_enabled)', 39)
on conflict (job_key) do update set
  title = excluded.title, category = excluded.category, purpose = excluded.purpose,
  data_source = excluded.data_source, mechanism = excluded.mechanism,
  run_as = excluded.run_as, gate_label = excluded.gate_label, sort_order = excluded.sort_order;

insert into public.scheduled_job_settings
  (job_key, setting_key, label, help, value_type, target_table, target_column,
   id_kind, touch_updated_at, min_value, max_value, risk, risk_note, sort_order)
values
('reassign-digest', 'weekly_enabled',
 'Run the weekly check',
 'Off means the job still fires but returns immediately.',
 'boolean', 'reassign_digest_config', 'weekly_enabled', 'bool_true', true, null, null,
 'internal', null, 10),
('reassign-digest', 'sending_enabled',
 'Email info@',
 'Off means the check still runs but the email is held.',
 'boolean', 'reassign_digest_config', 'sending_enabled', 'bool_true', true, null, null,
 'internal', 'Goes to info@ only.', 20),
('reassign-digest', 'skip_when_empty',
 'Stay quiet when nothing needs moving',
 'On means no email on a week with nothing to reassign.',
 'boolean', 'reassign_digest_config', 'skip_when_empty', 'bool_true', true, null, null,
 'internal', null, 30)
on conflict (job_key, setting_key) do update set
  label = excluded.label, help = excluded.help, value_type = excluded.value_type,
  target_table = excluded.target_table, target_column = excluded.target_column,
  id_kind = excluded.id_kind, touch_updated_at = excluded.touch_updated_at,
  risk = excluded.risk, risk_note = excluded.risk_note, sort_order = excluded.sort_order;

-- Wednesdays 08:00 UTC (09:00 in summer, 08:00 in winter).
select cron.schedule('reassign-digest', '0 8 * * 3', $$select public.run_reassign_digest()$$);
