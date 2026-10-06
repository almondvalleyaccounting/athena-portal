-- 349_priority_board.sql
--
-- Priority board and Progress updates (Bobby, 2026-10-06).
--
-- Priority (Work → Planner → Priority): one column per preparer, one tile per
-- job with a filing in the next six months. The order of a column is the
-- order the person works it. Dates come from a capacity queue: walking down
-- the column, each job uses its preparation hours out of the hours a week
-- that person gives to that kind of work; the internal review date is when
-- they would get to it, never later than the statutory date less the buffer.
-- The internal review date IS the job's internal deadline: the board pins
-- the Internal review stage of the job's workflow, creating a draft workflow
-- when the job has none, and preparation follows it (review − 7 days).
--
-- Progress update replaces Job Review (sql/087–092): confidence, a blocker
-- reason (Job Review's list), Escalate, a note and an optional new date. A
-- new date re-ranks the job in its column, so the order stays the one source
-- of the dates. A job is "update due" when it has had no update for
-- progress_stale_days and its review date is within progress_window_days.
--
-- Browser: SELECT only. Every write goes through the job-plan edge function.

create table if not exists public.job_priority (
  template_key text not null check (template_key in ('annual_accounts', 'self_assessment')),
  entity_id    uuid not null references public.entities(id) on delete cascade,
  period_end   date not null,
  staff_id     uuid references public.staff_profiles(id) on delete set null,
  rank         integer not null,
  updated_by   uuid references public.staff_profiles(id) on delete set null,
  updated_at   timestamptz not null default now(),
  primary key (template_key, entity_id, period_end)
);
comment on table public.job_priority is
  'Priority board order (sql/349): a job''s place in its preparer''s column. Lower rank is worked first.';
create index if not exists job_priority_staff_idx on public.job_priority (template_key, staff_id, rank);

create table if not exists public.priority_capacity (
  staff_id     uuid not null references public.staff_profiles(id) on delete cascade,
  template_key text not null check (template_key in ('annual_accounts', 'self_assessment')),
  weekly_hours numeric(5,2) not null check (weekly_hours >= 0 and weekly_hours <= 80),
  updated_by   uuid references public.staff_profiles(id) on delete set null,
  updated_at   timestamptz not null default now(),
  primary key (staff_id, template_key)
);
comment on table public.priority_capacity is
  'Hours a week a person gives to one kind of work, for the Priority board queue (sql/349). No row = half their weekly capacity.';

create table if not exists public.job_progress_updates (
  id                    uuid primary key default gen_random_uuid(),
  template_key          text not null check (template_key in ('annual_accounts', 'self_assessment')),
  entity_id             uuid not null references public.entities(id) on delete cascade,
  period_end            date not null,
  plan_id               uuid references public.job_plans(id) on delete set null,
  author_id             uuid not null references public.staff_profiles(id),
  confidence            text not null check (confidence in ('green', 'amber', 'red')),
  reason_code           text references public.job_review_reason(code),
  escalate              boolean not null default false,
  note                  text check (note is null or char_length(note) <= 4000),
  review_date_before    date,
  review_date_requested date,
  review_date_after     date,
  created_at            timestamptz not null default now()
);
comment on table public.job_progress_updates is
  'Progress updates on a job (sql/349), replacing Job Review. A requested date re-ranks the job on the Priority board.';
create index if not exists job_progress_updates_job_idx on public.job_progress_updates (template_key, entity_id, period_end, created_at desc);

alter table public.job_plan_settings
  add column if not exists priority_buffer_wd   integer not null default 10 check (priority_buffer_wd between 0 and 40),
  add column if not exists progress_stale_days  integer not null default 14 check (progress_stale_days between 1 and 90),
  add column if not exists progress_window_days integer not null default 42 check (progress_window_days between 1 and 365);

-- ── Staff read; nobody in a browser writes ──────────────────────────────────
alter table public.job_priority         enable row level security;
alter table public.priority_capacity    enable row level security;
alter table public.job_progress_updates enable row level security;

drop policy if exists job_priority_read on public.job_priority;
create policy job_priority_read on public.job_priority for select using (public.is_active_staff());
drop policy if exists priority_capacity_read on public.priority_capacity;
create policy priority_capacity_read on public.priority_capacity for select using (public.is_active_staff());
drop policy if exists job_progress_updates_read on public.job_progress_updates;
create policy job_progress_updates_read on public.job_progress_updates for select using (public.is_active_staff());

revoke all on public.job_priority, public.priority_capacity, public.job_progress_updates from public, anon, authenticated;
grant select on public.job_priority, public.priority_capacity, public.job_progress_updates to authenticated;
grant all on public.job_priority, public.priority_capacity, public.job_progress_updates to service_role;
