-- 183: Private 1-2-1 prep notes + a cross-module "what's on their plate" feed.
--
-- The ask (Bobby, 2026-08-06): before a 1-2-1 I need somewhere to jot things
-- down as the month evolves — work points and development points — and those
-- notes must be MINE. If I record feedback for Sophie that I want to raise face
-- to face, Sophie must not be able to read it in Athena. Everyone gets the same
-- facility for the people they run 1-2-1s with.
--
-- Privacy is enforced in the database, not the UI: every policy on
-- pd_prep_notes is `author_id = auth.uid()`. staff_profiles.id IS auth.uid()
-- in this schema (see the staff_profiles policies), so the subject of a note
-- has no read path to it — not via the API, not via a crafted query. This is
-- deliberately TIGHTER than the rest of the pd_* tables, which are open to any
-- active staff member.
--
-- Part 2 is v_staff_work_feed: one union of everything currently on a person's
-- plate across Athena (BM jobs, the open job-review cycle, planner tasks, quick
-- tasks, PD objectives, assigned bugs/issues, onboarding steps) so a manager can
-- skim it during prep and attach a note to a specific job. Notes carry a
-- denormalised link_label/link_url so they still read correctly after the source
-- row is closed or re-created by a BM import.
--
-- Former clients (nlac/archived) are filtered out of the feed — same read-time
-- rule as sql/134.

-- ── 1. The notes table ──────────────────────────────────────────────────────

