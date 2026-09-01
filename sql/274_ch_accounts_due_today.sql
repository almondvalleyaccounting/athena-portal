-- ============================================================
-- Accounts due at Companies House TODAY — the daily team email.
--
-- The question is "what must be filed at Companies House today", and the only
-- answer that can be trusted at 8am is the one Companies House itself gave us
-- overnight. NOT the BrightManager import: a BM export that is two days stale
-- would have us emailing the whole team about a deadline that has moved, or
-- silently missing one that has arrived. So this reads what the nightly CH
-- refresh wrote, and nothing else.
--
-- Three pieces:
--   1. The nightly refresh (ch-ingest-officers, v12) now writes the ACCOUNTS
--      due date the same way it has always written the confirmation-statement
--      one — a `deadlines` row tagged 'CH Accounts', updated in place. The tag
--      already existed in the enum and had never been used.
--   2. v_ch_accounts_due — who still has accounts to file, as CH sees it.
--   3. ch_accounts_due_config + run_ch_accounts_due(), the daily 07:00 send.
--
-- Scope, as asked: prospects are IN (a prospect on the register has the same
-- deadline and we may well be the ones filing it), former clients are OUT
-- (nlac/archived — the read-time rule, sql/134). Dissolved and in-liquidation
-- companies are out too: there is nothing left to file.
--
-- Nothing has to be ticked off. Once the accounts are filed, CH rolls
-- `accounts.next_due` to next year and the row leaves the window on the next
-- overnight run — the same self-clearing property as sql/266.
--
-- WEEKENDS. Companies House does not move a deadline that lands on a Saturday;
-- it is still due that Saturday. Nobody is here to file it. So the email is
-- sent on the last working day BEFORE a non-working day and covers everything
-- due between then and the next working day: Friday's email carries Friday,
-- Saturday and Sunday. Bank holidays work the same way when
-- bank_holiday_shift is on, so the Thursday before Easter carries through to
-- the Tuesday. Nothing is sent on a day nobody is working.
-- ============================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ── 1. What is still to file, as Companies House sees it ─────────────────
-- security_invoker = true: the deadlines staff-read policy (sql/266) does the
-- gating, and this view cannot become a way round it.
drop view if exists public.v_ch_accounts_due;
create view public.v_ch_accounts_due
with (security_invoker = true) as
select
  d.id                                    as deadline_id,
  e.id                                    as entity_id,
  e.name                                  as entity_name,
  e.company_number,
  e.company_status,
  e.company_status_detail,
  e.entity_status::text                   as entity_status,
  e.manager,
  d.title,                                -- 'Accounts to 31 March 2025'
  d.due_date,
  (current_date - d.due_date)             as days_late,   -- negative = days to go
  (d.due_date < current_date)             as overdue,
  e.ch_last_refreshed_at
from public.deadlines d
join public.entities e on e.id = d.entity_id
where d.tag = 'CH Accounts'
  and d.status <> 'complete'
  -- Former clients are excluded at read time on every operational surface.
  -- Prospects are deliberately NOT excluded.
  and coalesce(e.entity_status::text, 'active') not in ('nlac', 'archived')
  -- Dissolved or in liquidation: there are no accounts left to file.
  and coalesce(e.company_status, 'active') not in ('dissolved', 'liquidation');

comment on view public.v_ch_accounts_due is
  'Companies House accounts filing deadlines still outstanding, from the nightly CH '
  'refresh (not BrightManager). Prospects included; former clients, dissolved and '
  'in-liquidation companies excluded. A filed set of accounts drops off on the next '
  'overnight run — there is nothing to tick off by hand.';

revoke all on public.v_ch_accounts_due from public, anon;
grant select on public.v_ch_accounts_due to authenticated, service_role;

