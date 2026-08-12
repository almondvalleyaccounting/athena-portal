-- 223_scheduled_jobs_registry.sql
--
-- Scheduled Jobs registry — one place that answers "what runs on a timer,
-- when does it run next, where does its data come from, and is it armed?"
--
-- Two halves:
--   1. scheduled_job_docs — the plain-English description of each job. Keyed
--      on cron.job.jobname for pg_cron jobs, or a slug for things scheduled
--      outside the database (Claude Code scheduled tasks on a staff machine).
--      This table is the seam for step 2: settings that Claude reads back.
--   2. list_scheduled_jobs() — joins the docs to the LIVE cron.job rows, the
--      last run from cron.job_run_details, and the config switch that actually
--      arms each job. cron.* is not exposed to PostgREST, hence the definer.
--
-- Gate vs cron_active: a job can be scheduled and firing every night while its
-- config switch is off, in which case the SQL wrapper returns immediately and
-- nothing happens. Both states are surfaced separately — "armed" is the one
-- that tells you whether work is being done.

create table if not exists public.scheduled_job_docs (
  job_key           text primary key,
  source            text not null default 'pg_cron'
                      check (source in ('pg_cron', 'external')),
  title             text not null,
  category          text not null,
  purpose           text not null,   -- what it does, one or two sentences
  data_source       text not null,   -- where the data comes from
  mechanism         text not null,   -- how it gets it (API, edge function, login)
  run_as            text,            -- the identity/login it runs under
  gate_label        text,            -- human note on the config switch
  external_cron     text,            -- cron expr for non-pg_cron entries
  external_schedule text,            -- human schedule where there is no cron expr
  sort_order        int not null default 100,
  updated_at        timestamptz not null default now(),
  updated_by        uuid references public.staff_profiles(id)
);

comment on table public.scheduled_job_docs is
  'Plain-English documentation for every scheduled job. job_key matches cron.job.jobname for pg_cron jobs.';

alter table public.scheduled_job_docs enable row level security;

drop policy if exists scheduled_job_docs_read on public.scheduled_job_docs;
create policy scheduled_job_docs_read on public.scheduled_job_docs
  for select to authenticated
  using (public.is_active_staff());

drop policy if exists scheduled_job_docs_write on public.scheduled_job_docs;
create policy scheduled_job_docs_write on public.scheduled_job_docs
  for update to authenticated
  using (exists (
    select 1 from public.staff_profiles
    where id = auth.uid() and is_active and can_manage_portal
  ))
  with check (exists (
    select 1 from public.staff_profiles
    where id = auth.uid() and is_active and can_manage_portal
  ));

revoke all on public.scheduled_job_docs from public, anon;
grant select, update on public.scheduled_job_docs to authenticated;

-- ── The config switch behind each job ────────────────────────────────────
-- Returns null where a job has no switch (it always does its work).
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
    else
      v := null;
  end case;
  return v;
end;
$$;

revoke all on function public.scheduled_job_gate(text) from public, anon;
grant execute on function public.scheduled_job_gate(text) to authenticated, service_role;

