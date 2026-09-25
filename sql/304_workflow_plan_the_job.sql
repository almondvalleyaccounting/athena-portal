-- ============================================================
-- 304 — Workflow templates and "Plan the Job"
--
-- Design: docs/WORKFLOW_TEMPLATE_ACCOUNTS_2026-09-25.md (draft 2, agreed with
-- Bobby 2026-09-25). A BrightManager job is the spine; a workflow template
-- turns it into a chain of dated stages ("milestones") worked back from the
-- year end and the statutory dates. The chain is proposed, adjusted by the
-- preparer on the Plan the Job screen, and committed. A nightly pass (later)
-- keeps committed chains honest as gates slip.
--
-- Four tables:
--   workflow_templates  one per service flow (seeded: annual accounts)
--   workflow_stages     the stages of a template — data, not code
--   job_plans           one per (client, period end): draft or committed
--   job_milestones      the dated stages of a plan
--
-- and one view, v_accounts_jobs, which groups the Accounts Preparation /
-- Companies House Submission / CT600 rows of one year end into the "job" the
-- plan hangs off, with its plan status alongside.
--
-- Access: staff read everything; nothing in a browser writes. Writes go
-- through the job-plan edge function (CLAUDE.md: a new mutating path is an
-- edge function). Portal clients hold `authenticated` too, so every policy
-- is is_active_staff(), never a bare role check.
-- ============================================================

create table if not exists public.workflow_templates (
  id          uuid primary key default gen_random_uuid(),
  key         text not null unique,
  name        text not null,
  service     text not null,                 -- bm_task_schedule.service it applies to
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);
comment on table public.workflow_templates is
  'A service''s default chain of stages worked back from the year end. Stages are rows in workflow_stages.';

create table if not exists public.workflow_stages (
  id                 uuid primary key default gen_random_uuid(),
  template_id        uuid not null references public.workflow_templates(id) on delete cascade,
  seq                integer not null,
  key                text not null,
  label              text not null,
  kind               text not null check (kind in ('comms', 'milestone', 'work', 'calendar')),
  owner_role         text not null check (owner_role in ('client_manager', 'preparer', 'reviewer', 'bookkeeper', 'client')),
  -- Where the due date comes from: the year end, another stage, or a statutory date.
  anchor             text not null check (anchor in ('ye', 'stage', 'statutory_ch', 'statutory_ct')),
  anchor_stage_key   text,                   -- when anchor = 'stage'; "a|b" = first present
  offset_months      integer not null default 0,
  offset_days        integer not null default 0,
  -- Must be done before this stage can be worked ("a|b" = whichever is present).
  gate_stage_key     text,
  -- How the system knows it happened: manual | bm_status:<status> | ch_filed | bm_gone | calendar
  done_signal        text not null default 'manual',
  -- No earlier than <stage> + N days (the one-month records→meeting rule).
  min_gap_stage_key  text,
  min_gap_days       integer,
  -- Never later than the statutory date less N working days.
  hard_limit         text check (hard_limit in ('statutory_ch', 'statutory_ct')),
  hard_limit_buffer_wd integer not null default 10,
  hours              numeric(6,2),
  -- Only in some variants: meeting | no_meeting | books_with_us | books_not_with_us
  requires           text check (requires in ('meeting', 'no_meeting', 'books_with_us', 'books_not_with_us')),
  unique (template_id, key),
  unique (template_id, seq)
);
comment on table public.workflow_stages is
  'One stage of a workflow template. Dates are rules (anchor + offset, gates, minimum gaps, hard limits), resolved per job by the job-plan function.';

create table if not exists public.job_plans (
  id            uuid primary key default gen_random_uuid(),
  template_id   uuid not null references public.workflow_templates(id),
  entity_id     uuid not null references public.entities(id) on delete cascade,
  period_end    date not null,
  -- The BM rows this plan hangs off, as found when it was proposed.
  prep_job_id   uuid references public.bm_task_schedule(id) on delete set null,
  ch_job_id     uuid references public.bm_task_schedule(id) on delete set null,
  ct_job_id     uuid references public.bm_task_schedule(id) on delete set null,
  ch_deadline   date,
  ct_deadline   date,
  -- Variant switches. Null = take the default from the client's services and allocations.
  has_meeting   boolean,
  books_with_us boolean,
  status        text not null default 'draft' check (status in ('draft', 'committed')),
  note          text,
  planned_by    uuid references public.staff_profiles(id) on delete set null,
  planned_at    timestamptz,
  committed_by  uuid references public.staff_profiles(id) on delete set null,
  committed_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (entity_id, period_end, template_id)
);
comment on table public.job_plans is
  'The plan for one client''s job for one period end: a proposed chain of milestones, committed by the preparer.';
