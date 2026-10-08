-- ============================================================
-- 357 — Who moved an admin task's deadline, and from what
--
-- On 2026-10-08 Bobby asked who had changed dates on the admin task list,
-- and there was no way to answer: admin_tasks has no updated_at, no audit
-- row, and the deadline is written straight from the browser in two places
-- (the date box on the list and the task drawer). The only trace was the
-- gateway request log, which keeps about a day and records the request,
-- not the old and new value.
--
-- So every change to admin_tasks.deadline now writes a row here: the old
-- date, the new date, who made the change (auth.uid(); null means no JWT,
-- i.e. a cron job, a migration or the SQL editor) and when. A trigger
-- rather than the frontend, so every write path is covered, present and
-- future. The drawer saves the deadline on every Save even when it hasn't
-- changed, so the trigger only fires when the value actually differs.
--
-- Read-only to staff. Nothing writes here except the trigger, which runs as
-- the owner; authenticated holds SELECT only, and anon holds nothing.
-- ============================================================

create table if not exists public.admin_task_deadline_changes (
  id            uuid primary key default gen_random_uuid(),
  task_id       uuid not null references public.admin_tasks(id) on delete cascade,
  old_deadline  date,
  new_deadline  date,
  changed_by    uuid references public.staff_profiles(id) on delete set null,
  changed_at    timestamptz not null default now()
);

create index if not exists admin_task_deadline_changes_task_idx
  on public.admin_task_deadline_changes (task_id, changed_at desc);

alter table public.admin_task_deadline_changes enable row level security;

drop policy if exists admin_task_deadline_changes_select on public.admin_task_deadline_changes;
create policy admin_task_deadline_changes_select on public.admin_task_deadline_changes
  for select to authenticated using (is_active_staff());

revoke all on public.admin_task_deadline_changes from public, anon, authenticated;
grant select on public.admin_task_deadline_changes to authenticated;
grant all on public.admin_task_deadline_changes to service_role;

create or replace function public.admin_task_log_deadline_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_by uuid := auth.uid();
begin
  -- A client-portal user holds a JWT too, but cannot reach admin_tasks (RLS
  -- is is_active_staff()). Keep changed_by to staff ids so the FK holds.
  if v_by is not null and not exists (select 1 from staff_profiles where id = v_by) then
    v_by := null;
  end if;
  insert into admin_task_deadline_changes (task_id, old_deadline, new_deadline, changed_by)
  values (new.id, case when tg_op = 'UPDATE' then old.deadline end, new.deadline, v_by);
  return null;
end;
$$;

revoke all on function public.admin_task_log_deadline_change() from public, anon, authenticated;

drop trigger if exists trg_admin_tasks_deadline_history_upd on public.admin_tasks;
create trigger trg_admin_tasks_deadline_history_upd
  after update of deadline on public.admin_tasks
  for each row
  when (old.deadline is distinct from new.deadline)
  execute function public.admin_task_log_deadline_change();

drop trigger if exists trg_admin_tasks_deadline_history_ins on public.admin_tasks;
create trigger trg_admin_tasks_deadline_history_ins
  after insert on public.admin_tasks
  for each row
  when (new.deadline is not null)
  execute function public.admin_task_log_deadline_change();

comment on table public.admin_task_deadline_changes is
  'Every change to admin_tasks.deadline (sql/357), written by trigger. changed_by null = no JWT (cron, migration, SQL editor).';