-- ── The list the admin page reads ────────────────────────────────────────
create or replace function public.list_scheduled_jobs()
returns table (
  job_key           text,
  source            text,
  title             text,
  category          text,
  purpose           text,
  data_source       text,
  mechanism         text,
  run_as            text,
  gate_label        text,
  cron_expression   text,
  external_schedule text,
  cron_active       boolean,
  gate_enabled      boolean,
  command           text,
  sort_order        int,
  last_run_at       timestamptz,
  last_run_status   text,
  last_run_message  text,
  documented        boolean
)
language plpgsql
stable
security definer
set search_path = public, cron, hmrc
as $$
begin
  if not exists (
    select 1 from public.staff_profiles
    where id = auth.uid() and is_active and can_manage_portal
  ) then
    raise exception 'not authorised';
  end if;

  return query
  -- Live pg_cron jobs, described where we have a doc row.
  select
    j.jobname::text,
    'pg_cron'::text,
    coalesce(d.title, j.jobname)::text,
    coalesce(d.category, 'Undocumented')::text,
    coalesce(d.purpose, '')::text,
    coalesce(d.data_source, '')::text,
    coalesce(d.mechanism, '')::text,
    d.run_as,
    d.gate_label,
    j.schedule::text,
    null::text,
    j.active,
    public.scheduled_job_gate(j.jobname),
    j.command::text,
    coalesce(d.sort_order, 900),
    r.ran_at,
    r.status::text,
    left(r.return_message, 300),
    (d.job_key is not null)
  from cron.job j
  left join public.scheduled_job_docs d
    on d.job_key = j.jobname and d.source = 'pg_cron'
  left join lateral (
    select coalesce(x.end_time, x.start_time) as ran_at, x.status, x.return_message
    from cron.job_run_details x
    where x.jobid = j.jobid
    order by x.runid desc
    limit 1
  ) r on true

  union all

  -- Scheduled outside the database (Claude Code tasks on a staff machine).
  select
    d.job_key,
    d.source,
    d.title,
    d.category,
    d.purpose,
    d.data_source,
    d.mechanism,
    d.run_as,
    d.gate_label,
    d.external_cron,
    d.external_schedule,
    true,
    null::boolean,
    null::text,
    d.sort_order,
    case d.job_key
      when 'hmrc-monthly-scrape' then (select max(started_at) from hmrc.run)
      else null
    end,
    null::text,
    null::text,
    true
  from public.scheduled_job_docs d
  where d.source = 'external';
end;
$$;

revoke all on function public.list_scheduled_jobs() from public, anon;
grant execute on function public.list_scheduled_jobs() to authenticated, service_role;

-- ── Seed: one row per job that exists today ──────────────────────────────
insert into public.scheduled_job_docs
  (job_key, source, title, category, purpose, data_source, mechanism, run_as, gate_label, external_cron, external_schedule, sort_order)
values

-- Client data ingest ------------------------------------------------------
('ch-refresh-nightly', 'pg_cron',
 'Companies House nightly refresh',
 'Client data ingest',
 'Re-reads every client company at Companies House in small chunks through the night — officers, status, accounts and confirmation-statement dates — and updates the entity record. This is what keeps year-ends, filing deadlines and "who are the officers" current without anyone looking anything up.',
 'Companies House public register (REST API).',
 'Automatic. pg_cron calls the ch-ingest-officers edge function every 5 minutes between 01:00 and 03:59 UTC; each call takes the next slice of companies so no single run times out.',
 'Athena''s own Companies House API key — no user login involved.',
 'ch_refresh_config.refresh_enabled', null, null, 10),

('ch-refresh-report', 'pg_cron',
 'Companies House refresh report',
 'Client data ingest',
 'Summarises what last night''s Companies House refresh changed and emails portal admins. Rewritten to errors-only in Aug 2026, so a silent morning means it worked.',
 'The results of the overnight refresh, already in Athena.',
 'Automatic. pg_cron calls the ch-refresh-report edge function, which emails from the practice default mailbox.',
 'System — sends from the practice automation mailbox.',
 'ch_refresh_config.report_enabled', null, null, 11),

('qbo-pull-nightly', 'pg_cron',
 'Client QuickBooks nightly pull',
 'Client data ingest',
 'Refreshes the cached figures behind the QBO Client Dashboard and the bookkeeping-drift watch — P&L, balance sheet and bank-reconciliation position for every client company we are connected to.',
 'Clients'' own QuickBooks Online companies (about 120 realms).',
 'Automatic. pg_cron calls the qbo-pull edge function, which loops the connected realms using each realm''s stored OAuth refresh token.',
 'The practice Intuit account — each client granted access once at connection time; no per-run sign-in.',
 null, null, null, 12),

