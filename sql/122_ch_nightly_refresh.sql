-- 122: Companies House nightly refresh — status tracking, run log, cron.
--
-- Adds CH company status to entities, records status CHANGES (feeds the
-- Triage Board + morning email), logs refresh runs, and schedules:
--   * every 5 min between 01:00–03:55 UTC: refresh the ~35 stalest limited
--     companies (skips anything refreshed <20h ago, so the book completes
--     overnight and finished nights no-op),
--   * 06:00 UTC: the morning confirmation email (ch-refresh-report).

alter table public.entities
  add column if not exists company_status text,
  add column if not exists company_status_detail text,
  add column if not exists ch_last_refreshed_at timestamptz;

comment on column public.entities.company_status is
  'Companies House company_status (active, dissolved, liquidation, ...). Refreshed nightly by ch-ingest-officers.';
comment on column public.entities.company_status_detail is
  'Companies House company_status_detail (e.g. active-proposal-to-strike-off).';

-- Status-change log: one row per observed change, consumed by the Triage
-- Board and the morning email.
create table if not exists public.ch_status_events (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.entities(id) on delete cascade,
  old_status text,
  new_status text,
  old_detail text,
  new_detail text,
  detected_at timestamptz not null default now(),
  run_date date,
  notified_at timestamptz,
  triage_case_id uuid
);
create index if not exists ch_status_events_detected_idx on public.ch_status_events(detected_at desc);
alter table public.ch_status_events enable row level security;
drop policy if exists "Staff can view CH status events" on public.ch_status_events;
create policy "Staff can view CH status events"
  on public.ch_status_events for select using (is_active_staff());

-- One row per night; each 5-min chunk increments it.
create table if not exists public.ch_refresh_runs (
  run_date date primary key,
  started_at timestamptz not null default now(),
  last_chunk_at timestamptz,
  chunks int not null default 0,
  processed int not null default 0,
  status_changes int not null default 0,
  errors jsonb not null default '[]'::jsonb,
  warnings jsonb not null default '[]'::jsonb,
  reported_at timestamptz
);
alter table public.ch_refresh_runs enable row level security;
drop policy if exists "Staff can view CH refresh runs" on public.ch_refresh_runs;
create policy "Staff can view CH refresh runs"
  on public.ch_refresh_runs for select using (is_active_staff());

-- Singleton config (mirrors deadline_digest_config): the cron secret gates
-- unattended invocations; recipients default to portal admins when null.
create table if not exists public.ch_refresh_config (
  id boolean primary key default true check (id),
  refresh_enabled boolean not null default true,
  report_enabled boolean not null default true,
  cron_secret text not null default encode(gen_random_bytes(24), 'hex'),
  recipient_ids uuid[],
  test_recipient text
);
alter table public.ch_refresh_config enable row level security;
drop policy if exists "Portal admins view ch refresh config" on public.ch_refresh_config;
create policy "Portal admins view ch refresh config"
  on public.ch_refresh_config for select
  using (exists (select 1 from public.staff_profiles sp where sp.id = auth.uid() and sp.is_active and sp.is_portal_admin));
insert into public.ch_refresh_config (id) values (true) on conflict (id) do nothing;

create extension if not exists pg_cron;
create extension if not exists pg_net;

create or replace function public.run_ch_refresh_chunk()
returns void
language plpgsql
security definer
set search_path = public, net, extensions
as $$
declare
  cfg ch_refresh_config%rowtype;
begin
  select * into cfg from ch_refresh_config where id;
  if cfg is null or not cfg.refresh_enabled then return; end if;
  perform net.http_post(
    url := 'https://neksyvneljgxvpchwgch.supabase.co/functions/v1/ch-ingest-officers',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', cfg.cron_secret),
    body := jsonb_build_object('mode', 'nightly'),
    timeout_milliseconds := 120000
  );
end $$;

create or replace function public.run_ch_refresh_report()
returns void
language plpgsql
security definer
set search_path = public, net, extensions
as $$
declare
  cfg ch_refresh_config%rowtype;
begin
  select * into cfg from ch_refresh_config where id;
  if cfg is null or not cfg.report_enabled then return; end if;
  perform net.http_post(
    url := 'https://neksyvneljgxvpchwgch.supabase.co/functions/v1/ch-refresh-report',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', cfg.cron_secret),
    body := jsonb_build_object('dry_run', false),
    timeout_milliseconds := 60000
  );
end $$;

-- Reschedule idempotently.
do $$ begin perform cron.unschedule('ch-refresh-nightly'); exception when others then null; end $$;
do $$ begin perform cron.unschedule('ch-refresh-report'); exception when others then null; end $$;
-- 01:00–03:55 UTC (02:00–04:55 UK summer), every 5 minutes.
select cron.schedule('ch-refresh-nightly', '*/5 1-3 * * *', $$select public.run_ch_refresh_chunk()$$);
-- 06:00 UTC (07:00 UK summer) morning confirmation email.
select cron.schedule('ch-refresh-report', '0 6 * * *', $$select public.run_ch_refresh_report()$$);
