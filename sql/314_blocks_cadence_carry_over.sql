-- ============================================================
-- 314 — Blocks: richer cadence and carry-over
--
-- Bobby, 2026-09-26: "Standing blocks" are just Blocks. Cadences are every
-- weekday, certain days each week, the same every other week, or monthly —
-- and a monthly block (payroll) starts on a day of the month, takes x
-- minutes a day, and runs for a set number of working days or until a day
-- of the month. When an occurrence is not completed it either carries into
-- the next day or it does not; blocks like mail and onboarding do not by
-- default, but the person still explains why it did not happen.
-- ============================================================

alter table public.scheduled_tasks drop constraint if exists scheduled_tasks_recurrence_check;
alter table public.scheduled_tasks add constraint scheduled_tasks_recurrence_check
  check (recurrence is null or recurrence in ('daily','weekly','fortnightly','monthly','quarterly','annually'));

alter table public.scheduled_tasks
  add column if not exists span_days    integer,          -- monthly: working days per occurrence (default 1)
  add column if not exists span_end_day integer,          -- monthly: or run until this day of the month
  add column if not exists until        date,             -- series end, optional
  add column if not exists carry_over   boolean not null default false;
alter table public.scheduled_tasks drop constraint if exists scheduled_tasks_span_check;
alter table public.scheduled_tasks add constraint scheduled_tasks_span_check
  check ((span_days is null or (span_days between 1 and 31)) and (span_end_day is null or (span_end_day between 1 and 31)));
comment on column public.scheduled_tasks.carry_over is 'An uncompleted occurrence stays open (true) or is simply explained (false).';
