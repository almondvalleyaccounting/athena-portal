-- ============================================================
-- 330 — Reassign a BrightManager job inside Athena, and make it stick
--
-- import_bm_tasks rewrites assignee_id from BM's assignee name on every
-- nightly import, so an assignee changed in Athena lasted one night. This
-- adds an override the way scheduled_for_date has manually_overridden_at:
--
--   assignee_override_id    who Athena says owns the job
--   assignee_override_kind  'one_off' (this task only) | 'permanent'
--                           (the client × service moved; an
--                           allocation_changes draft goes to the admin
--                           list so BM gets updated too)
--
-- A BEFORE UPDATE trigger enforces it on every write path, present and
-- future: while the override stands, assignee_id is the override. The
-- moment an import shows BM agreeing (its assignee equals the override),
-- the override has done its job and clears itself, so nothing is left
-- behind once the admin has moved the task in BM.
--
-- Written only through the job-plan edge function (reassign_bm_job).
-- ============================================================

alter table public.bm_task_schedule
  add column if not exists assignee_override_id   uuid references public.staff_profiles(id) on delete set null,
  add column if not exists assignee_override_kind text check (assignee_override_kind in ('one_off', 'permanent')),
  add column if not exists assignee_override_at   timestamptz,
  add column if not exists assignee_override_by   uuid references public.staff_profiles(id) on delete set null,
  add column if not exists assignee_override_note text;

create index if not exists bm_task_schedule_assignee_override_idx
  on public.bm_task_schedule (assignee_override_id) where assignee_override_id is not null;

create or replace function public.bm_task_schedule_apply_assignee_override()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.assignee_override_id is null then
    return new;
  end if;
  -- An import that now agrees with the override: BM has been updated, the
  -- override is spent. Only an import can clear it this way (last_import_id
  -- moves); an Athena edit that happens to set the same assignee keeps it.
  if tg_op = 'UPDATE'
     and new.last_import_id is distinct from old.last_import_id
     and new.assignee_id = new.assignee_override_id then
    new.assignee_override_id := null;
    new.assignee_override_kind := null;
    new.assignee_override_at := null;
    new.assignee_override_by := null;
    new.assignee_override_note := null;
    return new;
  end if;
  new.assignee_id := new.assignee_override_id;
  return new;
end;
$$;

revoke all on function public.bm_task_schedule_apply_assignee_override() from public, anon, authenticated;

drop trigger if exists bm_task_schedule_assignee_override on public.bm_task_schedule;
create trigger bm_task_schedule_assignee_override
  before insert or update on public.bm_task_schedule
  for each row execute function public.bm_task_schedule_apply_assignee_override();

comment on column public.bm_task_schedule.assignee_override_id is
  'Athena-side reassignment (sql/330). Wins over the imported assignee until an import shows BM agreeing, then clears itself.';
