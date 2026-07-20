-- 127: (a) Admin task completion metadata — who did it, how long it took.
--     (b) Honest "SA returns due" count: submissions only, no double count.
--
-- (a) Completing an admin task now records done_by + done_minutes so admin
--     time can be analysed by task type and client, and later feed the admin
--     fees charged to clients.
--
-- (b) The 16 Jul unification (111) made sa_next_jan count every task with
--     service='Personal Tax', which pulled in "Self Assessment Return
--     Preparation" (78), "SA Accounts Preparation" (6) etc. — workflow steps
--     toward the SAME return as an already-counted Submission task. 355 rows
--     ≠ 355 returns (only 269 distinct clients). New rule: a "return due" is
--     a SUBMISSION task (Self Assessment Submission / SA800 Return
--     Submission / any Personal-Tax-service submission) — preparation tasks
--     are excluded. Today that gives 270.

alter table public.admin_tasks
  add column if not exists done_by uuid references public.staff_profiles(id),
  add column if not exists done_minutes int;

comment on column public.admin_tasks.done_minutes is
  'Minutes the completer says the task took. Feeds admin-time analysis by task type / client, and eventually admin fees.';

create or replace view public.v_deadline_buckets
with (security_invoker = true) as
with base as (
  select service, bm_task_name, bm_deadline
  from bm_task_schedule
  where state = 'planned' and excluded_at is null and bm_deadline is not null
), ch as (
  select * from base where bm_task_name ilike 'Companies House Submission%'
), sa as (
  -- Submission tasks only: one per return (incl. SA800 partnership returns).
  -- Preparation/accounts-prep tasks are steps toward the same return and
  -- would double-count it.
  select * from base
  where (bm_task_name ilike 'Self Assessment%' or bm_task_name ilike 'SA800%' or service = 'Personal Tax')
    and bm_task_name ilike '%Submission%'
), next_jan as (
  select case
    when current_date <= make_date(extract(year from current_date)::int, 1, 31)
    then make_date(extract(year from current_date)::int, 1, 31)
    else make_date(extract(year from current_date)::int + 1, 1, 31)
  end as d
)
select
  (select count(*) from ch where bm_deadline >= current_date
     and bm_deadline < date_trunc('month', current_date) + interval '1 month')::int as ch_this_month,
  (select count(*) from ch
     where bm_deadline >= date_trunc('month', current_date) + interval '1 month'
       and bm_deadline < date_trunc('month', current_date) + interval '2 months')::int as ch_next_month,
  (select count(*) from ch where bm_deadline >= current_date
     and bm_deadline <= current_date + interval '6 months')::int as ch_six_months,
  (select count(*) from ch where bm_deadline < current_date)::int as ch_overdue,
  (select count(*) from sa, next_jan
     where bm_deadline >= current_date and bm_deadline <= next_jan.d)::int as sa_next_jan,
  (select extract(year from d)::int from next_jan) as sa_year,
  (select count(*) from sa where bm_deadline < current_date)::int as sa_overdue,
  (select count(*) from base where bm_deadline < current_date)::int as overdue_total,
  (select coalesce(jsonb_object_agg(coalesce(service, 'Other'), n), '{}'::jsonb)
     from (select service, count(*)::int as n from base
           where bm_deadline < current_date group by service) s)::jsonb as overdue_by_service;
