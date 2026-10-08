-- Onboarding list: Park, Log call, Email (templates), Comms timeline, and
-- reading client replies for the things we asked for.
--
-- 1. Park. parked_at on the onboarding sinks it to the bottom of the list and
--    the chaser skips it. Not a status: a parked onboarding is still active,
--    it just isn't being worked this week.
-- 2. Calls. onboarding_activity gains kind 'call', so a logged call sits on
--    the same timeline as the emails.
-- 3. Emails. Three onboarding templates in comm_templates (comm_type
--    'onboarding'), sent through the sender's Gmail by the onboarding-actions
--    edge function, which logs the email on the client (client_communications)
--    and links the activity row to it (communication_id).
-- 4. Reply reading. onboarding-reply-scan reads each new inbound email for a
--    client with an open onboarding and records what it appears to provide
--    against the open client steps (a UTR, an agent code...). A finding is a
--    suggestion for a person to accept or dismiss — it never ticks a step on
--    its own. Until it is dealt with, the email modal flags the item so we
--    don't ask the client again for something they have already sent.
--
-- All writes go through edge functions running as service_role; the browser
-- only reads the new tables.

-- ── 1. Park ────────────────────────────────────────────────────────────────
alter table public.onboardings
  add column if not exists parked_at timestamptz,
  add column if not exists parked_by uuid references public.staff_profiles(id),
  add column if not exists parked_note text;

-- ── 2. Calls + link from activity to the email it records ─────────────────
alter table public.onboarding_activity
  drop constraint if exists onboarding_activity_kind_check;
alter table public.onboarding_activity
  add constraint onboarding_activity_kind_check
  check (kind = any (array['note', 'status_change', 'system', 'email_out', 'client_reply', 'call']));

alter table public.onboarding_activity
  add column if not exists communication_id uuid
    references public.client_communications(id) on delete set null;

-- ── 3. Templates ──────────────────────────────────────────────────────────
alter table public.comm_templates
  drop constraint if exists comm_templates_kind_check;
alter table public.comm_templates
  add constraint comm_templates_kind_check
  check (kind = any (array[
    'promo', 'reminder', 'no_utr', 'records_request', 'gap_request', 'records_chase',
    'meeting_invite', 'approval_chase', 'meeting_proposal',
    'ob_request', 'ob_follow_up', 'ob_final_chase'
  ]));

insert into public.comm_types (id, label, description, active)
values ('onboarding', 'Onboarding emails',
        'What we need to finish setting a new client up, follow-ups and a final chase — sent by hand from the onboarding list.', true)
on conflict (id) do nothing;

insert into public.comm_templates (comm_type, kind, subject, body_text, body_html)
values
('onboarding', 'ob_request',
 '{{client_name}} – what we need to get you set up',
 E'Hi {{greeting}},\n\n{{opener}}To finish getting {{client_name}} set up with us, we just need the following from you:\n\n{{items}}\n\nYou can reply to this email with them, or upload anything to your portal: {{portal_url}}\n\nIf anything is unclear, just let me know and I''ll talk you through it.\n\n{{signoff}}',
 ''),
('onboarding', 'ob_follow_up',
 '{{client_name}} – a quick follow-up',
 E'Hi {{greeting}},\n\n{{opener}}Just following up on getting {{client_name}} set up. We''re still waiting on:\n\n{{items}}\n\nIf it''s easier, reply with whatever you have and we''ll chase the rest from there. Your portal shows where everything is up to: {{portal_url}}\n\n{{signoff}}',
 ''),
('onboarding', 'ob_final_chase',
 '{{client_name}} – still need a few things from you',
 E'Hi {{greeting}},\n\n{{opener}}We''ve not been able to finish setting up {{client_name}} because we''re still missing:\n\n{{items}}\n\nWithout these we can''t act for you with HMRC, so deadlines could be missed. Could you send them over this week, or give me a call if anything is holding you up?\n\n{{signoff}}',
 '')
on conflict (comm_type, kind) do nothing;

-- ── 4. Reply findings ─────────────────────────────────────────────────────
create table if not exists public.onboarding_reply_scans (
  communication_id uuid primary key references public.client_communications(id) on delete cascade,
  onboarding_id uuid not null references public.onboardings(id) on delete cascade,
  scanned_at timestamptz not null default now(),
  findings integer not null default 0,
  error text
);

