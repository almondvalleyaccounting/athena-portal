-- 111: v_deadline_buckets — ONE definition of the deadline numbers.
--
-- The CH/SA/overdue counts were implemented twice (deadline-digest edge fn +
-- the home dashboard's client-side maths) with subtle differences: the digest
-- counted SA as name-match OR service='Personal Tax', the dashboard name-only;
-- and a filing overdue this month was triple-counted (this month + six months
-- + overdue presented as disjoint). Both consumers now read this view.
--
-- Definitions (all: state='planned', excluded_at is null — "won't happen"
-- triage removes jobs from every number):
--   * ch buckets are DISJOINT: this/next month start from today; overdue is
--     strictly past. six_months = today .. +6 months.
--   * sa_next_jan = outstanding returns due up to and including the next
--     31 January. sa definition = name 'Self Assessment Submission%' OR
--     service 'Personal Tax' (the digest's broader rule wins).
--   * overdue_total / overdue_by_service cover every service, exact counts.
-- security_invoker: staff RLS on bm_task_schedule applies to portal readers;
-- the digest reads with the service role.

create or replace view public.v_deadline_buckets
with (security_invoker = true) as
with base as (
  select service, bm_task_name, bm_deadline
  from bm_task_schedule
  where state = 'planned' and excluded_at is null and bm_deadline is not null
), ch as (
  select * from base where bm_task_name ilike 'Companies House Submission%'
), sa as (
  select * from base
  where bm_task_name ilike 'Self Assessment Submission%' or service = 'Personal Tax'
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
