-- ============================================================
-- 317 — Staff holidays
--
-- Bobby, 2026-09-26: team members block out their Planner with holidays;
-- the Planner and Day plan show the day as off (capacity 0); the Overview
-- tiles flag when a holiday falls in the period; and a handover feature
-- emails the team about cover and hands unfinished work to a colleague.
--
-- BrightPay: the runner scrapes payments and analysis reports only, so a
-- holiday import from BrightPay is a separate piece of work. `source` is
-- ready for it. Written through the job-plan edge function.
-- ============================================================

create table if not exists public.staff_holidays (
  id          uuid primary key default gen_random_uuid(),
  staff_id    uuid not null references public.staff_profiles(id) on delete cascade,
  date_from   date not null,
  date_to     date not null check (date_to >= date_from),
  kind        text not null default 'holiday' check (kind in ('holiday','sick','other')),
  half_day    boolean not null default false,
  note        text,
  source      text not null default 'manual' check (source in ('manual','brightpay')),
  cover_staff_id uuid references public.staff_profiles(id) on delete set null,
  created_by  uuid references public.staff_profiles(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index if not exists staff_holidays_staff_idx on public.staff_holidays (staff_id, date_from, date_to);
comment on table public.staff_holidays is 'Holidays and other absence per staff member (sql/317); capacity is 0 on those days.';

alter table public.staff_holidays enable row level security;
drop policy if exists staff_holidays_select_staff on public.staff_holidays;
create policy staff_holidays_select_staff on public.staff_holidays
  for select to authenticated using (is_active_staff());
revoke all on public.staff_holidays from public, anon;
revoke insert, update, delete, truncate, references, trigger on public.staff_holidays from authenticated;
grant select on public.staff_holidays to authenticated;
grant select, insert, update, delete on public.staff_holidays to service_role;
