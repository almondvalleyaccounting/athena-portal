-- 354_close_open_authenticated_reads.sql
--
-- Two tables were readable by ANY signed-in user, client-portal logins included:
--
--   comm_preference_events  `using (true)` for authenticated (sql/149)
--                           → 69 clients' email/SMS opt-in history
--   service_reviewers       `auth.role() = 'authenticated'`
--                           → 104 clients' reviewer assignments
--
-- Found 2026-10-08 by impersonating a new client login (Mac Recruit's dashboard
-- grant) and counting every table `authenticated` can SELECT. Neither leaks a
-- client NAME (entities is gated), but both are other clients' records, and
-- "authenticated is not staff" is the first fact in CLAUDE.md.
--
-- The posture audit returned zero rows with both open, because it checks RLS
-- being OFF, not a permissive policy that says yes to everyone.
--
-- Readers: the Allocations view (staff), job-plan (service_role, bypasses RLS),
-- and the comm-preference trigger writes as definer. Staff keep their reads.

drop policy if exists comm_preference_events_read on public.comm_preference_events;
create policy comm_preference_events_read on public.comm_preference_events
  for select to authenticated using (public.is_active_staff());

drop policy if exists service_reviewers_read on public.service_reviewers;
create policy service_reviewers_read on public.service_reviewers
  for select to authenticated using (public.is_active_staff());

-- anon has no business holding grants on either; RLS stopped it, the grant
-- should not exist at all.
revoke all on public.comm_preference_events from anon;
revoke all on public.service_reviewers from anon;
