-- 293 — Triage takes in the Issues Log, and gets a status workflow.
--
-- Bobby, 2026-09-24: Issues Log and the Triage Board are both for client
-- problems, so they become one set with three views — the board by type (as
-- now), a Kanban by stage and a list. Decisions, taken one at a time:
--   * one combined set: Issues Log client items become a new 'issue' category;
--   * stages On Hold / Not Started / With Client / Action Needed / Completed;
--   * starting positions: on_hold cases → On Hold, other open → Not Started,
--     resolved → Completed, the open Issues Log item → Action Needed;
--   * only the one client issue (East Fulwood) moves. The six closed software
--     items stay in issues_log untouched — five are already in Bug Reports.
--
-- status (open / resolved) stays, because the Home counters, the NLAC
-- self-heal (sql/134) and the strike-off trigger all read it. A trigger keeps
-- the two in step, whichever one a writer changes.

alter table public.triage_cases
  add column if not exists stage text not null default 'not_started',
  add column if not exists title text,
  add column if not exists priority text,
  add column if not exists assignee_id uuid references public.staff_profiles(id),
  add column if not exists source_issue_id uuid;

alter table public.triage_cases
  add constraint triage_cases_stage_check
  check (stage in ('on_hold', 'not_started', 'with_client', 'action_needed', 'completed'));
alter table public.triage_cases
  add constraint triage_cases_priority_check
  check (priority is null or priority in ('low', 'medium', 'high', 'critical'));

alter table public.triage_cases drop constraint if exists triage_cases_category_check;
alter table public.triage_cases
  add constraint triage_cases_category_check
  check (category in ('strike_off', 'on_hold', 'general', 'issue'));

create unique index if not exists triage_cases_source_issue_uidx
  on public.triage_cases (source_issue_id) where source_issue_id is not null;

-- Starting positions.
update public.triage_cases set stage = case
  when status = 'resolved'     then 'completed'
  when category = 'on_hold'    then 'on_hold'
  else 'not_started' end;

-- Keep status and stage agreeing. A stage change wins; otherwise a status
-- change (Resolve / Reopen buttons, sql/134's self-heal) moves the stage.
create or replace function public.triage_cases_sync_stage()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if new.status = 'resolved' then new.stage := 'completed';
    elsif new.stage = 'completed' then new.status := 'resolved';
    end if;
  elsif new.stage is distinct from old.stage then
    if new.stage = 'completed' then
      new.status := 'resolved';
    elsif old.stage = 'completed' then
      new.status := 'open';
      new.resolved_at := null;
      new.resolved_by := null;
    end if;
  elsif new.status is distinct from old.status then
    if new.status = 'resolved' then new.stage := 'completed';
    elsif old.status = 'resolved' then new.stage := 'not_started';
    end if;
  end if;
  if new.status = 'resolved' and new.resolved_at is null then
    new.resolved_at := now();
  end if;
  return new;
end $$;

revoke all on function public.triage_cases_sync_stage() from public, anon, authenticated;

drop trigger if exists triage_cases_sync_stage on public.triage_cases;
create trigger triage_cases_sync_stage
  before insert or update on public.triage_cases
  for each row execute function public.triage_cases_sync_stage();

-- Bring the Issues Log's client items across (today: East Fulwood only).
insert into public.triage_cases
  (entity_id, category, title, description, status, stage, priority, assignee_id,
   created_by, created_at, source, source_issue_id)
select il.entity_id, 'issue', il.title, coalesce(nullif(il.description, ''), il.title),
       'open', 'action_needed',
       case when il.priority in ('low', 'medium', 'high', 'critical') then il.priority end,
       il.assignee_id, il.reported_by, il.created_at, 'issues_log', il.id
  from public.issues_log il
 where il.category = 'Client'
   and il.entity_id is not null
   and il.status not in ('resolved', 'closed')
on conflict (source_issue_id) where source_issue_id is not null do nothing;
