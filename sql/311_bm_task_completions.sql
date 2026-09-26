-- ============================================================
-- 311 — "Mark complete" on a BrightManager job
--
-- Bobby, 2026-09-26: right-click a BM job on the Calendar and mark it
-- complete. Athena records it (with the minutes, straight to the timesheet)
-- and puts it on an "update in BrightManager" list that persists until the
-- next BM import shows the job gone, or the person ticks it off themselves.
-- BM stays the record; Athena stops waiting for it.
-- ============================================================

create table if not exists public.bm_task_completions (
  id                  uuid primary key default gen_random_uuid(),
  bm_task_schedule_id uuid references public.bm_task_schedule(id) on delete set null,
  bm_task_id          text,
  entity_id           uuid references public.entities(id) on delete set null,
  bm_task_name        text,
  service             text,
  completed_by        uuid references public.staff_profiles(id) on delete set null,
  completed_at        timestamptz not null default now(),
  minutes             integer,
  note                text,
  timesheet_entry_id  uuid,
  -- Set when BM agrees (the row left the export) or a person ticks it off.
  confirmed_at        timestamptz,
  confirmed_by        text check (confirmed_by in ('bm_import', 'staff'))
);
create index if not exists bm_task_completions_open_idx on public.bm_task_completions (completed_by, completed_at desc) where confirmed_at is null;
create unique index if not exists bm_task_completions_row_uq on public.bm_task_completions (bm_task_schedule_id) where bm_task_schedule_id is not null and confirmed_at is null;
comment on table public.bm_task_completions is
  'A BM job marked complete in Athena. Unconfirmed rows are the "update in BrightManager" list; confirmed when the next import shows the job gone or a person ticks it off.';

alter table public.bm_task_completions enable row level security;
drop policy if exists bm_task_completions_select_staff on public.bm_task_completions;
create policy bm_task_completions_select_staff on public.bm_task_completions
  for select to authenticated using (is_active_staff());
revoke all on public.bm_task_completions from public, anon;
revoke insert, update, delete, truncate, references, trigger on public.bm_task_completions from authenticated;
grant select on public.bm_task_completions to authenticated;
grant select, insert, update, delete on public.bm_task_completions to service_role;
