-- ============================================================
-- 315 — Task comments
--
-- Bobby, 2026-09-26: one task modal for every kind of task, with comments.
-- An email to a colleague about a task starts the thread (kind 'email');
-- when someone replies in Athena the reply is held here and the others on
-- the thread get a notification email with the text. A rough stand-in for
-- a chat feature; emails may come out of it later.
--
-- task_type / task_id: 'ms' = job_milestones.id, 'bm' = bm_task_schedule.id,
-- 'quick' = quick_tasks.id, 'block' = scheduled_tasks.id + occurrence_date.
-- Written only through job-plan (add_comment, send_email).
-- ============================================================

create table if not exists public.task_comments (
  id              uuid primary key default gen_random_uuid(),
  task_type       text not null check (task_type in ('ms','bm','quick','block')),
  task_id         uuid not null,
  occurrence_date date,
  entity_id       uuid references public.entities(id) on delete set null,
  task_label      text,
  author_id       uuid references public.staff_profiles(id) on delete set null,
  body            text not null,
  kind            text not null default 'comment' check (kind in ('comment','email')),
  to_staff_id     uuid references public.staff_profiles(id) on delete set null,
  to_email        text,
  notified_at     timestamptz,
  created_at      timestamptz not null default now()
);
create index if not exists task_comments_task_idx on public.task_comments (task_type, task_id, created_at);
comment on table public.task_comments is 'Comments and outbound emails on a task (sql/315); replies notify the others on the thread.';

alter table public.task_comments enable row level security;
drop policy if exists task_comments_select_staff on public.task_comments;
create policy task_comments_select_staff on public.task_comments
  for select to authenticated using (is_active_staff());
revoke all on public.task_comments from public, anon;
revoke insert, update, delete, truncate, references, trigger on public.task_comments from authenticated;
grant select on public.task_comments to authenticated;
grant select, insert, update, delete on public.task_comments to service_role;
