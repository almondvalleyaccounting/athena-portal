-- ============================================================
-- 322 — Self assessment template (sole traders, partnerships, LLPs)
--
-- docs/WORKFLOW_TEMPLATE_ACCOUNTS_2026-09-25.md §4. The same chain as the
-- accounts template up to approval, then one filing stage for the return
-- (SA100 / SA800) with the 31 January hard limit, and two payment reminders
-- (31 January balancing payment + first payment on account; 31 July second
-- payment on account) in place of the corporation tax stages.
--
-- The job spine is the BrightManager "Self Assessment Submission Tax Year
-- YYYY/YY" row (plus the "Return Preparation" row where BM has one). The
-- period end is the accounting year end when an accounts job for a year end
-- inside the tax year exists, otherwise the tax year end (5 April), which is
-- what most sole traders use. In the shared view shape the statutory
-- deadline sits in ch_deadline so the chain maths and the nightly pass work
-- unchanged: "statutory_ch" reads as "the job's statutory filing deadline".
-- ============================================================

insert into public.workflow_templates (key, name, service)
values ('self_assessment', 'Self assessment (sole traders and partnerships)', 'Self Assessment')
on conflict (key) do nothing;

with t as (select id from public.workflow_templates where key = 'self_assessment')
insert into public.workflow_stages
  (template_id, seq, key, label, kind, owner_role, anchor, anchor_stage_key, offset_months, offset_days,
   gate_stage_key, done_signal, min_gap_stage_key, min_gap_days, hard_limit, hours, requires)
select t.id, s.* from t, (values
  (1,  'request_records',      'Request records',                 'comms',     'client_manager', 'ye',           null,                               0, 7,   null,                               'manual',                      null, null, null, null, 'books_not_with_us'),
  (2,  'chase_1',              'Chase records',                   'comms',     'client_manager', 'stage',        'request_records',                  0, 14,  'request_records',                  'manual',                      null, null, null, null, 'books_not_with_us'),
  (3,  'chase_2',              'Chase records again',             'comms',     'client_manager', 'stage',        'request_records',                  0, 42,  'chase_1',                          'manual',                      null, null, null, null, 'books_not_with_us'),
  (4,  'records_in',           'Records in',                      'milestone', 'client',         'ye',           null,                               3, 0,   null,                               'bm_status:Records Received',  null, null, null, null, 'books_not_with_us'),
  (5,  'close_books',          'Close the books to year end',     'work',      'bookkeeper',     'ye',           null,                               0, 42,  null,                               'manual',                      null, null, null, 2.00, 'books_with_us'),
  (6,  'prepare',              'Prepare accounts and return',     'work',      'preparer',       'stage',        'internal_review',                  0, -7,  'records_in|close_books',           'bm_status:To Review',         null, null, null, 4.00, null),
  (7,  'internal_review',      'Internal review',                 'work',      'reviewer',       'stage',        'client_meeting|send_for_approval', 0, -14, 'prepare',                          'bm_status:Reviewed',          null, null, null, 1.00, null),
  (8,  'client_meeting',       'Client meeting',                  'calendar',  'client_manager', 'ye',           null,                               6, 0,   'internal_review',                  'calendar',                    'records_in|close_books', 30, null, 1.00, 'meeting'),
  (9,  'send_for_approval',    'Send for approval',               'comms',     'preparer',       'ye',           null,                               6, 0,   'internal_review',                  'bm_status:Awaiting Approval', 'records_in|close_books', 30, null, null, 'no_meeting'),
  (10, 'approval',             'Client approval',                 'comms',     'client_manager', 'stage',        'client_meeting|send_for_approval', 0, 14,  'client_meeting|send_for_approval', 'manual',                      null, null, null, null, null),
  (11, 'file_sa',              'File the return',                 'work',      'preparer',       'ye',           null,                               7, 0,   'approval',                         'bm_gone',                     null, null, 'statutory_ch', 0.50, null),
  (12, 'jan_payment_reminder', 'January payment reminder (balancing payment and first payment on account)', 'comms', 'client_manager', 'statutory_ch', null, 0, -21, 'file_sa',                   'manual',                      null, null, null, null, null),
  (13, 'jul_payment_reminder', 'July payment on account reminder', 'comms',    'client_manager', 'statutory_ch', null,                               6, -21, 'file_sa',                          'manual',                      null, null, null, null, null)
) as s(seq, key, label, kind, owner_role, anchor, anchor_stage_key, offset_months, offset_days,
       gate_stage_key, done_signal, min_gap_stage_key, min_gap_days, hard_limit, hours, requires)
on conflict (template_id, key) do nothing;

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
  select b.entity_id, derive_period_end('Annual Accounts', b.bm_deadline, b.bm_task_name) as ye
  from bm_task_schedule b
  where b.service = 'Annual Accounts' and b.state = 'planned' and b.excluded_at is null
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

revoke all on public.v_sa_jobs from public, anon;
grant select on public.v_sa_jobs to authenticated, service_role;