create table if not exists public.pd_prep_notes (
  id            uuid primary key default gen_random_uuid(),
  author_id     uuid not null references public.staff_profiles(id) on delete cascade,
  subject_id    uuid not null references public.staff_profiles(id) on delete cascade,
  kind          text not null default 'work' check (kind in ('work', 'development')),
  body          text not null,
  status        text not null default 'open' check (status in ('open', 'discussed', 'parked')),
  pinned        boolean not null default false,

  -- Set when the note is carried into a logged 1-2-1.
  one_to_one_id uuid references public.pd_one_to_ones(id) on delete set null,
  discussed_at  timestamptz,

  -- Optional link back to the item that prompted the note. Denormalised on
  -- purpose: label/url survive the source row being closed or re-imported.
  link_source   text check (link_source in (
                  'bm_job', 'job_review', 'planner_task', 'quick_task',
                  'objective', 'bug', 'issue', 'onboarding_step')),
  link_ref_id   text,
  link_label    text,
  link_url      text,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists pd_prep_notes_author_subject_idx
  on public.pd_prep_notes (author_id, subject_id, status, created_at desc);
create index if not exists pd_prep_notes_meeting_idx
  on public.pd_prep_notes (one_to_one_id) where one_to_one_id is not null;

create or replace function public.pd_prep_notes_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists pd_prep_notes_touch on public.pd_prep_notes;
create trigger pd_prep_notes_touch
  before update on public.pd_prep_notes
  for each row execute function public.pd_prep_notes_touch();

-- ── 2. RLS: author-only, no exceptions (not even portal admins) ─────────────

alter table public.pd_prep_notes enable row level security;

drop policy if exists pd_prep_notes_select on public.pd_prep_notes;
create policy pd_prep_notes_select on public.pd_prep_notes
  for select using (author_id = auth.uid());

drop policy if exists pd_prep_notes_insert on public.pd_prep_notes;
create policy pd_prep_notes_insert on public.pd_prep_notes
  for insert with check (author_id = auth.uid() and public.is_active_staff());

drop policy if exists pd_prep_notes_update on public.pd_prep_notes;
create policy pd_prep_notes_update on public.pd_prep_notes
  for update using (author_id = auth.uid()) with check (author_id = auth.uid());

drop policy if exists pd_prep_notes_delete on public.pd_prep_notes;
create policy pd_prep_notes_delete on public.pd_prep_notes
  for delete using (author_id = auth.uid());

comment on table public.pd_prep_notes is
  'Private 1-2-1 preparation notes. Visible ONLY to author_id — the subject of '
  'the note cannot read it. Deliberately tighter RLS than the other pd_* tables.';

-- ── 3. Cross-module work feed for one staff member ──────────────────────────
-- security_invoker: each source table''s own RLS still applies, so a manager
-- without work_planner simply sees no planner rows rather than an error.

create or replace view public.v_staff_work_feed
with (security_invoker = true) as

-- Live BrightManager jobs (state = 'planned' is the not-yet-done cohort).
select
  b.assignee_id                      as staff_id,
  'bm_job'::text                     as source,
  'Client job'::text                 as source_label,
  b.id::text                         as ref_id,
  coalesce(b.bm_task_name, b.service, 'Job') as title,
  e.name                             as client_name,
  b.service                          as service,
  b.bm_status                        as status,
  b.bm_deadline                      as due_date,
  coalesce(b.bm_deadline, b.bm_target_date, b.scheduled_for_date) as sort_date,
  case when b.entity_id is not null then '/clients/' || b.entity_id::text end as url,
  jsonb_build_object(
    'target_date', b.bm_target_date,
    'scheduled_for', b.scheduled_for_date,
    'scheduled_hours', b.scheduled_hours,
    'latest_action', b.bm_latest_action_date
  )                                  as detail
from public.bm_task_schedule b
left join public.entities e on e.id = b.entity_id
where b.state = 'planned'
  and b.excluded_at is null
  and b.assignee_id is not null
  and coalesce(e.entity_status::text, 'active') not in ('nlac', 'archived')

union all

-- Items in the currently-open job review cycle (the monthly stalled-job loop).
select
  j.assignee_id,
  'job_review',
  'Job review',
  j.id::text,
  coalesce(j.service, 'Job') || coalesce(' · ' || to_char(j.period_end, 'Mon YYYY'), ''),
  j.client_name,
  j.service,
  coalesce(j.bm_status_snapshot, j.box),
  j.bm_deadline,
  j.bm_deadline,
  '/review',
  jsonb_build_object(
    'box', j.box,
    'days_past', j.days_past,
    'movement', j.movement,
    'reason_code', j.reason_code,
    'needs_help', j.needs_help,
    'note', j.note,
    'next_action_code', j.next_action_code,
    'responded_at', j.responded_at
  )
from public.job_review_item j
join public.job_review_cycle c on c.id = j.cycle_id and c.status = 'open'
left join public.entities e on e.id = j.entity_id
where j.assignee_id is not null
  and coalesce(e.entity_status::text, 'active') not in ('nlac', 'archived')

union all

-- Work planner scheduled tasks.
select
  t.assignee_id,
  'planner_task',
  'Planner task',
  t.id::text,
  t.title,
  e.name,
  t.service,
  t.status,
  t.planned_date::date,
  t.planned_date::date,
  '/planner/tasks/' || t.id::text,
  jsonb_build_object('duration', t.duration, 'recurring', t.recurring, 'task_type', t.task_type)
from public.scheduled_tasks t
left join public.entities e on e.id = t.entity_id
where t.assignee_id is not null
  and coalesce(t.status, '') not in ('done', 'complete', 'completed', 'cancelled')
  and coalesce(e.entity_status::text, 'active') not in ('nlac', 'archived')

union all

-- Quick tasks (includes 1-2-1 actions, which land here via createAction).
select
  q.assignee_id,
  'quick_task',
  'Quick task',
  q.id::text,
  q.title,
  e.name,
  q.service,
  null,
  q.due_date::date,
  coalesce(q.due_date, q.planned_date)::date,
  '/planner',
  jsonb_build_object('duration', q.duration, 'notes', q.notes, 'origin', q.source)
from public.quick_tasks q
left join public.entities e on e.id = q.entity_id
where q.assignee_id is not null
  and coalesce(e.entity_status::text, 'active') not in ('nlac', 'archived')

union all

-- Development objectives.
select
  o.staff_id,
  'objective',
  'Objective',
  o.id::text,
  o.title,
  null,
  null,
  o.status,
  o.target_date,
  o.target_date,
  '/team/pd/objectives',
  jsonb_build_object('progress_pct', o.progress_pct, 'priority', o.priority, 'description', o.description)
from public.pd_objectives o
where coalesce(o.status, '') <> 'complete'

union all

-- Bugs assigned to them.
select
  g.assignee_id,
  'bug',
  'Bug',
  g.id::text,
  g.title,
  null,
  g.module,
  g.status,
  null,
  g.created_at::date,
  '/bugs',
  jsonb_build_object('priority', g.priority, 'target', g.target, 'seq', g.seq)
from public.bugs g
where g.assignee_id is not null
  and coalesce(g.status, '') not in ('closed', 'rejected', 'duplicate', 'verified')

union all

-- Issues log entries assigned to them.
select
  i.assignee_id,
  'issue',
  'Issue',
  i.id::text,
  i.title,
  e.name,
  i.category,
  i.status,
  null,
  i.created_at::date,
  '/issues',
  jsonb_build_object('priority', i.priority, 'description', i.description)
from public.issues_log i
left join public.entities e on e.id = i.entity_id
where i.assignee_id is not null
  and coalesce(i.status, '') not in ('closed', 'resolved')

union all

-- Open onboarding steps they own.
select
  s.assignee_id,
  'onboarding_step',
  'Onboarding',
  s.id::text,
  s.name,
  e.name,
  s.group_name,
  s.status,
  null,
  s.updated_at::date,
  '/onboarding/' || s.onboarding_id::text,
  jsonb_build_object('group', s.group_name, 'note', s.note, 'chase_count', s.chase_count)
from public.onboarding_steps s
join public.onboardings ob on ob.id = s.onboarding_id
left join public.entities e on e.id = ob.entity_id
where s.assignee_id is not null
  and ob.status in ('active', 'issues')          -- not steps left behind on a finished onboarding
  and coalesce(s.status, '') not in ('complete', 'na')
  and coalesce(e.entity_status::text, 'active') not in ('nlac', 'archived');

comment on view public.v_staff_work_feed is
  'Everything currently on one staff member''s plate across Athena, for 1-2-1 '
  'prep. security_invoker — each source table''s RLS still applies.';
