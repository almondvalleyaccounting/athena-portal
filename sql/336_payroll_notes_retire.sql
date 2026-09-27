-- ============================================================
-- 336 — Payroll period notes can be retired
--
-- Bobby, 2026-09-27: notes are for live updates. Too many and the team go
-- numb to them, so a note can be retired (kept, hidden from the sheet).
-- Written only through payroll-tracker (retire_note / unretire_note).
-- ============================================================

alter table public.payroll_period_notes
  add column if not exists retired_at timestamptz,
  add column if not exists retired_by uuid references public.staff_profiles(id) on delete set null;

create index if not exists payroll_period_notes_live_idx
  on public.payroll_period_notes (period_id, client_id) where retired_at is null;