('planning-qbo-nightly-pull', 'pg_cron',
 'Practice QuickBooks pull (Planning)',
 'Client data ingest',
 'Pulls Almond Valley''s OWN monthly numbers — P&L and balance sheet — into the Planning module so the baseline, pricing and cash pages are looking at real actuals rather than typed figures.',
 'Almond Valley Accounting''s own QuickBooks company.',
 'Automatic. pg_cron calls the planning-qbo-pull edge function using the project URL and service key held in Supabase Vault, and logs each attempt to plan_qbo_sync_runs.',
 'The practice Intuit account (our own books).',
 null, null, null, 13),

('comms-ingest', 'pg_cron',
 'Mailbox ingest',
 'Client data ingest',
 'Pulls new email out of the connected mailboxes and files it against the right client, which is what fills the Communications tab on a client page and lets chasers know they have had a reply.',
 'The connected Gmail mailboxes — info@, accounts@ and bobby@.',
 'Automatic, four times an hour. pg_cron calls the comms-ingest edge function in incremental mode; it reads each mailbox through the Gmail API.',
 'Per-mailbox Google OAuth grants held in gmail_connections — each mailbox owner authorised it once.',
 'onboarding_chase_config.comms_ingest_enabled', null, null, 14),

('chase-reply-scan', 'pg_cron',
 'Chase reply scan',
 'Client data ingest',
 'Looks through incoming mail for replies to onboarding and Companies House chases and closes the chase off, so nobody gets chased for something they have already sent.',
 'The same ingested mailbox traffic as the mailbox ingest job.',
 'Automatic, every 15 minutes. pg_cron calls the chase-reply-scan edge function.',
 'System — reads the connected mailboxes, sends nothing.',
 'onboarding_chase_config.reply_scan_enabled', null, null, 15),

-- Client-facing automation -----------------------------------------------
('onboarding-checkin', 'pg_cron',
 'Onboarding check-in emails',
 'Client-facing automation',
 'Sends the scheduled check-in email to clients partway through onboarding — the "how are you getting on" nudge tied to where they have reached in the portal.',
 'Onboarding records and portal progress in Athena.',
 'Automatic, daily at 08:00 UTC. pg_cron calls the onboarding-checkin edge function, which sends through the practice mailbox.',
 'System — sends from the practice automation mailbox.',
 'onboarding_chase_config.checkin_auto_send_enabled', null, null, 20),

('ch-code-queue-fill', 'pg_cron',
 'Companies House code chase queue',
 'Client-facing automation',
 'Builds the queue of authentication-code chase emails for clients whose Companies House code we still do not hold. Queueing is separate from sending on purpose.',
 'Companies House code status per client, held in Athena.',
 'Automatic, weekday mornings at 07:00 UTC. pg_cron calls the ch-code-queue-fill edge function.',
 'System — queues only. Actual sending is a second switch (ch_code_chase_config.sending_enabled), currently OFF, so nothing leaves the building.',
 'ch_code_chase_config.auto_queue_enabled', null, null, 21),

('reminders-autoqueue', 'pg_cron',
 'Client tax reminders auto-queue',
 'Client-facing automation',
 'Queues the self-assessment reminder run — opt-in emails, then UTR and payment details — but only during January and July, the two months those reminders matter.',
 'Client reminder preferences and tax records in Athena.',
 'Automatic, every 15 minutes during January and July only. pg_cron calls the reminders-autoqueue edge function.',
 'System — sends from the practice automation mailbox.',
 'reminder_autoqueue_config.enabled', null, null, 22),

-- Internal digests and alerts --------------------------------------------
('deadline-digest', 'pg_cron',
 'Monday deadline digest',
 'Internal digests & alerts',
 'The Monday morning email to the whole team: Companies House accounts deadlines and self-assessment run-rate, with what is due and what is slipping.',
 'Athena''s deadline and task data, originally imported from BrightManager.',
 'Automatic, Mondays at 07:30 UTC. pg_cron calls the deadline-digest edge function; recipients come from deadline_digest_config.recipient_ids (all 10 staff).',
 'System — sends from the practice automation mailbox.',
 'deadline_digest_config.weekly_enabled', null, null, 30),

