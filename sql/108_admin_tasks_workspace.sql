-- ============================================================
-- Admin task list → Sophie's workspace.
-- Adds a per-task deadline, an escalation trail, and a notes/responses thread
-- so the list is actionable: chase, discuss, and hand off from one page.
-- ============================================================

-- ── Per-task deadline + escalation state ─────────────────────
alter table admin_tasks
  add column if not exists deadline        date,
  add column if not exists escalated_to    uuid references staff_profiles(id) on delete set null,
  add column if not exists escalated_at    timestamptz,
  add column if not exists escalation_note text;

comment on column admin_tasks.deadline is 'Optional target date Sophie sets to work the list by urgency.';
comment on column admin_tasks.escalated_to is 'Staff member asked to action this task (set when escalated).';

-- ── Notes & responses thread (one row per message) ──────────
create table if not exists admin_task_notes (
  id         uuid primary key default gen_random_uuid(),
  task_id    uuid not null references admin_tasks(id) on delete cascade,
  author_id  uuid references staff_profiles(id) on delete set null,
  kind       text not null default 'note' check (kind in ('note','escalation','response')),
  body       text not null,
  created_at timestamptz not null default now()
);
create index if not exists admin_task_notes_task_idx on admin_task_notes(task_id, created_at);

comment on table admin_task_notes is 'Notes/responses thread on an admin task — plain notes, escalation messages, and replies.';

-- ── RLS: active staff read/write (internal tool) ─────────────
alter table admin_task_notes enable row level security;
drop policy if exists admin_task_notes_staff on admin_task_notes;
create policy admin_task_notes_staff on admin_task_notes
  for all to authenticated using (is_active_staff()) with check (is_active_staff());
