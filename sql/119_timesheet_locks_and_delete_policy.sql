-- 119: Timesheet period locks + the missing DELETE policy.
--
-- Bug: timesheet_entries has RLS enabled but no DELETE policy, so every
-- delete from the UI silently matched zero rows and the row "came back"
-- on refetch. Same gap silently broke override reverts (delete-then-insert
-- accumulated rows instead of replacing).
--
-- Feature: "lock period" on the timesheets dashboard. A locked date range
-- blocks insert/update/delete of entries whose work_date falls inside it,
-- enforced here in RLS so no client path can bypass it.

create table if not exists public.timesheet_locks (
  id uuid primary key default gen_random_uuid(),
  period_start date not null,
  period_end date not null,
  note text,
  locked_by uuid references public.staff_profiles(id),
  locked_at timestamptz not null default now(),
  constraint timesheet_locks_valid_range check (period_end >= period_start)
);

comment on table public.timesheet_locks is
  'Locked timesheet periods. Any timesheet_entries row with work_date inside a locked range cannot be inserted, updated or deleted (RLS-enforced). Managed from the timesheets dashboard by portal admins.';

alter table public.timesheet_locks enable row level security;

drop policy if exists "Staff can view timesheet locks" on public.timesheet_locks;
create policy "Staff can view timesheet locks"
  on public.timesheet_locks for select
  using (is_active_staff());

drop policy if exists "Portal admins manage timesheet locks" on public.timesheet_locks;
create policy "Portal admins manage timesheet locks"
  on public.timesheet_locks for all
  using (exists (
    select 1 from public.staff_profiles sp
    where sp.id = auth.uid() and sp.is_active and sp.is_portal_admin
  ))
  with check (exists (
    select 1 from public.staff_profiles sp
    where sp.id = auth.uid() and sp.is_active and sp.is_portal_admin
  ));

-- Helper used inside timesheet_entries policies (security definer so the
-- lock check itself never depends on the caller's row visibility).
create or replace function public.is_timesheet_locked(d date)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.timesheet_locks l
    where d between l.period_start and l.period_end
  );
$$;

grant execute on function public.is_timesheet_locked(date) to authenticated;

-- The missing DELETE policy (own rows only, never in a locked period).
drop policy if exists "Staff can delete own timesheet entries" on public.timesheet_entries;
create policy "Staff can delete own timesheet entries"
  on public.timesheet_entries for delete
  using (staff_id = auth.uid() and not public.is_timesheet_locked(work_date));

-- Recreate insert/update with the lock predicate added.
drop policy if exists "Staff can insert timesheet entries" on public.timesheet_entries;
create policy "Staff can insert timesheet entries"
  on public.timesheet_entries for insert
  with check (is_active_staff() and not public.is_timesheet_locked(work_date));

drop policy if exists "Staff can update own timesheet entries" on public.timesheet_entries;
create policy "Staff can update own timesheet entries"
  on public.timesheet_entries for update
  using (staff_id = auth.uid() and not public.is_timesheet_locked(work_date))
  with check (not public.is_timesheet_locked(work_date));
