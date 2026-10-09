-- ============================================================
-- 364 — Email send controls + outbox (undo send, send later)
--
-- After a team member emailed the whole client base from Gmail (2026-10-09),
-- Bobby asked for controls on mail sent from Athena:
--   1. warn when one email goes to more than one client;
--   2. warn when a client's email is forwarded/replied to someone else;
--   3. a hard cap on outside recipients per email — an Athena admin setting
--      (app_settings 'email_max_external_recipients', default 5);
--   4. undo send.
-- And separately: "send later" — drafting at night without it reaching
-- clients until a set time.
--
-- 4 and send-later share one mechanism: every email from the composer goes
-- into comms_outbox with a send_at. Undo = send_at 20s out (the tab sends it
-- at 20s; this cron is the fallback if the tab closed). Send later = send_at
-- at the chosen time. The comms-outbox-run edge function, called every minute
-- by pg_cron, sends whatever is due.
--
-- Checks 1-3 live in the comms-gmail edge function (server-side, so the
-- screen can't skip them). This file gives it the recipient → client lookup.
-- ============================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ── The cap (Athena admin setting) ──────────────────────────────────
insert into public.app_settings (setting_key, setting_value, description)
values ('email_max_external_recipients', '5'::jsonb,
        'Most recipients outside the firm (To + Cc + Bcc) one email sent from Athena may have. Bulk mail goes through Client Tax Reminders.')
on conflict (setting_key) do nothing;

-- ── Recipient → client lookup ───────────────────────────────────────
-- The same sources comms-ingest matches on (people via entity_people,
-- entity billing/prospect emails, QBO billing emails, the BM contact). One
-- address can belong to several entities (a director and their companies).
-- Plain invoker SQL; only service_role (the edge functions) may run it.
create or replace function public.comms_recipient_entities(p_emails text[])
returns table (email text, entity_id uuid, entity_name text)
language sql
stable
set search_path = public
as $$
  with wanted as (
    select distinct lower(trim(e)) as email from unnest(p_emails) e where coalesce(trim(e), '') <> ''
  ),
  pairs as (
    select lower(trim(p.email)) as email, ep.entity_id
      from entity_people ep join people p on p.id = ep.person_id
     where p.email is not null
    union
    select lower(trim(billing_email)), id from entities where billing_email is not null
    union
    select lower(trim(prospect_email)), id from entities where prospect_email is not null
    union
    select lower(trim(x)), q.entity_id
      from qbo_customer_mappings q, regexp_split_to_table(q.qbo_email, '[,;]+') x
     where q.qbo_email is not null and q.entity_id is not null
    union
    select lower(trim(bm_contact_email)), entity_id from v_email_reconciliation where bm_contact_email is not null
  )
  select w.email, pr.entity_id, en.name
    from wanted w
    join pairs pr on pr.email = w.email
    join entities en on en.id = pr.entity_id;
$$;

revoke execute on function public.comms_recipient_entities(text[]) from public, anon, authenticated;
grant execute on function public.comms_recipient_entities(text[]) to service_role;

-- ── The outbox ──────────────────────────────────────────────────────
create table if not exists public.comms_outbox (
  id            uuid primary key default gen_random_uuid(),
  staff_id      uuid not null references public.staff_profiles(id),
  mailbox       text not null,                 -- lower(account_email) it leaves from
  payload       jsonb not null,                -- to, cc, bcc, subject, bodyText, bodyHtml, threadId, inReplyTo, references
  subject       text not null default '',      -- for the Scheduled list
  to_summary    text not null default '',
  send_at       timestamptz not null,
  kind          text not null default 'undo' check (kind in ('undo', 'later')),
  status        text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'cancelled', 'failed')),
  warnings      jsonb not null default '[]',    -- what the sender was warned about and sent anyway
  error         text,
  gmail_message_id text,
  gmail_thread_id  text,
  created_at    timestamptz not null default now(),
  claimed_at    timestamptz,
  sent_at       timestamptz
);
create index if not exists comms_outbox_due_idx on public.comms_outbox (send_at) where status = 'queued';
create index if not exists comms_outbox_staff_idx on public.comms_outbox (staff_id, status);

