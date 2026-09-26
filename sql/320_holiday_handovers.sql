-- ============================================================
-- 320 — Holiday handovers, task by task
--
-- Design agreed with Bobby on 2026-09-26. A holiday picks up every task of
-- the person's that falls inside the dates (computed, not snapshotted);
-- each gets one decision: covered by a colleague, done before I go, moved
-- to after I'm back, or can wait. A task with a deadline inside the dates
-- cannot wait, and a moved date must still be on or before the deadline.
-- Cover is temporary — it shows on the colleague's Planner and Day plan
-- for the holiday dates only — and the owner stays the owner. Handover
-- emails go per colleague when the owner presses Send handovers, and are
-- due by close of business two full working days (the owner's pattern)
-- before they go. Reminders and escalation run from the nightly pass and
-- never auto-send. The person-level cover_staff_id (sql/317) is retired.
-- ============================================================

alter table public.staff_holidays add column if not exists handover_due date;
comment on column public.staff_holidays.handover_due is 'Close of business two full working days before the last working day before the holiday, on the owner''s pattern (sql/320).';

create table if not exists public.staff_holiday_handovers (
  id              uuid primary key default gen_random_uuid(),
  holiday_id      uuid not null references public.staff_holidays(id) on delete cascade,
  task_type       text not null check (task_type in ('ms','bm','quick','block')),
  task_id         uuid not null,
  occurrence_date date,                       -- blocks: which day
  decision        text not null check (decision in ('covered','done_before','moved_after','can_wait')),
  cover_staff_id  uuid references public.staff_profiles(id) on delete set null,
  original_date   date,
  new_date        date,
  sent_at         timestamptz,                -- the colleague's handover email, when it went
  updated_at      timestamptz not null default now(),
  unique (holiday_id, task_type, task_id, occurrence_date)
);
create index if not exists staff_holiday_handovers_holiday_idx on public.staff_holiday_handovers (holiday_id);
create index if not exists staff_holiday_handovers_cover_idx on public.staff_holiday_handovers (cover_staff_id) where decision = 'covered';
comment on table public.staff_holiday_handovers is 'One decision per task inside a holiday (sql/320). Written through job-plan.';

alter table public.staff_holiday_handovers enable row level security;
drop policy if exists staff_holiday_handovers_select_staff on public.staff_holiday_handovers;
create policy staff_holiday_handovers_select_staff on public.staff_holiday_handovers
  for select to authenticated using (is_active_staff());
revoke all on public.staff_holiday_handovers from public, anon;
revoke insert, update, delete, truncate, references, trigger on public.staff_holiday_handovers from authenticated;
grant select on public.staff_holiday_handovers to authenticated;
grant select, insert, update, delete on public.staff_holiday_handovers to service_role;
