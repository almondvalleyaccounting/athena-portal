-- 234: one canonical query for "have we exposed anything?"
--
-- The 2026-08-18 audit (sql/228-233) found five real exposures that four ad-hoc
-- security reviews had missed, because every one of them lived below the policy
-- layer — grants, SECURITY DEFINER flags, PUBLIC ACLs — rather than in the RLS
-- policies people actually read. Ad-hoc queries drift; this does not. Every check
-- below is one that would have caught something real on 2026-08-18.
--
-- Zero rows = nothing exposed. Any row = do not commit until it is explained.
--
-- Run it as postgres (Supabase SQL editor / MCP) or as service_role:
--   select * from public.security_posture_audit();

create or replace function public.security_posture_audit()
returns table (severity text, check_name text, object_name text, detail text)
language sql
stable
security definer
set search_path to 'public'
as $$
  -- The gating predicates a definer object must mention to count as gated at all.
  with gate as (
    select '(is_active_staff\(\)|is_staff_or_service\(\)|is_portal_admin\(\)|hmrc_can_read\(\)|is_recruitment_staff\(\)|can_[a-z_]+\(\)|my_entity_ids\(\)|auth\.uid\(\)|raise exception)'::text as re
  ),

  -- A. A public-schema table with RLS off is readable and writable by anyone
  --    holding the anon key, which ships in the frontend bundle. This is what the
  --    advisor emailed about: two leftover fc_output backups from a forecast rework.
  chk_a as (
    select 'CRITICAL', 'rls_disabled', c.relname,
           'public table with RLS disabled — anon can read and write it'
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
  ),

  -- B. A view is SECURITY DEFINER unless it declares security_invoker, and a definer
  --    view reads its base tables as the owner, so RLS never applies. anon holding
  --    SELECT on one is an unauthenticated read. This is how the v_bk_* views leaked
  --    72 clients' bookkeeping data.
  chk_b as (
    select 'CRITICAL', 'definer_view_anon_readable', c.relname,
           'SECURITY DEFINER view readable by anon — RLS on its base tables does not apply'
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'v'
      and (c.reloptions::text ilike '%security_invoker=t%') is not true
      and has_table_privilege('anon', c.oid, 'SELECT')
  ),

  -- C. Same shape, one step in: a definer view with no gating predicate of its own
  --    that reads a base table directly. Reading another *gated* view is fine — the
  --    inner predicate still runs (v_hmrc_*_by_client rely on this and are safe).
  --    Reading a table directly with no predicate is the v_bk_* bug.
  chk_c as (
    select 'HIGH', 'definer_view_ungated', c.relname,
           'SECURITY DEFINER view with no gating predicate reading a base table directly — any logged-in user, including a portal client, sees every row'
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    cross join gate g
    where n.nspname = 'public' and c.relkind = 'v'
      and (c.reloptions::text ilike '%security_invoker=t%') is not true
      and has_table_privilege('authenticated', c.oid, 'SELECT')
      and pg_get_viewdef(c.oid) !~* g.re
      and exists (
        select 1
        from pg_depend d
        join pg_rewrite r on r.oid = d.objid
        join pg_class base on base.oid = d.refobjid
        join pg_namespace bn on bn.oid = base.relnamespace
        where r.ev_class = c.oid and d.classid = 'pg_rewrite'::regclass
          and base.relkind = 'r' and bn.nspname = 'public'
      )
  ),

  -- D. anon should not be able to execute any SECURITY DEFINER function. Two of them
  --    (hmrc_confirm_identity, hmrc_reject_identity) were unauthenticated writes into
  --    the private hmrc schema.
  chk_d as (
    select 'CRITICAL', 'definer_fn_anon_executable', p.proname,
           'SECURITY DEFINER function executable by anon via /rest/v1/rpc/' || p.proname
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef
      and has_function_privilege('anon', p.oid, 'EXECUTE')
  ),

  -- E. `authenticated` is not `staff` — portal clients hold that role too. A definer
  --    function that mutates data, is callable by authenticated, and checks nothing
  --    is a client-triggerable write. Thirteen of these existed, including
  --    trigger_qbo_monthly_pull, which reads the service-role key out of Vault.
  --    Self-scoped functions are exempt: they key off auth.uid() and only ever touch
  --    the caller's own rows.
  chk_e as (
    select 'HIGH', 'definer_fn_unguarded_write', p.proname,
           'SECURITY DEFINER function mutates data, callable by authenticated, no permission check — a portal client can fire it'
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    cross join gate g
    where n.nspname = 'public' and p.prosecdef
      and p.provolatile = 'v'
      and p.prorettype <> 'trigger'::regtype
      and has_function_privilege('authenticated', p.oid, 'EXECUTE')
      and pg_get_functiondef(p.oid) ~* '(insert |update |delete |truncate )'
      and pg_get_functiondef(p.oid) !~* g.re
      and p.proname not in (
        'clear_my_must_change_password', 'mark_notifications_read', 'portal_claim_invites'
      )
  ),

  -- F. The trap that made the first round of fixes a no-op: if EXECUTE is held by
  --    PUBLIC (ACL shows `=X/postgres`), then REVOKE ... FROM anon does nothing and
  --    anon still reaches the function. Grant to authenticated + service_role
  --    explicitly and revoke from public instead.
  chk_f as (
    select 'HIGH', 'definer_fn_public_grant', p.proname,
           'EXECUTE held by PUBLIC — a REVOKE FROM anon on this function is a no-op'
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef and p.proacl is not null
      and exists (
        select 1 from aclexplode(p.proacl) a
        where a.grantee = 0 and a.privilege_type = 'EXECUTE'
      )
  )

  select f.severity, f.check_name, f.object_name, f.detail
  from (
              select * from chk_a
    union all select * from chk_b
    union all select * from chk_c
    union all select * from chk_d
    union all select * from chk_e
    union all select * from chk_f
  ) as f(severity, check_name, object_name, detail)
  order by case f.severity when 'CRITICAL' then 1 else 2 end, f.check_name, f.object_name;
$$;

revoke all on function public.security_posture_audit() from public, anon, authenticated;
grant execute on function public.security_posture_audit() to service_role;
