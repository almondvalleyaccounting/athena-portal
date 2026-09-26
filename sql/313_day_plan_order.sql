-- ============================================================
-- 313 — Day plan order
--
-- Bobby, 2026-09-26: the Day Plan page lists what is on a person's day as
-- tiles they drag up and down to prioritise. The order is theirs, per day,
-- and is all this table holds: the items themselves live where they always
-- did (job_milestones, bm_task_schedule, quick_tasks, standing blocks).
-- Written through the job-plan edge function (set_day_order).
-- ============================================================

create table if not exists public.day_plan_order (
  staff_id   uuid not null references public.staff_profiles(id) on delete cascade,
  day        date not null,
  keys       text[] not null default '{}',   -- e.g. {'bm:<uuid>','ms:<uuid>','quick:<uuid>','block:<masterId>_<date>'}
  updated_at timestamptz not null default now(),
  primary key (staff_id, day)
);
comment on table public.day_plan_order is 'Per-person, per-day priority order of the Day Plan tiles (sql/313).';

alter table public.day_plan_order enable row level security;
drop policy if exists day_plan_order_select_staff on public.day_plan_order;
create policy day_plan_order_select_staff on public.day_plan_order
  for select to authenticated using (is_active_staff());
revoke all on public.day_plan_order from public, anon;
revoke insert, update, delete, truncate, references, trigger on public.day_plan_order from authenticated;
grant select on public.day_plan_order to authenticated;
grant select, insert, update, delete on public.day_plan_order to service_role;
