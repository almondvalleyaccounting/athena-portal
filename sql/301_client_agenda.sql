-- ============================================================
-- 301 — Client meeting agenda
--
-- A running list, per client, of things to talk to them about. Each item sits
-- in one of two buckets:
--
--   agenda — goes on the next meeting's agenda (the printable/copyable one)
--   info   — for information only: stays on the client page as a note
--
-- Items are archived once discussed (never deleted — the history of what we
-- raised with a client is worth keeping) and can spawn a Work Planner action.
--
-- Private notes live in their own table, not a column on the item. The agenda
-- is the thing that leaves the building; the notes are what the person running
-- the meeting reads from. Keeping them apart means anything that ever exposes
-- items further (a portal view, an export) cannot take the notes with it by
-- selecting '*'. Removing the possibility beats remembering to name columns.
--
-- Access: every active staff member reads and writes (there is no per-client
-- staff restriction in Athena — entities is is_active_staff()). Portal clients
-- hold `authenticated` too, so the predicate is is_active_staff(), never a bare
-- role check. Writes go through the client-agenda edge function (CLAUDE.md:
-- a new mutating path is an edge function), so the browser holds SELECT only.
-- ============================================================

create table if not exists public.client_agenda_items (
  id             uuid primary key default gen_random_uuid(),
  entity_id      uuid not null references public.entities(id) on delete cascade,
  body           text not null check (length(btrim(body)) > 0),
  bucket         text not null default 'agenda' check (bucket in ('agenda', 'info')),
  sort_order     integer not null default 0,
  created_by     uuid references public.staff_profiles(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_by     uuid references public.staff_profiles(id) on delete set null,
  updated_at     timestamptz not null default now(),
  archived_at    timestamptz,
  archived_by    uuid references public.staff_profiles(id) on delete set null,
  -- The action raised from this item. quick_tasks rows go when the task is
  -- completed, so the title is kept alongside and survives the pointer.
  action_task_id uuid references public.quick_tasks(id) on delete set null,
  action_title   text,
  action_raised_at timestamptz
);

comment on table public.client_agenda_items is
  'Things to discuss with a client. bucket=agenda makes the next meeting agenda; '
  'bucket=info is a standing note. Archived once discussed. Private notes are in '
  'client_agenda_notes and never on this table.';

create index if not exists client_agenda_items_entity_idx
  on public.client_agenda_items (entity_id, bucket, sort_order)
  where archived_at is null;

create table if not exists public.client_agenda_notes (
  id         uuid primary key default gen_random_uuid(),
  item_id    uuid not null references public.client_agenda_items(id) on delete cascade,
  author_id  uuid references public.staff_profiles(id) on delete set null,
  body       text not null check (length(btrim(body)) > 0),
  created_at timestamptz not null default now()
);

comment on table public.client_agenda_notes is
  'Private, staff-only notes against an agenda item. Never shown to the client '
  'and never printed on the agenda.';

create index if not exists client_agenda_notes_item_idx
  on public.client_agenda_notes (item_id, created_at);

-- ── Staff read; nobody in a browser writes ──────────────────────────────────
alter table public.client_agenda_items enable row level security;
alter table public.client_agenda_notes enable row level security;

drop policy if exists client_agenda_items_select_staff on public.client_agenda_items;
create policy client_agenda_items_select_staff
  on public.client_agenda_items
  for select to authenticated
  using (is_active_staff());

drop policy if exists client_agenda_notes_select_staff on public.client_agenda_notes;
create policy client_agenda_notes_select_staff
  on public.client_agenda_notes
  for select to authenticated
  using (is_active_staff());

-- The schema default privilege grants everything to anon and authenticated at
-- creation (see sql/268). Revoke the writes by name so the grant says what is
-- true rather than leaning on the absence of a policy.
revoke all on public.client_agenda_items from public, anon;
revoke all on public.client_agenda_notes from public, anon;
revoke insert, update, delete, truncate, references, trigger
  on public.client_agenda_items from authenticated;
revoke insert, update, delete, truncate, references, trigger
  on public.client_agenda_notes from authenticated;
grant select on public.client_agenda_items to authenticated;
grant select on public.client_agenda_notes to authenticated;
grant select, insert, update, delete on public.client_agenda_items to service_role;
grant select, insert, update, delete on public.client_agenda_notes to service_role;
