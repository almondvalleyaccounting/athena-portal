-- ============================================================
-- 331 — Edit a BrightManager job's due date in Athena, and make it stick
--
-- Same shape as the assignee override (sql/330): import_bm_tasks rewrites
-- bm_deadline on every import, so a date changed in Athena needs an
-- override that wins until BM agrees. Changing the date also raises an
-- admin task ("change it in BrightManager"); when an import then shows
-- BM's deadline equal to the override, the override clears itself and the
-- admin task is confirmed, the way bm_code tasks confirm from BM.
--
-- Written only through the job-plan edge function (set_bm_deadline).
-- ============================================================

alter table public.bm_task_schedule
  add column if not exists deadline_override               date,
  add column if not exists deadline_override_at            timestamptz,
  add column if not exists deadline_override_by            uuid references public.staff_profiles(id) on delete set null,
  add column if not exists deadline_override_admin_task_id uuid references public.admin_tasks(id) on delete set null;

create or replace function public.bm_task_schedule_apply_deadline_override()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.deadline_override is null then
    return new;
  end if;
  if tg_op = 'UPDATE'
     and new.last_import_id is distinct from old.last_import_id
     and new.bm_deadline = new.deadline_override then
    -- BM has been updated: the override is spent and the admin task is done.
    if new.deadline_override_admin_task_id is not null then
      update public.admin_tasks
         set confirmed_at = now(), done_at = coalesce(done_at, now())
       where id = new.deadline_override_admin_task_id and dismissed_at is null;
    end if;
    new.deadline_override := null;
    new.deadline_override_at := null;
    new.deadline_override_by := null;
    new.deadline_override_admin_task_id := null;
    return new;
  end if;
  new.bm_deadline := new.deadline_override;
  return new;
end;
$$;

revoke all on function public.bm_task_schedule_apply_deadline_override() from public, anon, authenticated;

drop trigger if exists bm_task_schedule_deadline_override on public.bm_task_schedule;
create trigger bm_task_schedule_deadline_override
  before insert or update on public.bm_task_schedule
  for each row execute function public.bm_task_schedule_apply_deadline_override();

comment on column public.bm_task_schedule.deadline_override is
  'Due date set in Athena (sql/331). Wins over the imported deadline until an import shows BM agreeing, then clears itself and confirms its admin task.';
