-- 206_bookkeeping_drift_assignees.sql
--
-- Every nudge in the first queued batch came out addressed to nobody: nothing
-- had ever set an assignee on bk_watch_config, so there was no one to nudge.
--
-- The work schedule already knows. Whoever owns the client's most recent
-- Bookkeeping or VAT job is the person a drift nudge is for, and all 65 watched
-- clients have one.
--
-- Seeded rather than joined live, for two reasons: a deliberate reassignment on
-- the drift board must survive the next BrightManager re-import (see the
-- Athena-vs-BM rule), and the person who owns a case should not silently change
-- underneath an open case because a job was reallocated.
--
-- After seeding, the first queue read: 11 to Anne McCarvel, 3 to Lisa Quinn,
-- 2 to Magda Luda, 1 to Stephanie Campbell — which is exactly the sort of
-- distribution worth looking at before any of it is allowed to send.

create or replace function public.bk_seed_assignees()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare v_n int;
begin
  with owner_of as (
    select distinct on (b.entity_id) b.entity_id, b.assignee_id
    from public.bm_task_schedule b
    where b.service in ('Bookkeeping', 'VAT')
      and b.assignee_id is not null
      and coalesce(b.state, 'committed') <> 'discarded'
    order by b.entity_id, b.bm_target_date desc nulls last, b.bm_deadline desc nulls last
  )
  update public.bk_watch_config w
     set assignee_id = o.assignee_id, updated_at = now()
    from owner_of o
   where w.entity_id = o.entity_id
     and w.assignee_id is null;      -- never overwrite a human decision
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke all on function public.bk_seed_assignees() from public, anon;
grant execute on function public.bk_seed_assignees() to authenticated, service_role;

select public.bk_seed_assignees() as assignees_seeded;

-- Backfill the cases and nudges already opened before assignees existed.
update public.bk_drift_cases c
   set assignee_id = w.assignee_id
  from public.bk_watch_config w
 where w.entity_id = c.entity_id
   and c.assignee_id is null
   and c.state not in ('resolved', 'dismissed');

update public.bk_drift_nudges n
   set recipient_id = c.assignee_id
  from public.bk_drift_cases c
 where c.id = n.case_id
   and n.recipient_id is null
   and n.state = 'queued';
