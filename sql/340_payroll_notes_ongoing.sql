-- ============================================================
-- 340 — Payroll notes: this period only, or going forward; an audit trail
--
-- Bobby, 2026-09-28: adding a note is the thing the team do most in the
-- payroll modal. When they add one they choose: this period only, or going
-- forward — and going forward either until an end date or left open. A note
-- is never deleted: it is retired (sql/336), and every add / retire /
-- restore is logged.
--
--   kind = 'period'   shows in its own period only (every note before now)
--   kind = 'ongoing'  shows in every period of that client that overlaps
--                     starts_on .. ends_on (ends_on null = open-ended).
--                     period_id is the period it was added in.
--
-- Written only through payroll-tracker. delete_note is withdrawn from the
-- edge function; the table keeps its service_role grant for the importer.
-- ============================================================

alter table public.payroll_period_notes
  add column if not exists kind      text not null default 'period',
  add column if not exists starts_on date,
  add column if not exists ends_on   date;

alter table public.payroll_period_notes drop constraint if exists payroll_period_notes_kind_chk;
alter table public.payroll_period_notes add constraint payroll_period_notes_kind_chk
  check (kind in ('period', 'ongoing'));
alter table public.payroll_period_notes drop constraint if exists payroll_period_notes_ongoing_chk;
alter table public.payroll_period_notes add constraint payroll_period_notes_ongoing_chk
  check (kind = 'period' or (starts_on is not null and (ends_on is null or ends_on >= starts_on)));

create index if not exists payroll_period_notes_ongoing_idx
  on public.payroll_period_notes (client_id, starts_on) where kind = 'ongoing' and retired_at is null;

-- The audit trail: one row per thing done to a note.
create table if not exists public.payroll_note_log (
  id      uuid primary key default gen_random_uuid(),
  note_id uuid not null references public.payroll_period_notes(id) on delete cascade,
  action  text not null check (action in ('added', 'retired', 'restored')),
  by_id   uuid references public.staff_profiles(id) on delete set null,
  by_name text,
  at      timestamptz not null default now()
);
create index if not exists payroll_note_log_note_idx on public.payroll_note_log (note_id, at);

alter table public.payroll_note_log enable row level security;
drop policy if exists payroll_note_log_read on public.payroll_note_log;
create policy payroll_note_log_read on public.payroll_note_log for select using (public.is_active_staff());

revoke all on public.payroll_note_log from public, anon;
grant select on public.payroll_note_log to authenticated;
grant all on public.payroll_note_log to service_role;

-- Back-fill: every existing note was added, and the retired ones retired.
insert into public.payroll_note_log (note_id, action, by_id, by_name, at)
select n.id, 'added', n.by_id, n.by_name, n.at
  from public.payroll_period_notes n
 where not exists (select 1 from public.payroll_note_log l where l.note_id = n.id and l.action = 'added');
insert into public.payroll_note_log (note_id, action, by_id, by_name, at)
select n.id, 'retired', n.retired_by, s.name, n.retired_at
  from public.payroll_period_notes n
  left join public.staff_profiles s on s.id = n.retired_by
 where n.retired_at is not null
   and not exists (select 1 from public.payroll_note_log l where l.note_id = n.id and l.action = 'retired');

comment on table public.payroll_note_log is 'Payroll tab (sql/340): every add / retire / restore of a payroll note, by whom and when. Notes are never deleted. Written only by payroll-tracker.';
