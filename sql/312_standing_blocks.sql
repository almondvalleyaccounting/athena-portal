-- ============================================================
-- 312 — Standing blocks (the Scheduled tab, repurposed)
--
-- Bobby, 2026-09-26: the team has repeating blocks of time that BrightManager
-- knows nothing about — mail handling, generic onboarding, confirmation
-- statements, weekly and monthly payroll — and he does not want them as BM
-- tasks. So a scheduled_tasks master becomes a "standing block": a kind, a
-- person, a cadence (working days, chosen days, or monthly), hours, and for
-- payroll a list of clients so the block breaks down by client when it is
-- completed. Time logged at client or block level lands on the timesheet.
--
-- scheduled_tasks was empty, so nothing existing is reinterpreted.
-- ============================================================

alter table public.scheduled_tasks
  add column if not exists block_kind text,
  add column if not exists weekdays   text;   -- 'mon,tue,wed,thu,fri' for daily cadences
alter table public.scheduled_tasks drop constraint if exists scheduled_tasks_block_kind_check;
alter table public.scheduled_tasks add constraint scheduled_tasks_block_kind_check
  check (block_kind is null or block_kind in ('mail','onboarding','confirmation_statements','payroll_weekly','payroll_monthly','bookkeeping','admin','other'));
comment on column public.scheduled_tasks.block_kind is 'Standing block kind (sql/312); null for a plain scheduled task.';
comment on column public.scheduled_tasks.weekdays   is 'Days a daily cadence falls on, e.g. mon,tue,wed,thu,fri.';

-- The block's sub-tasks: one per client for payroll, free labels otherwise.
create table if not exists public.standing_block_items (
  id              uuid primary key default gen_random_uuid(),
  block_id        uuid not null references public.scheduled_tasks(id) on delete cascade,
  entity_id       uuid references public.entities(id) on delete cascade,
  label           text,
  minutes_default integer,
  sort_order      integer not null default 0,
  created_at      timestamptz not null default now()
);
create index if not exists standing_block_items_block_idx on public.standing_block_items (block_id, sort_order);
comment on table public.standing_block_items is 'Sub-tasks of a standing block (sql/312), typically one per payroll client.';

alter table public.standing_block_items enable row level security;
drop policy if exists standing_block_items_select_staff on public.standing_block_items;
create policy standing_block_items_select_staff on public.standing_block_items
  for select to authenticated using (is_active_staff());
revoke all on public.standing_block_items from public, anon;
revoke insert, update, delete, truncate, references, trigger on public.standing_block_items from authenticated;
grant select on public.standing_block_items to authenticated;
grant select, insert, update, delete on public.standing_block_items to service_role;

-- Hygiene while here: these planner tables carried table-level grants to anon
-- from their first migration. RLS already returned nothing to anon; now the
-- grant is gone too.
revoke all on public.scheduled_tasks, public.completed_tasks, public.instance_overrides, public.task_progress_notes from anon;
