-- 303: Work module review, step 1 (docs/WORK_MODULE_REVIEW_2026-09-25.md).
--
-- 1. timesheet_entries.source: the live CHECK only allowed 'completed' and
--    'manual'. The timesheet grid's completion override writes 'override' and
--    the BM reconciliation log writes 'bm_reconciliation'; both have failed
--    with 23514 since they shipped, the UI swallowed the error, and because
--    bm_reconciliation is the only writer of source_task_id, logged_hours on
--    every BM job has always been 0 (Waiting's "remaining" = the full estimate).
--
-- 2. ready_now_jobs: sql/109 added "excluded_at is null" so jobs marked
--    "won't happen" leave the queue; sql/129 rebuilt the view for the
--    former-client filter and dropped that predicate. The browser view kept
--    it, so Ready Now hid those jobs while job-review cohorts and the
--    change-request reconciler still saw them. Both predicates now.

alter table public.timesheet_entries
  drop constraint if exists timesheet_entries_source_check;
alter table public.timesheet_entries
  add constraint timesheet_entries_source_check
  check (source in ('completed', 'manual', 'override', 'bm_reconciliation'));

create or replace view public.ready_now_jobs
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
    and b.excluded_at is null
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
where e.entity_status not in ('nlac', 'archived');