comment on table public.comms_outbox is
  'Emails waiting to send: the 20s undo window and Send later. Written only by the comms-gmail / comms-outbox-run edge functions (service_role); staff read their own.';

alter table public.comms_outbox enable row level security;
revoke all on public.comms_outbox from public, anon, authenticated;
grant select on public.comms_outbox to authenticated;
grant select, insert, update on public.comms_outbox to service_role;
drop policy if exists "Staff read their own outbox" on public.comms_outbox;
create policy "Staff read their own outbox" on public.comms_outbox
  for select to authenticated using (staff_id = auth.uid() and is_active_staff());

-- ── The sender job ──────────────────────────────────────────────────
create table if not exists public.comms_outbox_config (
  id          boolean primary key default true check (id),
  enabled     boolean not null default true,
  cron_secret text not null default (replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')),
  updated_at  timestamptz not null default now()
);
comment on table public.comms_outbox_config is
  'Singleton for the every-minute outbox sender. service_role only.';
insert into public.comms_outbox_config (id) values (true) on conflict do nothing;
alter table public.comms_outbox_config enable row level security;
revoke all on public.comms_outbox_config from public, anon, authenticated;
grant select, insert, update on public.comms_outbox_config to service_role;

create or replace function public.run_comms_outbox()
returns void
language plpgsql
security definer
set search_path = public, net, extensions
as $$
declare cfg public.comms_outbox_config%rowtype;
begin
  select * into cfg from public.comms_outbox_config where id = true;
  if cfg is null or not cfg.enabled then return; end if;
  -- Nothing due: don't wake the edge function.
  if not exists (select 1 from public.comms_outbox where status = 'queued' and send_at <= now()) then
    return;
  end if;
  perform net.http_post(
    url     := 'https://neksyvneljgxvpchwgch.supabase.co/functions/v1/comms-outbox-run',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', cfg.cron_secret),
    body    := '{}'::jsonb
  );
end;
$$;
revoke all on function public.run_comms_outbox() from public, anon, authenticated;
grant execute on function public.run_comms_outbox() to service_role;

-- The gate the Scheduled Jobs page reads: the live sql/359 body plus one case.
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
    when 'comms-outbox' then
      select enabled into v from comms_outbox_config where id;
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
('comms-outbox', 'pg_cron',
 'Email outbox (undo send + send later)',
 'Internal digests & alerts',
 'Sends emails written in Athena once they are due: the 20-second undo window (normally sent by the open tab — this catches a tab closed in time) and emails scheduled with Send later.',
 'comms_outbox rows that are queued and due.',
 'Every minute. pg_cron calls the comms-outbox-run edge function only when something is due; it sends each email from the mailbox it was written in.',
 'Each email sends as the person who wrote it, from their mailbox.',
 'comms_outbox_config.enabled', 41)
on conflict (job_key) do update set
  title = excluded.title, category = excluded.category, purpose = excluded.purpose,
  data_source = excluded.data_source, mechanism = excluded.mechanism,
  run_as = excluded.run_as, gate_label = excluded.gate_label, sort_order = excluded.sort_order;

insert into public.scheduled_job_settings
  (job_key, setting_key, label, help, value_type, target_table, target_column,
   id_kind, touch_updated_at, min_value, max_value, risk, risk_note, sort_order)
values
('comms-outbox', 'enabled',
 'Send due emails',
 'Off holds every scheduled email in the outbox until it is turned back on.',
 'boolean', 'comms_outbox_config', 'enabled', 'bool_true', true, null, null,
 'client_facing', 'Scheduled emails go to clients.', 10)
on conflict (job_key, setting_key) do update set
  label = excluded.label, help = excluded.help, value_type = excluded.value_type,
  target_table = excluded.target_table, target_column = excluded.target_column,
  id_kind = excluded.id_kind, touch_updated_at = excluded.touch_updated_at,
  risk = excluded.risk, risk_note = excluded.risk_note, sort_order = excluded.sort_order;

select cron.unschedule('comms-outbox') where exists (select 1 from cron.job where jobname = 'comms-outbox');
select cron.schedule('comms-outbox', '* * * * *', $$select public.run_comms_outbox()$$);
