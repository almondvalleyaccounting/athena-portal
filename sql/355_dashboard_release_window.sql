-- 355_dashboard_release_window.sql
--
-- A client sees their figures only between dates WE have released.
--
-- QuickBooks is live, so the client dashboard shows whatever is posted —
-- including a half-done October that nobody has reviewed. The release window
-- is the control: per client, either
--
--   mode = 'window'  figures dated release_from .. release_to only
--   mode = 'all'     everything the dashboard can reach (the 62-month clamp
--                    in portal-dashboard still applies)
--
-- THE SYSTEM NEVER MOVES IT. The defaults are computed ONCE, when the row is
-- created (here for existing grants, by trigger for new ones), and then stay
-- put until a person changes them. Releasing October is a decision, not a
-- calendar event — a window that rolled forward by itself would publish
-- unchecked numbers on the first of every month, which is the thing this exists
-- to stop.
--
-- Defaults at creation:
--   release_from = 1 January, six calendar years back (five full years plus the
--                  current one): 2020-01-01 during 2026, 2021-01-01 from 2027.
--   release_to   = the last day of the previous month.
--
-- Per client, not per person: every login at the client sees the same released
-- figures. Enforced server-side in portal-dashboard; this table only stores it.
--
-- Writes go through the dashboard-release edge function (can_manage_portal),
-- which can also email the client that new figures are available. The browser
-- may read (staff only) and never write.

create table if not exists public.dashboard_release_window (
  entity_id     uuid primary key references public.entities(id) on delete cascade,
  mode          text not null default 'window' check (mode in ('window', 'all')),
  release_from  date not null,
  release_to    date not null,
  updated_by    uuid,
  updated_at    timestamptz not null default now(),
  last_notified_at timestamptz,
  constraint dashboard_release_window_order check (release_from <= release_to)
);

-- One row per change, so "when did we release September, and did we tell them?"
-- has an answer.
create table if not exists public.dashboard_release_log (
  id            uuid primary key default gen_random_uuid(),
  entity_id     uuid not null references public.entities(id) on delete cascade,
  mode          text not null,
  release_from  date not null,
  release_to    date not null,
  notified_to   text[] not null default '{}',
  changed_by    uuid,
  changed_at    timestamptz not null default now()
);
create index if not exists dashboard_release_log_entity_idx
  on public.dashboard_release_log (entity_id, changed_at desc);

alter table public.dashboard_release_window enable row level security;
alter table public.dashboard_release_log enable row level security;

drop policy if exists dashboard_release_window_read on public.dashboard_release_window;
create policy dashboard_release_window_read on public.dashboard_release_window
  for select to authenticated using (public.is_active_staff());
drop policy if exists dashboard_release_log_read on public.dashboard_release_log;
create policy dashboard_release_log_read on public.dashboard_release_log
  for select to authenticated using (public.is_active_staff());

revoke all on public.dashboard_release_window from anon, authenticated;
revoke all on public.dashboard_release_log from anon, authenticated;
grant select on public.dashboard_release_window to authenticated;
grant select on public.dashboard_release_log to authenticated;
grant all on public.dashboard_release_window to service_role;
grant all on public.dashboard_release_log to service_role;

-- The defaults, in one place. Not a column DEFAULT: those would be evaluated per
-- insert, which is right, but the trigger and the backfill both need them and a
-- function keeps the rule written once.
create or replace function public.dashboard_release_defaults(p_today date default current_date)
returns table (release_from date, release_to date)
language sql
immutable
set search_path = public
as $$
  select make_date(extract(year from p_today)::int - 6, 1, 1),
         (date_trunc('month', p_today) - interval '1 day')::date;
$$;
revoke execute on function public.dashboard_release_defaults(date) from public, anon;
grant execute on function public.dashboard_release_defaults(date) to authenticated, service_role;

-- A new grant on a client with no window creates one with today's defaults.
-- Definer, because the person granting access cannot write this table.
create or replace function public.dashboard_release_seed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.dashboard_release_window (entity_id, release_from, release_to, updated_by)
  select new.entity_id, d.release_from, d.release_to, new.granted_by
  from public.dashboard_release_defaults(current_date) d
  on conflict (entity_id) do nothing;
  return new;
end;
$$;
revoke execute on function public.dashboard_release_seed() from public, anon, authenticated;

drop trigger if exists trg_dashboard_release_seed on public.client_dashboard_access;
create trigger trg_dashboard_release_seed
  after insert on public.client_dashboard_access
  for each row execute function public.dashboard_release_seed();

-- Every client that already has a grant gets today's defaults: released up to
-- the end of last month. Clients who could see the current month until now
-- stop seeing it until somebody releases it — deliberately, since nobody has
-- checked it.
insert into public.dashboard_release_window (entity_id, release_from, release_to)
select distinct a.entity_id, d.release_from, d.release_to
from public.client_dashboard_access a
cross join public.dashboard_release_defaults(current_date) d
on conflict (entity_id) do nothing;
