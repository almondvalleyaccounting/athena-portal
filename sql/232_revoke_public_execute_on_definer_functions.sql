-- 232: take the PUBLIC grant off the SECURITY DEFINER helpers
--
-- 231 and 229 revoked EXECUTE "from anon" on several definer functions and it did
-- nothing: the ACL on these functions is `=X/postgres`, i.e. the grant is held by
-- PUBLIC, and revoking a named role does not touch a PUBLIC grant. anon still
-- reached all seventeen of the functions below.
--
-- The guards added in 229/230 are the substantive defence and they hold — verified
-- against prod that a portal-client JWT gets 42501 from a guarded RPC. This is the
-- grant half of the same job: replace the blanket PUBLIC grant with explicit
-- authenticated + service_role grants, so anon cannot reach a function body at all.
--
-- Nothing legitimate calls these as anon. Every policy on every portal-facing table
-- (client_portal_invites, portal_service_requests, users, entity_memberships) gates
-- on auth.uid() or is_active_staff(), so an anon caller was already getting zero
-- rows everywhere these predicates are evaluated.

-- Permission predicates used inside RLS policies: authenticated needs them, anon does not.
grant execute on function public.can_manage_task_pipeline()      to authenticated, service_role;
grant execute on function public.can_see_recruitment_pii()       to authenticated, service_role;
grant execute on function public.can_triage_bugs()               to authenticated, service_role;
grant execute on function public.can_view_client_fees()          to authenticated, service_role;
grant execute on function public.can_view_practice_financials()  to authenticated, service_role;
grant execute on function public.can_view_pushed_invoices()      to authenticated, service_role;
grant execute on function public.is_active_staff()               to authenticated, service_role;
grant execute on function public.is_portal_admin()               to authenticated, service_role;
grant execute on function public.is_practice_realm(text)         to authenticated, service_role;
grant execute on function public.is_recruitment_staff()          to authenticated, service_role;
grant execute on function public.is_staff_or_service()           to authenticated, service_role;
grant execute on function public.is_timesheet_locked(date)       to authenticated, service_role;
grant execute on function public.my_entity_ids()                 to authenticated, service_role;

revoke execute on function public.can_manage_task_pipeline()     from public;
revoke execute on function public.can_see_recruitment_pii()      from public;
revoke execute on function public.can_triage_bugs()              from public;
revoke execute on function public.can_view_client_fees()         from public;
revoke execute on function public.can_view_practice_financials() from public;
revoke execute on function public.can_view_pushed_invoices()     from public;
revoke execute on function public.is_active_staff()              from public;
revoke execute on function public.is_portal_admin()              from public;
revoke execute on function public.is_practice_realm(text)        from public;
revoke execute on function public.is_recruitment_staff()         from public;
revoke execute on function public.is_staff_or_service()          from public;
revoke execute on function public.is_timesheet_locked(date)      from public;
revoke execute on function public.my_entity_ids()                from public;

-- The two hmrc write RPCs. Guarded by hmrc_can_read() in 229; this closes the grant.
grant execute on function public.hmrc_confirm_identity(text, text, uuid, text, text, uuid) to authenticated, service_role;
grant execute on function public.hmrc_reject_identity(text, text, text)                    to authenticated, service_role;
revoke execute on function public.hmrc_confirm_identity(text, text, uuid, text, text, uuid) from public;
revoke execute on function public.hmrc_reject_identity(text, text, text)                    from public;

-- Trigger functions: they fire as the definer, so no API role needs a grant at all.
revoke execute on function public.pd_prep_notify_request()      from public;
revoke execute on function public.pd_prep_notify_contribution() from public;

-- The permission predicates additionally carry an explicit anon=X grant from an
-- older migration, which survives the PUBLIC revoke above. These leak nothing —
-- they resolve auth.uid() against staff_profiles, so anon gets false / no rows —
-- but there is no anon read path anywhere that needs them, so take them off too.
revoke execute on function public.can_manage_task_pipeline()     from anon;
revoke execute on function public.can_see_recruitment_pii()      from anon;
revoke execute on function public.can_triage_bugs()              from anon;
revoke execute on function public.can_view_client_fees()         from anon;
revoke execute on function public.can_view_practice_financials() from anon;
revoke execute on function public.can_view_pushed_invoices()     from anon;
revoke execute on function public.is_active_staff()              from anon;
revoke execute on function public.is_portal_admin()              from anon;
revoke execute on function public.is_practice_realm(text)        from anon;
revoke execute on function public.is_recruitment_staff()         from anon;
revoke execute on function public.is_timesheet_locked(date)      from anon;
revoke execute on function public.my_entity_ids()                from anon;
