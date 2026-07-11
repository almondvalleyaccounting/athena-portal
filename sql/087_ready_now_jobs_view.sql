-- ready_now_jobs: canonical, deduped view of live "could-be-done" jobs.
--
-- Lifts the Ready Now logic (src/modules/work-planner/views/ReadyNowView.jsx)
-- into SQL so the Work Planner UI and the monthly job-review automation share
-- ONE definition of period-end derivation + box classification and can't drift.
--
-- One row per (entity, service, period_end), collapsing BM's two sub-tasks
-- (Accounts Preparation + Companies House Submission). Only live work
-- (state = 'planned') for the two services Ready Now covers today.

-- ── Period-end derivation ────────────────────────────────────────────────
-- Prefer parsing the period end BM embeds in the task title; fall back to
-- deadline arithmetic. Mirrors derivePeriodEnd() in ReadyNowView.jsx.
--   Annual Accounts : "... Year End DD/MM/YYYY"  (fallback: bm_deadline − 9 months)
--   Self Assessment : "... Tax Year YYYY/YY"     → 5 April of the closing year
--                                                  (fallback: 5 April of deadline year − 1)
create or replace function derive_period_end(
  p_service     text,
  p_bm_deadline date,
  p_task_name   text
) returns date
language sql
immutable
as $$
  select case
    when p_service = 'Annual Accounts' then
      coalesce(
        case when p_task_name ~ 'Year End\s+\d{2}/\d{2}/\d{4}'
             then to_date(substring(p_task_name from 'Year End\s+(\d{2}/\d{2}/\d{4})'), 'DD/MM/YYYY')
        end,
        (p_bm_deadline - interval '9 months')::date
      )
    when p_service = 'Self Assessment' then
      coalesce(
        case when p_task_name ~ 'Tax Year\s+\d{4}/\d{2}'
             then make_date(substring(p_task_name from 'Tax Year\s+(\d{4})/\d{2}')::int + 1, 4, 5)
        end,
        case when p_bm_deadline is not null
             then make_date(extract(year from p_bm_deadline)::int - 1, 4, 5)
        end
      )
    else null
  end
$$;

comment on function derive_period_end(text, date, text) is
  'Derives an accounting period end from a BM task. Parses the task name first (Annual Accounts "Year End DD/MM/YYYY", Self Assessment "Tax Year YYYY/YY"); falls back to bm_deadline arithmetic. Mirrors derivePeriodEnd() in ReadyNowView.jsx.';

-- ── The view ───────────────────────────────────────────────────────────────
-- security_invoker = respects the caller's RLS on the underlying tables (the
-- portal shares one auth pool with future client logins — see sql/078).
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
-- Representative row per job: the most pressing (earliest BM target).
rep as (
  select distinct on (entity_id, service, period_end)
    entity_id, service, period_end, bm_deadline, bm_target_date, bm_status
  from valid
  order by entity_id, service, period_end,
           bm_target_date asc nulls last, bm_deadline asc nulls last, bm_task_id
),
-- All assignees across the merged sub-tasks.
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
  -- Box classification with Ready Now defaults (urgent ≤14d, normal ≥90d).
  -- Consumers with a custom threshold can reclassify from the raw fields.
  case
    when e.deprioritise_reason is not null                              then 'deprioritised'
    when r.bm_deadline is not null and (r.bm_deadline - current_date) <= 14 then 'urgent'
    when coalesce(e.expedite, false) and (current_date - r.period_end) >= 0  then 'expedite'
    when (current_date - r.period_end) >= 90                            then 'normal'
    else 'upcoming'
  end                                           as box
from rep r
join agg a using (entity_id, service, period_end)
join entities e on e.id = r.entity_id;

comment on view ready_now_jobs is
  'One row per live (entity, service, period_end) job for Annual Accounts / Self Assessment, with Ready Now box classification. Shared source of truth for the Work Planner Ready Now view and the monthly job-review automation.';

grant select on ready_now_jobs to authenticated, service_role;
