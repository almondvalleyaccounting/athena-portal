-- 297: per-client summary for the Clients list table (UI audit, Sprint 4).
--
-- The list shows each client's next deadline, how many are overdue, and how
-- many open actions they have. The browser cannot total those itself: open
-- BrightManager jobs alone are ~1,600 rows, past PostgREST's silent 1,000-row
-- cap, so the count would be quietly wrong. One row per entity instead.
--
-- security_invoker: the view reads its base tables as the caller, so the
-- existing policies apply unchanged — bm_task_schedule and entities need
-- active staff, and quick_tasks needs the work_planner flag (a staff member
-- without it sees 0 open actions, exactly as on the client record).

create or replace view public.v_client_list_summary
with (security_invoker = true) as
select
  e.id as entity_id,
  nd.bm_deadline  as next_deadline,
  nd.bm_task_name as next_task,
  coalesce(od.n, 0)::int as overdue_count,
  coalesce(qa.n, 0)::int as open_actions
from public.entities e
left join lateral (
  select b.bm_deadline, b.bm_task_name
  from public.bm_task_schedule b
  where b.entity_id = e.id and b.state = 'planned' and b.excluded_at is null
    and b.bm_deadline >= current_date
  order by b.bm_deadline
  limit 1
) nd on true
left join lateral (
  select count(*) as n
  from public.bm_task_schedule b
  where b.entity_id = e.id and b.state = 'planned' and b.excluded_at is null
    and b.bm_deadline < current_date
) od on true
left join lateral (
  select count(*) as n from public.quick_tasks q where q.entity_id = e.id
) qa on true;

-- A schema default privilege hands authenticated/service_role every privilege
-- on a new view; strip them all, then grant read only.
revoke all on public.v_client_list_summary from public, anon, authenticated, service_role;
grant select on public.v_client_list_summary to authenticated, service_role;