-- ── 2. Config ────────────────────────────────────────────────────────────
-- No grants to authenticated at all. The Scheduled Jobs page reads and writes
-- these switches through scheduled_job_setting_values() /
-- set_scheduled_job_setting(), which are SECURITY DEFINER and gated on
-- can_manage_schedules(). cron_secret is a credential: it belongs to
-- service_role, not to eleven staff browsers.
create table if not exists public.ch_accounts_due_config (
  id                   boolean primary key default true check (id),
  daily_enabled        boolean not null default true,   -- the cron self-gate
  sending_enabled      boolean not null default false,  -- gate for real team-wide sends
  skip_when_empty      boolean not null default true,   -- silence on a clear day
  bank_holiday_shift   boolean not null default true,   -- pull forward over bank holidays too
  cron_secret          text not null default (replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')),
  recipient_ids        uuid[],                          -- null/empty = every active staff member
  last_sent_on         date,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

comment on table public.ch_accounts_due_config is
  'Singleton config for the daily "accounts due at Companies House today" email. '
  'recipient_ids null = whole active team, so a new joiner is covered without an edit. '
  'sending_enabled=false blocks real sends (test_recipient still allowed).';

insert into public.ch_accounts_due_config (id) values (true) on conflict do nothing;

alter table public.ch_accounts_due_config enable row level security;
revoke all on public.ch_accounts_due_config from public, anon, authenticated;
grant select, insert, update on public.ch_accounts_due_config to service_role;

-- ── 3. The cron wrapper ──────────────────────────────────────────────────
create or replace function public.run_ch_accounts_due()
returns void
language plpgsql
security definer
set search_path = public, net, extensions
as $$
declare cfg public.ch_accounts_due_config%rowtype;
begin
  select * into cfg from public.ch_accounts_due_config where id = true;
  if cfg is null or not cfg.daily_enabled then
    return;
  end if;
  perform net.http_post(
    url     := 'https://neksyvneljgxvpchwgch.supabase.co/functions/v1/ch-accounts-due',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', cfg.cron_secret),
    body    := jsonb_build_object('dry_run', false)
  );
end;
$$;

revoke all on function public.run_ch_accounts_due() from public, anon, authenticated;
grant execute on function public.run_ch_accounts_due() to service_role;

-- ── 4. The gate the Scheduled Jobs page reads ────────────────────────────
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
    else
      v := null;
  end case;
  return v;
end;
$$;

-- The grant line from sql/223 is deliberately NOT reproduced here. sql/239 took
-- EXECUTE off `authenticated` — a portal client could otherwise call this and
-- read the switches — and replacing the function must not quietly hand it back.
-- The Scheduled Jobs page reaches it through list_scheduled_jobs(), which is
-- SECURITY DEFINER and gated on can_manage_portal, so nothing loses access.
revoke execute on function public.scheduled_job_gate(text) from public, anon, authenticated;
grant execute on function public.scheduled_job_gate(text) to service_role;

-- ── 5. Say what it is on the Scheduled Jobs page ─────────────────────────
insert into public.scheduled_job_docs
  (job_key, source, title, category, purpose, data_source, mechanism, run_as, gate_label, sort_order)
values
('ch-accounts-due', 'pg_cron',
 'Accounts due at Companies House today',
 'Internal digests & alerts',
 'The morning email to the whole team listing every client whose accounts are due at Companies House that day. A deadline that falls on a Saturday or Sunday is carried on the Friday email instead, because Companies House does not move it and nobody is here at the weekend to file it. Silent on a day with nothing due.',
 'Companies House itself, via last night''s refresh — deliberately NOT the BrightManager import, which can be days stale and would have us emailing about deadlines that have moved.',
 'Automatic, weekday mornings at 07:00 UTC. pg_cron calls the ch-accounts-due edge function, which sends through the practice mailbox.',
 'System — sends from the practice automation mailbox.',
 'ch_accounts_due_config.daily_enabled (and sending_enabled)', 38)
on conflict (job_key) do update set
  title = excluded.title, category = excluded.category, purpose = excluded.purpose,
  data_source = excluded.data_source, mechanism = excluded.mechanism,
  run_as = excluded.run_as, gate_label = excluded.gate_label, sort_order = excluded.sort_order;

insert into public.scheduled_job_settings
  (job_key, setting_key, label, help, value_type, target_table, target_column,
   id_kind, touch_updated_at, min_value, max_value, risk, risk_note, sort_order)
values
('ch-accounts-due', 'daily_enabled',
 'Run the daily check',
 'Off means the job still fires but returns immediately — nobody is told what is due today.',
 'boolean', 'ch_accounts_due_config', 'daily_enabled', 'bool_true', true, null, null,
 'internal', null, 10),

('ch-accounts-due', 'sending_enabled',
 'Email the team',
 'Off means the check still runs but the email is held. Use it to stop the whole team being written to without disarming the job.',
 'boolean', 'ch_accounts_due_config', 'sending_enabled', 'bool_true', true, null, null,
 'internal', 'Goes to every active staff member.', 20),

('ch-accounts-due', 'skip_when_empty',
 'Stay quiet when nothing is due',
 'On means no email at all on a clear day. Off sends a "nothing due today" note every morning.',
 'boolean', 'ch_accounts_due_config', 'skip_when_empty', 'bool_true', true, null, null,
 'internal', null, 30),

('ch-accounts-due', 'bank_holiday_shift',
 'Carry bank holidays forward too',
 'On means the Thursday before Easter also carries Good Friday and the Monday. Off applies the rule to weekends only.',
 'boolean', 'ch_accounts_due_config', 'bank_holiday_shift', 'bool_true', true, null, null,
 'internal', null, 40)
on conflict (job_key, setting_key) do update set
  label = excluded.label, help = excluded.help, value_type = excluded.value_type,
  target_table = excluded.target_table, target_column = excluded.target_column,
  id_kind = excluded.id_kind, touch_updated_at = excluded.touch_updated_at,
  risk = excluded.risk, risk_note = excluded.risk_note, sort_order = excluded.sort_order;

-- ── 6. Schedule (DISARMED) ───────────────────────────────────────────────
-- Weekday mornings at 07:00 UTC — after the CH refresh window (01:00–03:59)
-- and before the 07:30 sweeps. run_ch_accounts_due() self-gates on
-- daily_enabled, so it is safe to leave scheduled. ARM ONLY AFTER:
--   (a) ch-ingest-officers v12 has run and CH Accounts rows exist,
--   (b) a test_recipient run looks right,
--   (c) sending_enabled = true. Then:
--   select cron.schedule('ch-accounts-due', '0 7 * * 1-5', $$select run_ch_accounts_due()$$);