('notification-sweep', 'pg_cron',
 'Notification sweep',
 'Internal digests & alerts',
 'Works out what each person has waiting for them and fills the in-app bell. The matching "N things for you" email was switched off in Aug 2026 — the bell keeps filling.',
 'Open work, tasks and approvals across Athena.',
 'Automatic, weekday mornings at 07:30 UTC. pg_cron calls the notification-sweep edge function.',
 'System — writes in-app notifications; email digest disabled.',
 'notification_config.sweep_enabled (email: digest_enabled, currently off)', null, null, 31),

('onboarding-weekly', 'pg_cron',
 'Onboarding weekly digest',
 'Internal digests & alerts',
 'Monday summary of where every client in onboarding has got to and what is stuck, to three named people rather than the whole team.',
 'The onboarding pipeline in Athena.',
 'Automatic, Mondays at 09:00 UTC. pg_cron calls the onboarding-weekly edge function.',
 'System — recipients from onboarding_chase_config.weekly_recipient_ids.',
 'onboarding_chase_config.weekly_enabled', null, null, 32),

('ch-code-weekly', 'pg_cron',
 'Companies House code weekly digest',
 'Internal digests & alerts',
 'Monday summary of outstanding Companies House authentication codes and how the chases are going.',
 'Companies House code status and chase history in Athena.',
 'Automatic, Mondays at 09:00 UTC. pg_cron calls the ch-code-weekly edge function.',
 'System — recipients from ch_code_chase_config.weekly_recipient_ids.',
 'ch_code_chase_config.weekly_enabled', null, null, 33),

('ch-code-calls', 'pg_cron',
 'Companies House code call list',
 'Internal digests & alerts',
 'Wednesday call list for the clients whose Companies House code chase has gone quiet — goes to the call assignee only.',
 'Chase history in Athena.',
 'Automatic, Wednesdays at 08:00 UTC. pg_cron calls the ch-code-calls edge function.',
 'System — sends to the named call assignee.',
 'ch_code_chase_config.calls_email_enabled', null, null, 34),

('athena-reminder-fri', 'pg_cron',
 'Athena reminder (Friday)',
 'Internal digests & alerts',
 'End-of-week personal nudge listing what is still open in Athena. Goes to Bobby only.',
 'Open items across Athena.',
 'Automatic, Fridays at 14:00 UTC. pg_cron calls the athena-reminder edge function with moment=friday.',
 'System — single recipient.',
 null, null, null, 35),

('athena-reminder-sun', 'pg_cron',
 'Athena reminder (Sunday)',
 'Internal digests & alerts',
 'Week-ahead version of the same personal nudge. Goes to Bobby only.',
 'Open items across Athena.',
 'Automatic, Sundays at 18:00 UTC. pg_cron calls the athena-reminder edge function with moment=sunday.',
 'System — single recipient.',
 null, null, null, 36),

('bug-review-digest', 'pg_cron',
 'Weekly bug review',
 'Internal digests & alerts',
 'Friday round-up of the Bug Reports board — new to triage, accepted for this week, fixed awaiting verification. In-app notifications only; it sends no email despite the name.',
 'The bugs table in Athena.',
 'Automatic, Fridays at 13:00 UTC. Runs entirely in SQL and writes notifications to everyone holding can_triage_bugs.',
 'System — in-app only.',
 'bug_review_config.enabled', null, null, 37),

-- Control checks ----------------------------------------------------------
('journal-recon-monthly', 'pg_cron',
 'Journal control check — start',
 'Control checks',
 'Starts the monthly check that BrightPay''s payroll journals actually landed in each client''s QuickBooks, and landed once. Sets the window to the last four complete months and processes the first batch of clients.',
 'Clients'' QuickBooks Online journals, compared against what BrightPay says it posted.',
 'Automatic, 10th of the month at 06:00 UTC. pg_cron works through the connected realms in batches of 15.',
 'The practice Intuit account, using each client''s stored QBO connection.',
 null, null, null, 40),

('journal-recon-continue', 'pg_cron',
 'Journal control check — continue',
 'Control checks',
 'Picks the run back up every 5 minutes until every client realm has been checked. Does nothing if there is no run in progress.',
 'Same as the start job.',
 'Automatic, every 5 minutes 06:00–09:59 UTC on the 10th.',
 'The practice Intuit account.',
 null, null, null, 41),

