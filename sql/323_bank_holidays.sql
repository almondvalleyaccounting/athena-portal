-- ============================================================
-- 323 — Bank holidays (Scotland), for information only
--
-- Bobby, 2026-09-26: show them on the Planner and Day plan, but do not
-- take them out of anyone's working days or the handover deadline —
-- many of the team work bank holidays. Seeded to the end of 2027;
-- extend by migration.
-- ============================================================

create table if not exists public.bank_holidays (
  day     date primary key,
  name    text not null,
  region  text not null default 'scotland'
);
comment on table public.bank_holidays is 'Bank holidays shown on the Planner as an FYI (sql/323). Not a working-day rule.';

insert into public.bank_holidays (day, name) values
  ('2026-01-01', 'New Year’s Day'),
  ('2026-01-02', '2 January'),
  ('2026-04-03', 'Good Friday'),
  ('2026-05-04', 'Early May bank holiday'),
  ('2026-05-25', 'Spring bank holiday'),
  ('2026-08-03', 'Summer bank holiday'),
  ('2026-11-30', 'St Andrew’s Day'),
  ('2026-12-25', 'Christmas Day'),
  ('2026-12-28', 'Boxing Day (substitute day)'),
  ('2027-01-01', 'New Year’s Day'),
  ('2027-01-04', '2 January (substitute day)'),
  ('2027-03-26', 'Good Friday'),
  ('2027-05-03', 'Early May bank holiday'),
  ('2027-05-31', 'Spring bank holiday'),
  ('2027-08-02', 'Summer bank holiday'),
  ('2027-11-30', 'St Andrew’s Day'),
  ('2027-12-27', 'Christmas Day (substitute day)'),
  ('2027-12-28', 'Boxing Day (substitute day)')
on conflict (day) do nothing;

alter table public.bank_holidays enable row level security;
drop policy if exists bank_holidays_select_staff on public.bank_holidays;
create policy bank_holidays_select_staff on public.bank_holidays
  for select to authenticated using (is_active_staff());
revoke all on public.bank_holidays from public, anon;
revoke insert, update, delete, truncate, references, trigger on public.bank_holidays from authenticated;
grant select on public.bank_holidays to authenticated;
grant select, insert, update, delete on public.bank_holidays to service_role;
