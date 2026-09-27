-- ============================================================
-- 333 — Payroll tab: the team's BrightPay checklists, in Athena
--
-- Replaces two spreadsheets (weekly and monthly payroll checklists) from
-- October 2026 (month 7 / tax week 27 of 2026/27). One row per payroll
-- client, one column per step, one sheet per tax week or tax month. Pay
-- date, cut-off, runner, pay type and the standing note are held once per
-- client instead of retyped each period. Every tick records who and when.
--
--   payroll_clients       the payroll client list and its once-per-client facts
--   payroll_periods       tax weeks and tax months, 2023/24 to 2027/28
--   payroll_ticks         one row per (client, period, step): done or n/a, by whom, when
--   payroll_period_notes  a note for one client in one period
--   payroll_journal_status(period)  the one live column: has the BrightPay journal
--                         been seen in the client's QuickBooks (journal_month_coverage)
--
-- Reads: active staff. Writes: service_role only, through payroll-tracker.
-- ============================================================

create table if not exists public.payroll_clients (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  entity_id     uuid references public.entities(id) on delete set null,
  employer_id   bigint,
  realm_id      text,
  frequency     text not null check (frequency in ('weekly', 'monthly', 'eps_only')),
  pay_day       text,
  cutoff        text,
  pay_type      text check (pay_type in ('fixed', 'variable', 'entry')),
  runner_id     uuid references public.staff_profiles(id) on delete set null,
  runner_name   text,
  cover_id      uuid references public.staff_profiles(id) on delete set null,
  batch         boolean not null default false,
  na_steps      text[] not null default '{}',
  standing_note text,
  active        boolean not null default true,
  ceased_on     date,
  sort_order    integer,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  updated_by    uuid references public.staff_profiles(id) on delete set null
);
create index if not exists payroll_clients_entity_idx on public.payroll_clients (entity_id);

create table if not exists public.payroll_periods (
  id         uuid primary key default gen_random_uuid(),
  frequency  text not null check (frequency in ('weekly', 'monthly')),
  tax_year   text not null,
  number     integer not null,
  start_date date not null,
  end_date   date not null,
  unique (frequency, tax_year, number)
);

create table if not exists public.payroll_ticks (
  client_id uuid not null references public.payroll_clients(id) on delete cascade,
  period_id uuid not null references public.payroll_periods(id) on delete cascade,
  step      text not null check (step in ('approval', 'hours', 'processed', 'fps', 'payslips', 'modulr', 'pension', 'eps')),
  state     text not null check (state in ('done', 'na')),
  by_id     uuid references public.staff_profiles(id) on delete set null,
  by_name   text,
  at        timestamptz not null default now(),
  source    text not null default 'athena',
  primary key (client_id, period_id, step)
);
create index if not exists payroll_ticks_period_idx on public.payroll_ticks (period_id);

create table if not exists public.payroll_period_notes (
  id        uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.payroll_clients(id) on delete cascade,
  period_id uuid not null references public.payroll_periods(id) on delete cascade,
  note      text not null,
  by_id     uuid references public.staff_profiles(id) on delete set null,
  by_name   text,
  at        timestamptz not null default now(),
  source    text not null default 'athena'
);
create index if not exists payroll_period_notes_idx on public.payroll_period_notes (client_id, period_id);

alter table public.payroll_clients      enable row level security;
alter table public.payroll_periods      enable row level security;
alter table public.payroll_ticks        enable row level security;
alter table public.payroll_period_notes enable row level security;

drop policy if exists payroll_clients_read on public.payroll_clients;
create policy payroll_clients_read on public.payroll_clients for select using (public.is_active_staff());
drop policy if exists payroll_periods_read on public.payroll_periods;
create policy payroll_periods_read on public.payroll_periods for select using (public.is_active_staff());
drop policy if exists payroll_ticks_read on public.payroll_ticks;
create policy payroll_ticks_read on public.payroll_ticks for select using (public.is_active_staff());
drop policy if exists payroll_period_notes_read on public.payroll_period_notes;
create policy payroll_period_notes_read on public.payroll_period_notes for select using (public.is_active_staff());

revoke all on public.payroll_clients, public.payroll_periods, public.payroll_ticks, public.payroll_period_notes from public, anon;
grant select on public.payroll_clients, public.payroll_periods, public.payroll_ticks, public.payroll_period_notes to authenticated;
grant all on public.payroll_clients, public.payroll_periods, public.payroll_ticks, public.payroll_period_notes to service_role;

-- Tax weeks and tax months. Week 1 starts 6 April; a year has 53 weeks when
-- 6 April + 52 weeks still falls inside it. Month n runs 6th to 5th.
insert into public.payroll_periods (frequency, tax_year, number, start_date, end_date)
select 'weekly', format('%s/%s', y, to_char(mod(y + 1, 100), 'FM00')), w,
       make_date(y, 4, 6) + (w - 1) * 7,
       least(make_date(y, 4, 6) + (w - 1) * 7 + 6, make_date(y + 1, 4, 5))
from generate_series(2023, 2027) y, generate_series(1, 53) w
where make_date(y, 4, 6) + (w - 1) * 7 <= make_date(y + 1, 4, 5)
on conflict do nothing;

insert into public.payroll_periods (frequency, tax_year, number, start_date, end_date)
select 'monthly', format('%s/%s', y, to_char(mod(y + 1, 100), 'FM00')), m,
       (make_date(y, 4, 6) + ((m - 1) || ' months')::interval)::date,
       (make_date(y, 4, 6) + (m || ' months')::interval - interval '1 day')::date
from generate_series(2023, 2027) y, generate_series(1, 12) m
on conflict do nothing;

-- The live column. journal_month_coverage is gated to can_view_reports,
-- which the payroll team need not hold; this exposes only realm + status
-- for one month, to active staff.
create or replace function public.payroll_journal_status(p_period text)
returns table (realm_id text, status text)
language plpgsql
security definer
set search_path = public
stable
as $$
begin
  if not public.is_active_staff() then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  return query
    select m.realm_id, max(m.status)::text
    from public.journal_month_coverage m
    where m.period = p_period
    group by m.realm_id;
end;
$$;
revoke all on function public.payroll_journal_status(text) from public, anon;
grant execute on function public.payroll_journal_status(text) to authenticated, service_role;

comment on table public.payroll_clients is 'Payroll tab (sql/333): the BrightPay checklist client list, with pay date / cut-off / runner held once per client.';
comment on table public.payroll_ticks is 'Payroll tab (sql/333): one tick per client, period and step — done or n/a, by whom, when. Written only by payroll-tracker.';