('journal-recon-digest', 'pg_cron',
 'Journal control check — digest',
 'Control checks',
 'Reports what the month''s reconciliation found — missing journals, duplicates and mismatches — once the sweep has finished.',
 'The completed reconciliation run in Athena.',
 'Automatic, 10th of the month at 10:00 UTC. pg_cron calls the journal-recon-digest edge function using Vault-held credentials.',
 'System.',
 null, null, null, 42),

('bk-drift-nightly', 'pg_cron',
 'Bookkeeping drift — start',
 'Control checks',
 'Starts the nightly snapshot of how far behind each client''s books are: what date the bank is reconciled to and how far past our tolerance that is, split by whether we do the bookkeeping or they do.',
 'Clients'' QuickBooks Online — bank reconciliation position per company.',
 'Automatic, daily at 05:00 UTC, in batches of 12 realms.',
 'The practice Intuit account, using each client''s stored QBO connection.',
 null, null, null, 43),

('bk-drift-continue', 'pg_cron',
 'Bookkeeping drift — continue',
 'Control checks',
 'Continues the drift sweep every 5 minutes until all realms are snapshotted. Does nothing if there is no run in progress.',
 'Same as the start job.',
 'Automatic, every 5 minutes 05:00–07:59 UTC.',
 'The practice Intuit account.',
 null, null, null, 44),

('bk-drift-tick', 'pg_cron',
 'Bookkeeping drift — cases & nudges',
 'Control checks',
 'Turns the morning''s drift snapshot into cases: opens one where a client has breached tolerance, closes it when they catch up, escalates the ones that sit. The client/staff nudges are built but deliberately not armed yet.',
 'The drift snapshots taken earlier the same morning.',
 'Automatic, daily at 07:30 UTC, entirely in SQL.',
 'System.',
 'bk_drift_settings.nudges_armed — OFF, so cases are tracked but no one is nudged', null, null, 45),

-- Housekeeping ------------------------------------------------------------
('planning-qbo-sync-reconcile', 'pg_cron',
 'QBO sync response reconcile',
 'Housekeeping',
 'Plumbing. The QuickBooks pulls fire off asynchronously, so this matches each HTTP response back onto its run record and marks it success or error. Nothing user-facing.',
 'pg_net''s response table inside Athena''s own database.',
 'Automatic, every minute, entirely in SQL.',
 'System.',
 null, null, null, 90),

-- Scheduled outside the database -----------------------------------------
('hmrc-monthly-scrape', 'external',
 'HMRC agent-services scrape',
 'Client data ingest',
 'Walks the HMRC agent services client list and refreshes what HMRC says we owe them — PAYE and Corporation Tax positions, charges, payments, credits and authorisation gaps — into the private hmrc schema behind the HMRC module. The same tool drains Athena''s per-client refresh queue when someone presses Refresh in the UI.',
 'HMRC agent services online (screen scrape — there is no API for this; the official API route is scoped but parked).',
 'Claude Code scheduled task on Bobby''s machine, monthly. It cannot run fully unattended: it prompts Bobby to sign in first, because HMRC needs a Government Gateway session plus an access code from a second device. Once signed in it walks the whole client list on its own.',
 'Bobby''s HMRC agent services login (Government Gateway + 2FA).',
 'No config switch in Athena — the task is enabled in Claude Code''s scheduler.',
 '0 10 14 * *', 'Monthly, 14th at 10:00', 16)

on conflict (job_key) do update set
  source            = excluded.source,
  title             = excluded.title,
  category          = excluded.category,
  purpose           = excluded.purpose,
  data_source       = excluded.data_source,
  mechanism         = excluded.mechanism,
  run_as            = excluded.run_as,
  gate_label        = excluded.gate_label,
  external_cron     = excluded.external_cron,
  external_schedule = excluded.external_schedule,
  sort_order        = excluded.sort_order,
  updated_at        = now();
