-- ============================================================
-- 307 — Records via the VAT return
--
-- Bobby, 2026-09-26: where we do the VAT returns and a VAT period ends at the
-- year end or within two months after it, we already hold most of the
-- year-end paperwork. The records request then becomes a gap request (loan
-- statements, new HP agreements, payroll if it is not ours, the director's
-- personal tax information, and free-form queries) rather than a full one.
--
-- v_accounts_jobs gains vat_covers_year_end; job_plans records the answer
-- the plan was built with so the request stage can be worded accordingly.
-- ============================================================

alter table public.job_plans
  add column if not exists records_via_vat boolean;

comment on column public.job_plans.records_via_vat is
  'True when a VAT return we prepare ends at, or within two months after, the year end — the records request is a gap request.';

create or replace view public.v_accounts_jobs
with (security_invoker = true) as
with acc as (
  select
    b.id, b.entity_id, b.bm_task_name, b.bm_status, b.bm_deadline, b.assignee_id,
    derive_period_end('Annual Accounts', b.bm_deadline, b.bm_task_name) as period_end,
    b.bm_task_name like 'Accounts Preparation%' as is_prep,
    b.bm_task_name like 'Companies House Submission%' as is_ch
  from bm_task_schedule b
  where b.state = 'planned' and b.excluded_at is null and b.service = 'Annual Accounts'
),
ct as (
  select
    b.id, b.entity_id, b.bm_deadline,
    case when b.bm_task_name ~ 'Year End\s+\d{2}/\d{2}/\d{4}'
         then to_date(substring(b.bm_task_name from 'Year End\s+(\d{2}/\d{2}/\d{4})'), 'DD/MM/YYYY')
         else (b.bm_deadline - interval '12 months')::date end as period_end
  from bm_task_schedule b
  where b.state = 'planned' and b.excluded_at is null and b.service = 'Corporation Tax'
),
vat as (
  select b.entity_id,
         to_date(substring(b.bm_task_name from '(\d{2}/\d{2}/\d{4})'), 'DD/MM/YYYY') as vat_period_end
  from bm_task_schedule b
  where b.service = 'VAT' and b.bm_task_name ~ '\d{2}/\d{2}/\d{4}'
),
grouped as (
  select
    a.entity_id, a.period_end,
    (array_agg(a.id order by a.id) filter (where a.is_prep))[1]          as prep_job_id,
    (array_agg(a.id order by a.id) filter (where a.is_ch))[1]            as ch_job_id,
    max(a.bm_deadline) filter (where a.is_ch)                            as ch_deadline,
    coalesce(
      (array_agg(a.assignee_id order by a.id) filter (where a.is_prep and a.assignee_id is not null))[1],
      (array_agg(a.assignee_id order by a.id) filter (where a.assignee_id is not null))[1]
    )                                                                    as preparer_id,
    coalesce(
      (array_agg(a.bm_status order by a.id) filter (where a.is_prep))[1],
      (array_agg(a.bm_status order by a.id) filter (where a.is_ch))[1]
    )                                                                    as bm_status
  from acc a
  where a.period_end is not null
  group by a.entity_id, a.period_end
)
select
  g.entity_id,
  e.name                                   as client,
  g.period_end,
  g.prep_job_id,
  g.ch_job_id,
  g.ch_deadline,
  c.id                                     as ct_job_id,
  c.bm_deadline                            as ct_deadline,
  g.preparer_id,
  sp.name                                  as preparer_name,
  g.bm_status,
  p.id                                     as plan_id,
  p.status                                 as plan_status,
  p.committed_at,
  p.planned_at,
  p.risk,
  rm.has_meeting                           as meeting_default,
  rm.basis                                 as meeting_basis,
  exists (
    select 1 from vat v
    where v.entity_id = g.entity_id
      and v.vat_period_end between g.period_end and g.period_end + 62
  )                                        as vat_covers_year_end
from grouped g
join entities e on e.id = g.entity_id and e.entity_status not in ('nlac', 'archived')
left join lateral (
  select c.id, c.bm_deadline from ct c
  where c.entity_id = g.entity_id and c.period_end = g.period_end
  order by c.id limit 1
) c on true
left join staff_profiles sp on sp.id = g.preparer_id
left join job_plans p on p.entity_id = g.entity_id and p.period_end = g.period_end
left join v_client_review_meeting rm on rm.entity_id = g.entity_id;

revoke all on public.v_accounts_jobs from public, anon;
grant select on public.v_accounts_jobs to authenticated, service_role;
