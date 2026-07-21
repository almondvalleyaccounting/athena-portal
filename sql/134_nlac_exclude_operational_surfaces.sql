-- 134: Former clients (nlac/archived) must vanish from every operational and
--      notification surface — not just Ready Now (129).
--
-- The rule (Bobby, 2026-07-21 bug report): once a client is "no longer a
-- client", the ONE place they should appear is the nlac_bm_mirror admin task
-- (remove them from BrightManager). Nowhere else — no task lists, no CH code
-- chases, no strike-off / deadline emails.
--
-- Why query-time filtering (not the offboard cascade): BM re-import preserves
-- the nlac/archived status but RE-CREATES bm_task_schedule rows and can re-open
-- downstream items (see schema_bm_import_preserve_athena_status). A one-time
-- cascade at offboard is therefore wiped on the next import; only filtering at
-- read time is durable. This mirrors what 129 did for ready_now_jobs.
--
-- This migration covers the DB-side surfaces:
--   1. v_deadline_buckets   — the shared CH/SA/overdue counts (digest + home).
--   2. triage_from_ch_status_event — stop auto-raising strike-off triage cases
--                                     for former clients.
--   3. Self-heal existing state — resolve open triage cases and stall open CH
--      code requests that belong to former clients.
--   4. v_onboarding_updates — onboarding activity feed (weekly digest).
--   5. Work Planner views — v_inferred_allocations, v_bm_load_classified,
--      v_capacity_load_monthly, v_service_cadence, bm_task_schedule_with_progress.
-- Edge-function surfaces are fixed in their own deploys: ch-refresh-report,
-- ch-ingest-officers, deadline-digest, ch-code-queue-fill, ch-code-weekly,
-- ch-code-chase, ch-code-calls, onboarding-chase, onboarding-weekly,
-- reminders-send. Front-end: homeDashboardData, TriageBoardPage, reminders.

