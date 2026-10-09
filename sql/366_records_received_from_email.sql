-- ============================================================
-- 366 — "Records received" from an email
--
-- Bobby (2026-10-09): a client's email often IS the records arriving
-- (Dawn Crawford's SA). The existing signal (sql/319) only fires on a reply
-- to a request Athena sent, so an unprompted email changed nothing. Now the
-- open email offers "Mark records received" for the client's open jobs that
-- are still waiting on records. Confirming (job-plan records_received):
--   1. the job's workflow (made from the default if none) has records_in
--      done, chases stopped;
--   2. the preparer is told — bell + email + a note on the job's prepare
--      stage with a link back to the email;
--   3. BrightManager needs its status set to "Records Received" (Athena only
--      reads BM): an Admin Task List item, linked here, which the nightly
--      tick confirms once the import shows the status (or the job gone).
--
-- This table is that link: one open request per BM job + status.
-- ============================================================

create table if not exists public.bm_status_requests (
  id                   uuid primary key default gen_random_uuid(),
  bm_task_schedule_id  uuid not null,
  entity_id            uuid references public.entities(id) on delete cascade,
  wanted_status        text not null,              -- a BM status, e.g. 'Records Received'
  admin_task_id        uuid references public.admin_tasks(id) on delete set null,
  plan_id              uuid references public.job_plans(id) on delete set null,
  requested_by         uuid references public.staff_profiles(id),
  source_ref           text,                       -- e.g. the Gmail link of the email
  created_at           timestamptz not null default now(),
  confirmed_at         timestamptz
);
create unique index if not exists bm_status_requests_open_uq
  on public.bm_status_requests (bm_task_schedule_id, wanted_status) where confirmed_at is null;

comment on table public.bm_status_requests is
  'A BrightManager status Athena needs a person to set (Athena only reads BM), with the Admin Task List item that asks for it. Written by job-plan; confirmed by job-plan-tick when the import shows it.';

alter table public.bm_status_requests enable row level security;
revoke all on public.bm_status_requests from public, anon, authenticated;
grant select on public.bm_status_requests to authenticated;
grant select, insert, update on public.bm_status_requests to service_role;
drop policy if exists "Staff read BM status requests" on public.bm_status_requests;
create policy "Staff read BM status requests" on public.bm_status_requests
  for select to authenticated using (is_active_staff());
