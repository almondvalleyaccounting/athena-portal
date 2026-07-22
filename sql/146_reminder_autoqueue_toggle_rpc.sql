-- 146: reliable toggle for the auto-queue flag. A direct client UPDATE on
-- reminder_autoqueue_config is blocked by RLS-on-write and silently
-- no-ops (the flag reverted to OFF on refresh). This SECURITY DEFINER RPC
-- does the manager check server-side and flips the flag. Applied to prod
-- 2026-07-21; kept here for parity.

create or replace function public.set_reminder_autoqueue_enabled(p_enabled boolean)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if not exists (
    select 1 from public.staff_profiles p
    where p.id = auth.uid() and (p.can_manage_portal or p.is_portal_admin)
  ) then
    raise exception 'not authorised';
  end if;
  update public.reminder_autoqueue_config set enabled = coalesce(p_enabled, false) where id = true;
  return coalesce(p_enabled, false);
end;
$$;
grant execute on function public.set_reminder_autoqueue_enabled(boolean) to authenticated;