-- ── 1. Deadline counts exclude former clients ───────────────────────────────
-- Preserves the live definition from sql/127 (sa = submission tasks only, no
-- double count); the ONLY change is the entity join + former-client filter.
-- Left join so tasks with no/unmatched entity are still counted (only nlac /
-- archived are dropped).
create or replace view public.v_deadline_buckets
with (security_invoker = true) as
with base as (
  select b.service, b.bm_task_name, b.bm_deadline
  from bm_task_schedule b
  left join entities e on e.id = b.entity_id
  where b.state = 'planned' and b.excluded_at is null and b.bm_deadline is not null
    and coalesce(e.entity_status::text, 'active') not in ('nlac', 'archived')
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

-- ── 2. Don't auto-raise strike-off triage cases for former clients ──────────
-- Defence in depth: even if a status event lands for a former client (e.g. a
-- manual refresh, or a change detected before offboarding), no triage case is
-- created. The nightly refresh is separately taught to skip them at source.
create or replace function public.triage_from_ch_status_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_case_id uuid;
  v_status  entity_status;
begin
  if (new.new_status || ' ' || coalesce(new.new_detail, '')) !~* '(strike|liquidat|administrat|insolven|dissolv|receiver)' then
    return new;
  end if;
  -- No work is done for former clients — they don't belong on the board.
  select entity_status into v_status from entities where id = new.entity_id;
  if v_status in ('nlac', 'archived') then
    return new;
  end if;
  -- One open strike_off case per client; add a note instead of a duplicate.
  select id into v_case_id from triage_cases
   where entity_id = new.entity_id and category = 'strike_off' and status = 'open'
   limit 1;
  if v_case_id is null then
    insert into triage_cases (entity_id, category, description, source, ch_status_event_id)
    values (
      new.entity_id, 'strike_off',
      'Companies House status changed: ' || coalesce(new.old_status, 'unknown') ||
        coalesce(' (' || new.old_detail || ')', '') || ' → ' || new.new_status ||
        coalesce(' (' || new.new_detail || ')', ''),
      'ch_status', new.id
    )
    returning id into v_case_id;
  else
    insert into triage_case_notes (case_id, body)
    values (v_case_id, 'Further Companies House status change: ' || new.new_status ||
      coalesce(' (' || new.new_detail || ')', ''));
  end if;
  update ch_status_events set triage_case_id = v_case_id where id = new.id;
  return new;
end $$;

-- ── 3. Self-heal existing former-client state ───────────────────────────────
-- Resolve open triage cases that belong to former clients (mirrors the way 129
-- self-heals open job-review cycles). Leaves a note so the history is honest.
with to_resolve as (
  select tc.id
  from triage_cases tc
  join entities e on e.id = tc.entity_id
  where tc.status = 'open'
    and e.entity_status in ('nlac', 'archived')
), noted as (
  insert into triage_case_notes (case_id, body)
  select id, 'Auto-resolved: client is no longer a client (removed from operational views).'
  from to_resolve
  returning 1
)
update triage_cases tc
   set status = 'resolved', resolved_at = now()
  from to_resolve r
 where tc.id = r.id;

-- Stall any still-open CH personal-code requests for former clients. offboard_
-- entity() does this at button time, but clients made nlac via BM import (or
-- whose request was mid-submission at offboard) were never stalled.
with to_stall as (
  update ch_code_requests r
     set status = 'stalled', stage = 's7_rejected', updated_at = now()
    from entities e
   where r.entity_id = e.id
     and e.entity_status in ('nlac', 'archived')
     and r.stage not in ('s6_submitted', 's7_rejected')
  returning r.id
)
insert into ch_code_activity (request_id, kind, body, created_by)
select id, 'system', 'Client is no longer a client — request stalled (removed from chasing).', null
from to_stall;

-- ── 4. Onboarding updates feed excludes former clients ──────────────────────
-- Recreates v_onboarding_updates (from schema_onboarding_updates_admin_tasks)
-- adding an entity_status filter to every branch, plus an archived_at guard on
-- the onboarding branches (offboard_entity archives via archived_at, not status).
create or replace view v_onboarding_updates with (security_invoker = true) as
  select o.id as onboarding_id, e.id as entity_id, e.name as entity_name,
         'milestone'::text as kind, s.name as title, s.completed_at as happened_at
    from onboarding_steps s
    join onboardings o on o.id = s.onboarding_id
    join entities e on e.id = o.entity_id
   where s.milestone and s.status = 'complete' and s.completed_at is not null
     and o.archived_at is null and e.entity_status not in ('nlac', 'archived')
  union all
  select r.onboarding_id, e.id, e.name, 'service_request',
         'Client requested a new service: ' || coalesce(r.service_title, r.service_id), r.created_at
    from portal_service_requests r
    join entities e on e.id = r.entity_id
   where e.entity_status not in ('nlac', 'archived')
  union all
  select o.id, e.id, e.name, 'started', 'Onboarding started', o.created_at
    from onboardings o join entities e on e.id = o.entity_id
   where o.status <> 'cancelled'
     and o.archived_at is null and e.entity_status not in ('nlac', 'archived')
  union all
  select o.id, e.id, e.name, 'completed', 'Onboarding complete 🎉', o.completed_at
    from onboardings o join entities e on e.id = o.entity_id
   where o.completed_at is not null
     and o.archived_at is null and e.entity_status not in ('nlac', 'archived');

-- ── 5. Work Planner capacity / allocation / cadence views ───────────────────
-- These read bm_task_schedule directly for capacity inference. A former
-- client's leftover planned tasks were still inflating staff allocation and
-- capacity numbers (and showing as their inferred work). NOT EXISTS preserves
-- rows with a null/unmatched entity_id; only nlac/archived are dropped. Column
-- signatures are unchanged, so dependents (v_service_cadence reads
-- v_inferred_allocations) replace cleanly. Definitions mirror sql/056 + sql/051.

create or replace view v_inferred_allocations as
with classified as (
  select
    bts.entity_id,
    bts.assignee_id,
    case
      when bts.service = 'Bookkeeping' then 'bookkeeping'
      when bts.service = 'VAT' and bts.bm_task_name ilike '%Submission%' then 'vat_review'
      when bts.service = 'Annual Accounts' and bts.bm_task_name ilike 'Accounts Preparation%' then 'accounts_preparation'
      when (bts.service = 'Annual Accounts' and bts.bm_task_name ilike '%Companies House Submission%')
        or (bts.service = 'Corporation Tax' and bts.bm_task_name ilike 'CT600 Submission%') then 'accounts_submission'
      when bts.service = 'Self Assessment' and bts.bm_task_name ilike '%Submission%' then 'self_assessment'
      else null
    end as canonical_service_id
  from bm_task_schedule bts
  where coalesce(bts.state, 'committed') <> 'discarded'
    and not exists (select 1 from entities e where e.id = bts.entity_id and e.entity_status in ('nlac', 'archived'))
),
ranked as (
  select entity_id, canonical_service_id, assignee_id, count(*) as task_count,
    row_number() over (partition by entity_id, canonical_service_id
      order by (assignee_id is null), count(*) desc, assignee_id) as rn
  from classified
  where canonical_service_id is not null
  group by entity_id, canonical_service_id, assignee_id
),
direct as (
  select entity_id, canonical_service_id, assignee_id, task_count from ranked where rn = 1
)
select entity_id, canonical_service_id, assignee_id, task_count, false as via_fallback
from direct
union all
select d.entity_id, 'accounts_preparation', d.assignee_id, d.task_count, true
from direct d
where d.canonical_service_id = 'accounts_submission'
  and not exists (select 1 from direct d2 where d2.entity_id = d.entity_id
                  and d2.canonical_service_id = 'accounts_preparation');

create or replace view v_bm_load_classified as
select
  bts.entity_id,
  case
    when bts.service = 'Bookkeeping' then 'bookkeeping'
    when bts.service = 'VAT' and bts.bm_task_name ilike '%Submission%' then 'vat_review'
    when bts.service = 'Annual Accounts' and bts.bm_task_name ilike 'Accounts Preparation%' then 'accounts_preparation'
    when (bts.service = 'Annual Accounts' and bts.bm_task_name ilike '%Companies House Submission%')
      or (bts.service = 'Corporation Tax' and bts.bm_task_name ilike 'CT600 Submission%') then 'accounts_submission'
    when bts.service = 'Self Assessment' and bts.bm_task_name ilike '%Submission%' then 'self_assessment'
    else null
  end as canonical_service_id,
  bts.assignee_id,
  date_trunc('month', bts.scheduled_for_date)::date as month,
  coalesce(bts.scheduled_hours, 0)::numeric as hours
from bm_task_schedule bts
where bts.scheduled_for_date is not null
  and bts.assignee_id is not null
  and coalesce(bts.state, 'committed') <> 'discarded'
  and not exists (select 1 from entities e where e.id = bts.entity_id and e.entity_status in ('nlac', 'archived'));

create or replace view v_capacity_load_monthly as
select
  bts.assignee_id,
  date_trunc('month', bts.scheduled_for_date)::date as month,
  sum(coalesce(bts.scheduled_hours, 0))::numeric    as hours,
  count(*)                                          as task_count
from bm_task_schedule bts
where bts.scheduled_for_date is not null
  and bts.assignee_id is not null
  and coalesce(bts.state, 'committed') <> 'discarded'
  and not exists (select 1 from entities e where e.id = bts.entity_id and e.entity_status in ('nlac', 'archived'))
group by bts.assignee_id, date_trunc('month', bts.scheduled_for_date);

create or replace view v_service_cadence as
with bookkeeping_counts as (
  select entity_id, count(distinct bm_target_date) as n
  from bm_task_schedule bts
  where service = 'Bookkeeping'
    and coalesce(state, 'committed') <> 'discarded'
    and bm_target_date is not null
    and bm_target_date between current_date - interval '6 months' and current_date + interval '12 months'
    and not exists (select 1 from entities e where e.id = bts.entity_id and e.entity_status in ('nlac', 'archived'))
  group by entity_id
),
vat_cadence as (
  select entity_id,
    case when bool_or(bm_task_name ilike '%Monthly%') then 'monthly' else 'quarterly' end as cadence
  from bm_task_schedule bts
  where service = 'VAT'
    and bm_task_name ilike '%Submission%'
    and coalesce(state, 'committed') <> 'discarded'
    and not exists (select 1 from entities e where e.id = bts.entity_id and e.entity_status in ('nlac', 'archived'))
  group by entity_id
)
select entity_id, 'bookkeeping'::text as canonical_service_id,
       case when n >= 9 then 'monthly' else 'quarterly' end as cadence
from bookkeeping_counts
union all
select entity_id, 'vat_review'::text, cadence from vat_cadence
union all
select distinct entity_id, canonical_service_id, 'annual'::text as cadence
from v_inferred_allocations
where canonical_service_id in ('accounts_preparation', 'accounts_submission', 'self_assessment');

-- Preview / Workload calendar source (per-task detail, sql/043). Same rule:
-- a former client's scheduled tasks must not show on anyone's planner. Column
-- list is unchanged from 043, so CREATE OR REPLACE keeps every consumer + grant.
create or replace view public.bm_task_schedule_with_progress as
select
  s.id, s.bm_task_id, s.entity_id, s.rule_id, s.bm_task_name, s.service,
  s.bm_deadline, s.bm_target_date, s.bm_status, s.bm_latest_action_date,
  s.assignee_id, s.bm_assignee_name, s.scheduled_for_date, s.scheduled_hours,
  s.manually_overridden_at, s.manually_overridden_by, s.state, s.status,
  s.draft_cycle_id, s.approved_at, s.approved_by, s.committed_at,
  s.last_import_id, s.last_seen_at, s.created_at, s.updated_at,
  coalesce(round(sum(t.minutes)::numeric / 60::numeric, 2), 0::numeric) as logged_hours,
  greatest(0::numeric, s.scheduled_hours - coalesce(round(sum(t.minutes)::numeric / 60::numeric, 2), 0::numeric)) as remaining_hours
from public.bm_task_schedule s
left join public.timesheet_entries t on t.source_task_id = s.id
where not exists (select 1 from entities e where e.id = s.entity_id and e.entity_status in ('nlac', 'archived'))
group by s.id;