create index if not exists job_plans_entity_idx on public.job_plans (entity_id, period_end);

create table if not exists public.job_milestones (
  id            uuid primary key default gen_random_uuid(),
  plan_id       uuid not null references public.job_plans(id) on delete cascade,
  stage_key     text not null,
  seq           integer not null,
  label         text not null,
  kind          text not null,
  hours         numeric(6,2),
  owner_role    text not null,
  owner_id      uuid references public.staff_profiles(id) on delete set null,
  due_date      date not null,
  planned_date  date,
  status        text not null default 'pending' check (status in ('pending', 'done', 'skipped', 'removed')),
  done_at       timestamptz,
  done_signal   text,
  pinned_by     uuid references public.staff_profiles(id) on delete set null,
  pinned_at     timestamptz,
  note          text,
  updated_at    timestamptz not null default now(),
  unique (plan_id, stage_key)
);
comment on table public.job_milestones is
  'A dated stage of a job plan. A pinned milestone is never moved by the engine.';
create index if not exists job_milestones_owner_due_idx on public.job_milestones (owner_id, due_date) where status = 'pending';

-- ── Staff read; nobody in a browser writes ──────────────────────────────────
alter table public.workflow_templates enable row level security;
alter table public.workflow_stages    enable row level security;
alter table public.job_plans          enable row level security;
alter table public.job_milestones     enable row level security;

drop policy if exists workflow_templates_select_staff on public.workflow_templates;
create policy workflow_templates_select_staff on public.workflow_templates
  for select to authenticated using (is_active_staff());
drop policy if exists workflow_stages_select_staff on public.workflow_stages;
create policy workflow_stages_select_staff on public.workflow_stages
  for select to authenticated using (is_active_staff());
drop policy if exists job_plans_select_staff on public.job_plans;
create policy job_plans_select_staff on public.job_plans
  for select to authenticated using (is_active_staff());
drop policy if exists job_milestones_select_staff on public.job_milestones;
create policy job_milestones_select_staff on public.job_milestones
  for select to authenticated using (is_active_staff());

-- The schema default privilege grants everything to anon and authenticated at
-- creation (sql/268). Revoke by name so the grant says what is true.
revoke all on public.workflow_templates from public, anon;
revoke all on public.workflow_stages    from public, anon;
revoke all on public.job_plans          from public, anon;
revoke all on public.job_milestones     from public, anon;
revoke insert, update, delete, truncate, references, trigger on public.workflow_templates from authenticated;
revoke insert, update, delete, truncate, references, trigger on public.workflow_stages    from authenticated;
revoke insert, update, delete, truncate, references, trigger on public.job_plans          from authenticated;
revoke insert, update, delete, truncate, references, trigger on public.job_milestones     from authenticated;
grant select on public.workflow_templates, public.workflow_stages, public.job_plans, public.job_milestones to authenticated;
grant select, insert, update, delete on public.workflow_templates, public.workflow_stages, public.job_plans, public.job_milestones to service_role;

-- ── The accounts jobs, one row per client and period end ────────────────────
-- Groups the Accounts Preparation and Companies House Submission rows of one
-- year end, finds the matching CT600 row, and joins the plan if there is one.
-- security_invoker: bm_task_schedule and job_plans carry their own RLS.
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
  p.planned_at
from grouped g
join entities e on e.id = g.entity_id and e.entity_status not in ('nlac', 'archived')
left join lateral (
  select c.id, c.bm_deadline from ct c
  where c.entity_id = g.entity_id and c.period_end = g.period_end
  order by c.id limit 1
) c on true
left join staff_profiles sp on sp.id = g.preparer_id
left join job_plans p on p.entity_id = g.entity_id and p.period_end = g.period_end;

