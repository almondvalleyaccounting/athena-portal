-- 129: Exclude former clients from Ready Now + job review.
--
-- ready_now_jobs joined entities with no status filter, so a client marked
-- nlac (no longer a client) or archived — but still carrying planned BM
-- tasks — kept appearing in the Work Planner Ready Now view and got
-- snapshotted into every monthly job-review cycle (Frasers Waste Management,
-- July 2026 cycle). We do no work for former clients, so they don't belong
-- in either place. The offboarding mirror (nlac_bm_mirror admin tasks)
-- separately keeps chasing the BM-side cleanup.
--
-- Also removes former clients' items from any OPEN review cycle so the
-- current month self-heals.

create or replace view ready_now_jobs
with (security_invoker = true) as
with derived as (
  select
    b.entity_id,
    b.service,
    derive_period_end(b.service, b.bm_deadline, b.bm_task_name) as period_end,
    b.bm_deadline,
    b.bm_target_date,
    b.bm_status,
    b.assignee_id,
    b.bm_task_id
  from bm_task_schedule b
  where b.state = 'planned'
    and b.service in ('Annual Accounts', 'Self Assessment')
),
valid as (
  select * from derived where period_end is not null
),
rep as (
  select distinct on (entity_id, service, period_end)
    entity_id, service, period_end, bm_deadline, bm_target_date, bm_status
  from valid
  order by entity_id, service, period_end,
           bm_target_date asc nulls last, bm_deadline asc nulls last, bm_task_id
),
agg as (
  select
    v.entity_id, v.service, v.period_end,
    array_remove(array_agg(distinct v.assignee_id), null)               as assignee_ids,
    array_remove(array_agg(distinct sp.name), null)                     as assignee_names
  from valid v
  left join staff_profiles sp on sp.id = v.assignee_id
  group by v.entity_id, v.service, v.period_end
)
select
  r.entity_id,
  e.name                                        as client,
  e.grade,
  r.service,
  r.period_end,
  r.bm_deadline,
  r.bm_target_date,
  r.bm_status,
  a.assignee_ids,
  a.assignee_names,
  coalesce(e.expedite, false)                   as expedite,
  e.deprioritise_reason,
  (current_date - r.period_end)                 as days_past,
  case when r.bm_deadline is not null
       then (r.bm_deadline - current_date) end  as days_to_deadline,
  case
    when e.deprioritise_reason is not null                              then 'deprioritised'
    when r.bm_deadline is not null and (r.bm_deadline - current_date) <= 14 then 'urgent'
    when coalesce(e.expedite, false) and (current_date - r.period_end) >= 0  then 'expedite'
    when (current_date - r.period_end) >= 90                            then 'normal'
    else 'upcoming'
  end                                           as box
from rep r
join agg a using (entity_id, service, period_end)
join entities e on e.id = r.entity_id
-- No work is done for former clients.
where e.entity_status not in ('nlac', 'archived');

-- Self-heal the current month: drop former clients from open cycles.
delete from job_review_item i
using job_review_cycle c, entities e
where c.id = i.cycle_id
  and c.status = 'open'
  and e.id = i.entity_id
  and e.entity_status in ('nlac', 'archived');
