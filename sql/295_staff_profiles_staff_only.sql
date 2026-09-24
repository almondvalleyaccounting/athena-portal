-- 295 — The staff list is for staff.
--
-- "Authenticated users can read staff_profiles" (auth.role() = 'authenticated')
-- let any client-portal login read every staff row: names, emails and every
-- permission flag. CLAUDE.md fact 1 — authenticated is not staff.
--
-- Now: active staff read everyone (task names, pickers, notes all need it);
-- anyone reads their own row (the existing "Staff can view own profile",
-- which is how AppShell loads a profile and how the 92 policies that check
-- staff_profiles for auth.uid() keep working); admins keep their policies.
-- The client portal reads staff_profiles nowhere directly — only through
-- definer RPCs and service-role edge functions, which bypass RLS.
--
-- Approved by Bobby, 2026-09-24.

drop policy if exists "Authenticated users can read staff_profiles" on public.staff_profiles;

create policy "Active staff read staff_profiles" on public.staff_profiles
  for select to authenticated
  using (is_active_staff());

revoke all on public.staff_profiles from anon;
