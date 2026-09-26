-- ============================================================
-- 324 — Self assessment jobs: the client's own accounting year end
--
-- Bobby, 2026-09-26: some sole traders are not on 31 March / 5 April.
-- BrightManager records those year ends on "Self Assessment Accounts
-- Preparation Year End dd/mm/yyyy" (service Personal Tax) and "SA800
-- Accounts Preparation Year End …" (service Accounts), not only on
-- Annual Accounts rows. Any accounts-preparation row of the client's with
-- a year end inside the tax year now sets the period end; otherwise
-- 5 April. Same shape as sql/322.
-- ============================================================

create or replace view public.v_sa_jobs with (security_invoker = true) as
with sa as (
  select b.id, b.entity_id, b.bm_task_name, b.bm_status, b.bm_deadline, b.assignee_id,
         make_date(substring(b.bm_task_name from 'Tax Year\s+(\d{4})/\d{2}')::int + 1, 4, 5) as tax_year_end,
         (b.bm_task_name ~ 'Return Preparation') as is_prep,
         (b.bm_task_name ~ 'Submission') as is_sub
  from bm_task_schedule b
  join entities e on e.id = b.entity_id
  where b.state = 'planned' and b.excluded_at is null
    and b.service in ('Self Assessment', 'Personal Tax')
    and b.bm_task_name ~ '^Self Assessment (Submission|Return Preparation) Tax Year \d{4}/\d{2}'
    and e.type in ('sole_trader', 'partnership', 'llp')
), acc_ye as (
  -- Any accounts-preparation row with a dated year end, whatever service BM filed it under.
  select b.entity_id, to_date(substring(b.bm_task_name from 'Year End\s+(\d{2}/\d{2}/\d{4})'), 'DD/MM/YYYY') as ye
  from bm_task_schedule b
  where b.state = 'planned' and b.excluded_at is null
    and b.bm_task_name ~ 'Accounts Preparation Year End\s+\d{2}/\d{2}/\d{4}'
), vat as (
  select b.entity_id, to_date(substring(b.bm_task_name from '(\d{2}/\d{2}/\d{4})'), 'DD/MM/YYYY') as vat_period_end
  from bm_task_schedule b
  where b.service = 'VAT' and b.bm_task_name ~ '\d{2}/\d{2}/\d{4}'
), grouped as (
  select s.entity_id, s.tax_year_end,
         (array_agg(s.id order by s.id) filter (where s.is_prep))[1] as prep_job_id,
         (array_agg(s.id order by s.id) filter (where s.is_sub))[1]  as sub_job_id,
         max(s.bm_deadline) filter (where s.is_sub) as sa_deadline,
         coalesce((array_agg(s.assignee_id order by s.id) filter (where s.is_prep and s.assignee_id is not null))[1],
                  (array_agg(s.assignee_id order by s.id) filter (where s.assignee_id is not null))[1]) as preparer_id,
         coalesce((array_agg(s.bm_status order by s.id) filter (where s.is_prep))[1],
                  (array_agg(s.bm_status order by s.id) filter (where s.is_sub))[1]) as bm_status
  from sa s
  where s.tax_year_end is not null
  group by s.entity_id, s.tax_year_end
), pe as (
  select g.*,
         coalesce((select a.ye from acc_ye a
                    where a.entity_id = g.entity_id and a.ye > (g.tax_year_end - interval '1 year')::date and a.ye <= g.tax_year_end
                    order by a.ye desc limit 1), g.tax_year_end) as period_end,
         coalesce(g.sa_deadline, make_date(extract(year from g.tax_year_end)::int + 1, 1, 31)) as sa_due
  from grouped g
)
select g.entity_id,
       e.name as client,
       g.period_end,
       g.tax_year_end,
       g.prep_job_id,
       g.sub_job_id as ch_job_id,
       g.sa_due     as ch_deadline,
       null::uuid   as ct_job_id,
       null::date   as ct_deadline,
       g.preparer_id,
       sp.name as preparer_name,
       g.bm_status,
       p.id as plan_id, p.status as plan_status, p.committed_at, p.planned_at, p.risk,
       rm.has_meeting as meeting_default, rm.basis as meeting_basis,
       exists (select 1 from vat v where v.entity_id = g.entity_id and v.vat_period_end >= g.period_end and v.vat_period_end <= g.period_end + 62) as vat_covers_year_end,
       'self_assessment'::text as template_key
from pe g
join entities e on e.id = g.entity_id and e.entity_status not in ('nlac', 'archived')
left join staff_profiles sp on sp.id = g.preparer_id
left join job_plans p on p.entity_id = g.entity_id and p.period_end = g.period_end
                     and p.template_id = (select id from workflow_templates where key = 'self_assessment')
left join v_client_review_meeting rm on rm.entity_id = g.entity_id;