comment on view public.v_accounts_jobs is
  'One row per client and year end for planned Annual Accounts work, with the CT600 row and the job plan alongside.';

revoke all on public.v_accounts_jobs from public, anon;
grant select on public.v_accounts_jobs to authenticated, service_role;

-- ── Seed: the annual accounts template ──────────────────────────────────────
insert into public.workflow_templates (key, name, service)
values ('annual_accounts', 'Annual accounts', 'Annual Accounts')
on conflict (key) do nothing;

with t as (select id from public.workflow_templates where key = 'annual_accounts')
insert into public.workflow_stages
  (template_id, seq, key, label, kind, owner_role, anchor, anchor_stage_key, offset_months, offset_days,
   gate_stage_key, done_signal, min_gap_stage_key, min_gap_days, hard_limit, hours, requires)
select t.id, s.* from t, (values
  -- Records: request, chase, in (clients whose books we do not keep)
  (1,  'request_records',    'Request records',            'comms',     'client_manager', 'ye',    null,                               0, 7,   null,                          'manual',                       null, null, null, null, 'books_not_with_us'),
  (2,  'chase_1',            'Chase records',              'comms',     'client_manager', 'stage', 'request_records',                  0, 14,  'request_records',             'manual',                       null, null, null, null, 'books_not_with_us'),
  (3,  'chase_2',            'Chase records again',        'comms',     'client_manager', 'stage', 'request_records',                  0, 42,  'chase_1',                     'manual',                       null, null, null, null, 'books_not_with_us'),
  (4,  'records_in',         'Records in',                 'milestone', 'client',         'ye',    null,                               3, 0,   null,                          'bm_status:Records Received',   null, null, null, null, 'books_not_with_us'),
  -- Clients whose books we keep: one stage replaces the three above
  (5,  'close_books',        'Close the books to year end','work',      'bookkeeper',     'ye',    null,                               0, 42,  null,                          'manual',                       null, null, null, 2.00, 'books_with_us'),
  -- Preparation and review, worked back from the meeting or the send
  (6,  'prepare',            'Prepare accounts',           'work',      'preparer',       'stage', 'internal_review',                  0, -7,  'records_in|close_books',      'bm_status:To Review',          null, null, null, 5.00, null),
  (7,  'internal_review',    'Internal review',            'work',      'reviewer',       'stage', 'client_meeting|send_for_approval', 0, -14, 'prepare',                     'bm_status:Reviewed',           null, null, null, 1.00, null),
  -- The client step: a meeting, or send for approval
  (8,  'client_meeting',     'Client meeting',             'calendar',  'client_manager', 'ye',    null,                               6, 0,   'internal_review',             'calendar',                     'records_in|close_books', 30, null, 1.00, 'meeting'),
  (9,  'send_for_approval',  'Send for approval',          'comms',     'preparer',       'ye',    null,                               6, 0,   'internal_review',             'bm_status:Awaiting Approval',  'records_in|close_books', 30, null, null, 'no_meeting'),
  (10, 'approval',           'Client approval',            'comms',     'client_manager', 'stage', 'client_meeting|send_for_approval', 0, 14,  'client_meeting|send_for_approval', 'manual',                  null, null, null, null, null),
  -- Filing: accounts and CT600 the same day, each inside its statutory buffer
  (11, 'file_ch',            'File at Companies House',    'work',      'preparer',       'ye',    null,                               7, 0,   'approval',                    'ch_filed',                     null, null, 'statutory_ch', 0.50, null),
  (12, 'file_ct600',         'File CT600',                 'work',      'preparer',       'stage', 'file_ch',                          0, 0,   'approval',                    'bm_gone',                      null, null, 'statutory_ct', 0.50, null),
  (13, 'ct_payment_reminder','Corporation tax payment reminder', 'comms', 'client_manager', 'ye',  null,                               9, -21, 'file_ct600',                  'manual',                       null, null, null, null, null)
) as s(seq, key, label, kind, owner_role, anchor, anchor_stage_key, offset_months, offset_days,
       gate_stage_key, done_signal, min_gap_stage_key, min_gap_days, hard_limit, hours, requires)
on conflict (template_id, key) do nothing;
