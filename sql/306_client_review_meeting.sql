-- ============================================================
-- 306 — Which clients get an annual review meeting
--
-- The accounts workflow gives a client the meeting stages when they have the
-- service. Bobby, 2026-09-26: far more clients have it than the fee engine's
-- committed fees show — it is billed through the QuickBooks recurring
-- templates (live_billing.services, item "Review Meetings" or a line
-- described "Annual Review Meeting"), included in some packages, and in a
-- few cases baked into the accounts fee. So:
--
--   v_client_review_meeting   the derived answer per client: a manual row
--                             wins; otherwise "billed" if the live billing
--                             carries a meeting line; otherwise none.
--   client_review_meetings    the manual layer the team sets (included in a
--                             package, baked into the accounts fee, or simply
--                             "we meet them"), written through job-plan.
--
-- v_accounts_jobs gains meeting_default and meeting_basis so Plan the Job
-- can show why a job has (or lacks) the meeting stages.
-- ============================================================

create table if not exists public.client_review_meetings (
  entity_id   uuid primary key references public.entities(id) on delete cascade,
  has_meeting boolean not null,
  basis       text not null default 'manual'
    check (basis in ('manual', 'package', 'included_in_accounts')),
  note        text,
  set_by      uuid references public.staff_profiles(id) on delete set null,
  set_at      timestamptz not null default now()
);
comment on table public.client_review_meetings is
  'Manual answer to "does this client get an annual review meeting", overriding what the billing says. Set from Plan the Job.';

alter table public.client_review_meetings enable row level security;
drop policy if exists client_review_meetings_select_staff on public.client_review_meetings;
create policy client_review_meetings_select_staff on public.client_review_meetings
  for select to authenticated using (is_active_staff());
revoke all on public.client_review_meetings from public, anon;
revoke insert, update, delete, truncate, references, trigger on public.client_review_meetings from authenticated;
grant select on public.client_review_meetings to authenticated;
grant select, insert, update, delete on public.client_review_meetings to service_role;

create or replace view public.v_client_review_meeting
with (security_invoker = true) as
with billed as (
  select distinct lb.entity_id
  from live_billing lb, jsonb_array_elements(lb.services) s
  where lb.status = 'active'
    and (
      s->>'service_id' ilike '%review meeting%'
      or s->>'description' ilike '%review meeting%'
    )
)
select
  e.id                                         as entity_id,
  coalesce(m.has_meeting, b.entity_id is not null) as has_meeting,
  case
    when m.entity_id is not null then m.basis
    when b.entity_id is not null then 'billed'
    else 'none'
  end                                          as basis,
  m.note,
  m.set_by,
  m.set_at
from entities e
left join client_review_meetings m on m.entity_id = e.id
left join billed b on b.entity_id = e.id;

comment on view public.v_client_review_meeting is
  'Per client: has an annual review meeting? Manual row wins, else billed through the live QuickBooks templates, else none.';

revoke all on public.v_client_review_meeting from public, anon;
grant select on public.v_client_review_meeting to authenticated, service_role;

-- v_accounts_jobs: add the meeting default and its basis.
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
  rm.basis                                 as meeting_basis
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
