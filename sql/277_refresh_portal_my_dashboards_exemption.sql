-- 277: re-review and re-record the portal_my_dashboards() audit exemption.
--
-- Not part of the digest-timing change; the posture audit surfaced it while
-- gating that commit, and a stale exemption blocks every commit until it is
-- resolved. portal_my_dashboards() was rewritten for Client Dashboard v3 — it
-- used to scope on entity_memberships and now scopes on the caller's own JWT
-- email against client_dashboard_access — so the recorded hash and the recorded
-- reason both described a function that no longer exists.
--
-- Re-verified by impersonation before re-exempting (2026-09-04):
--   holder's email in the JWT      -> 1 row  (their own entity only)
--   stranger@example.com           -> 0 rows
--   no email claim at all          -> 0 rows
--   role anon                      -> 42501 permission denied
-- So it is intentionally callable by `authenticated` (portal clients are the
-- callers) and self-scoped inside. The hash is recomputed from the live
-- definition, so the next edit re-flags it rather than inheriting this.

insert into public.security_audit_exemptions (signature, definition_md5, reason)
select p.oid::regprocedure::text,
       md5(pg_get_functiondef(p.oid)),
       'Portal, self-scoped: returns only rows of client_dashboard_access whose email matches the caller''s own JWT email (unrevoked), and requires auth.uid(); anon holds no EXECUTE.'
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'portal_my_dashboards'
on conflict (signature) do update
  set definition_md5 = excluded.definition_md5,
      reason         = excluded.reason,
      added_at       = now();