create table if not exists public.onboarding_reply_findings (
  id uuid primary key default gen_random_uuid(),
  onboarding_id uuid not null references public.onboardings(id) on delete cascade,
  communication_id uuid not null references public.client_communications(id) on delete cascade,
  step_id uuid references public.onboarding_steps(id) on delete cascade,
  item_label text not null,
  found_value text,
  evidence text,
  confidence text not null default 'medium' check (confidence in ('high', 'medium', 'low')),
  status text not null default 'suggested' check (status in ('suggested', 'accepted', 'dismissed')),
  reviewed_by uuid references public.staff_profiles(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists onboarding_reply_findings_ob_idx
  on public.onboarding_reply_findings (onboarding_id, status);

alter table public.onboarding_reply_scans enable row level security;
alter table public.onboarding_reply_findings enable row level security;

drop policy if exists onboarding_reply_scans_staff_read on public.onboarding_reply_scans;
create policy onboarding_reply_scans_staff_read on public.onboarding_reply_scans
  for select to authenticated using (is_active_staff());
drop policy if exists onboarding_reply_findings_staff_read on public.onboarding_reply_findings;
create policy onboarding_reply_findings_staff_read on public.onboarding_reply_findings
  for select to authenticated using (is_active_staff());

-- Read-only to the browser: accept/dismiss go through onboarding-actions.
revoke all on public.onboarding_reply_scans from public, anon, authenticated;
revoke all on public.onboarding_reply_findings from public, anon, authenticated;
grant select on public.onboarding_reply_scans to authenticated;
grant select on public.onboarding_reply_findings to authenticated;
grant all on public.onboarding_reply_scans to service_role;
grant all on public.onboarding_reply_findings to service_role;

-- ── Schedule: every 15 minutes, five minutes after the mailbox ingest ─────
alter table public.onboarding_chase_config
  add column if not exists reply_read_enabled boolean not null default true;

create or replace function public.run_onboarding_reply_scan()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare cfg onboarding_chase_config%rowtype;
begin
  select * into cfg from onboarding_chase_config where id = true;
  if cfg is null or not cfg.reply_read_enabled then
    return;
  end if;
  perform net.http_post(
    url := 'https://neksyvneljgxvpchwgch.supabase.co/functions/v1/onboarding-reply-scan',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', cfg.cron_secret),
    body := jsonb_build_object()
  );
end;
$$;
revoke all on function public.run_onboarding_reply_scan() from public, anon, authenticated;
grant execute on function public.run_onboarding_reply_scan() to service_role;

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
    when 'onboarding-reply-scan' then
      select reply_read_enabled into v from onboarding_chase_config where id;
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
('onboarding-reply-scan', 'pg_cron',
 'Onboarding reply reader',
 'Client data ingest',
 'Reads each new email from a client with an open onboarding and notes anything it appears to send that we asked for (a UTR, an agent code, ID). Each one waits on the onboarding for a person to accept or dismiss, and the onboarding email flags it so we don''t ask again for something already sent. It never ticks a step itself.',
 'Inbound client emails already ingested into client_communications, and the open client steps on the onboarding.',
 'Automatic, every 15 minutes. pg_cron calls the onboarding-reply-scan edge function, which uses Claude to read the email.',
 'System — reads stored email, sends nothing.',
 'onboarding_chase_config.reply_read_enabled', 16)
on conflict (job_key) do update set
  title = excluded.title, category = excluded.category, purpose = excluded.purpose,
  data_source = excluded.data_source, mechanism = excluded.mechanism,
  run_as = excluded.run_as, gate_label = excluded.gate_label, sort_order = excluded.sort_order;

insert into public.scheduled_job_settings
  (job_key, setting_key, label, help, value_type, target_table, target_column,
   id_kind, touch_updated_at, min_value, max_value, risk, risk_note, sort_order)
values
('onboarding-reply-scan', 'reply_read_enabled', 'Read client replies',
 'Off means replies are still logged, but nobody is told what was in them.',
 'boolean', 'onboarding_chase_config', 'reply_read_enabled', 'bool_true', true, null, null, 'internal', null, 10)
on conflict (job_key, setting_key) do update set
  label = excluded.label, help = excluded.help, value_type = excluded.value_type,
  target_table = excluded.target_table, target_column = excluded.target_column,
  id_kind = excluded.id_kind, touch_updated_at = excluded.touch_updated_at,
  min_value = excluded.min_value, max_value = excluded.max_value,
  risk = excluded.risk, risk_note = excluded.risk_note, sort_order = excluded.sort_order;

select cron.schedule('onboarding-reply-scan', '5-59/15 * * * *', $$select public.run_onboarding_reply_scan()$$);
