-- 239: fix the posture audit's own blind spots, and close what they were hiding
--
-- sql/234 shipped six checks. Reviewing it found three faults in the checker itself:
--
--   1. `raise exception` and a bare `auth.uid()` counted as "gated". Almost every
--      plpgsql function has an argument-validation raise, and auth.uid() is as often
--      attribution as authorisation — hmrc_confirm_identity, the CRITICAL this whole
--      exercise started from, used it purely to stamp `confirmed_by`. So the audit
--      could not have re-found its own founding finding.
--   2. Check E only looked at functions that MUTATE. A SECURITY DEFINER *reader*
--      callable by `authenticated` is the exact shape of a portal client reading
--      practice data, and nothing looked for it.
--   3. Everything was scoped to schema `public` and `relkind = 'r'`, so Storage,
--      the realtime publication, and materialized views (which cannot have RLS at
--      all) were invisible.
--
-- Tightening (1) and adding (2) surfaced 24 real findings: the entire `run_*` cron
-- entry-point family was callable by any logged-in user — including the three
-- client-portal accounts. Those functions read the cron secret or the Vault
-- service-role key and fire the automation: run_onboarding_chase and
-- run_ch_code_chase email CLIENTS, run_deadline_digest emails the team,
-- run_comms_ingest and run_reminders_autoqueue move mail. A portal client could have
-- triggered any of it. Nothing in the frontend calls them; pg_cron runs them as
-- postgres, which owns them, so revoking the API roles costs nothing.
--
-- Precision comes from an exemption ledger rather than a looser regex. A gate is now
-- either a named predicate or the inline `staff_profiles`/`auth.uid()` lookup several
-- functions use (revoke_portal_access does this and is correctly gated). Anything
-- else is flagged until it is explicitly exempted with a reason — and the exemption
-- is bound to a hash of the function definition, so editing an exempted function
-- re-flags it instead of silently inheriting the old judgement.

-- ---------------------------------------------------------------------------
-- 1. The actual finding: cron entry points are not API surface.
-- ---------------------------------------------------------------------------
revoke execute on function public.run_athena_reminder(p_moment text) from public, anon, authenticated;
revoke execute on function public.run_bk_drift_batch(p_offset integer, p_limit integer, p_run_id bigint, p_trigger text) from public, anon, authenticated;
revoke execute on function public.run_bk_drift_chunk(p_start_new boolean) from public, anon, authenticated;
revoke execute on function public.run_bk_drift_probe(p_realm_id text, p_skip_baseline boolean) from public, anon, authenticated;
revoke execute on function public.run_ch_code_calls() from public, anon, authenticated;
revoke execute on function public.run_ch_code_chase() from public, anon, authenticated;
revoke execute on function public.run_ch_code_queue_fill() from public, anon, authenticated;
revoke execute on function public.run_ch_code_weekly() from public, anon, authenticated;
revoke execute on function public.run_ch_refresh_chunk() from public, anon, authenticated;
revoke execute on function public.run_ch_refresh_report() from public, anon, authenticated;
revoke execute on function public.run_chase_reply_scan() from public, anon, authenticated;
revoke execute on function public.run_comms_backfill_temp() from public, anon, authenticated;
revoke execute on function public.run_comms_ingest() from public, anon, authenticated;
revoke execute on function public.run_deadline_digest() from public, anon, authenticated;
revoke execute on function public.run_job_review_chase() from public, anon, authenticated;
revoke execute on function public.run_job_review_monthly() from public, anon, authenticated;
revoke execute on function public.run_notification_sweep() from public, anon, authenticated;
revoke execute on function public.run_onboarding_chase() from public, anon, authenticated;
revoke execute on function public.run_onboarding_checkin() from public, anon, authenticated;
revoke execute on function public.run_onboarding_weekly() from public, anon, authenticated;
revoke execute on function public.run_reminders_autoqueue() from public, anon, authenticated;

-- The scheduled-jobs registry internals expose the firm's automation config. Only
-- /admin/schedules should see it, and it does not call these directly.
revoke execute on function public.scheduled_job_brief(p_job_key text) from public, anon, authenticated;
revoke execute on function public.scheduled_job_gate(p_key text) from public, anon, authenticated;
revoke execute on function public.scheduled_job_setting_values(p_job_key text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. The exemption ledger.
-- ---------------------------------------------------------------------------
create table if not exists public.security_audit_exemptions (
  signature      text primary key,          -- oid::regprocedure::text, e.g. portal_step_reply(uuid,text)
  definition_md5 text not null,             -- void the exemption if the body changes
  reason         text not null,
  added_at       timestamptz not null default now()
);

comment on table public.security_audit_exemptions is
  'Reviewed-and-accepted findings for security_posture_audit(). Bound to a hash of the function definition: edit the function and the exemption stops applying. See sql/239.';

alter table public.security_audit_exemptions enable row level security;
revoke all on public.security_audit_exemptions from anon, authenticated;
grant select, insert, update, delete on public.security_audit_exemptions to service_role;

-- Seeded from a function-by-function review, 2026-08-19.
insert into public.security_audit_exemptions (signature, definition_md5, reason) values
  ('portal_claim_invites()',              'c7d879918a3ab572cc6bc73834e217ad', 'Portal, self-scoped: keys off auth.uid() and the caller''s own JWT email; only claims invites addressed to them.'),
  ('portal_my_dashboards()',              '086fca1570286c95d8f714577aff9ffc', 'Portal, self-scoped: returns only the caller''s own entity_memberships.'),
  ('portal_my_onboarding()',              '22c89254113d8f90ba8246a6a2161e95', 'Portal, self-scoped: returns only the caller''s own onboarding.'),
  ('portal_register_document(uuid,text,text,text,bigint)', '0c3baf3573ab81b807a62e412808e749', 'Portal, self-scoped: writes only against the caller''s own entity.'),
  ('portal_request_service(uuid,text,text,text)',          '6ea33c06a5884515e5bcb29d5935abd7', 'Portal, self-scoped: raises a request against the caller''s own entity.'),
  ('portal_step_action(uuid,text,text)',  'e21c77e6c77e7a0c30a08a8404ca56fc', 'Portal, self-scoped: acts on the caller''s own onboarding step.'),
  ('portal_step_reply(uuid,text)',        '1db76f614cd3521318e7f3ea6151b5b2', 'Portal, self-scoped: replies on the caller''s own onboarding step.'),
  ('portal_service_catalogue()',          '84a00dd13aa66d70f976aa94cec452e3', 'Deliberately open to portal users: the published service catalogue (list prices), not client fees.'),
  ('mark_notifications_read(uuid[])',     '3a73d94a398ff6061a326f54af104eaf', 'Self-scoped: updates only rows where recipient_id = auth.uid().'),
  ('is_practice_realm(text)',             '38aee9dc4625d0cd2aa664315e998187', 'Boolean predicate used inside RLS policies; discloses nothing beyond whether a realm is the practice''s.'),
  ('is_timesheet_locked(date)',           '95f4861690cf90148f71c54829edc07d', 'Boolean predicate on a date; discloses no row data.')
on conflict (signature) do update
  set definition_md5 = excluded.definition_md5,
      reason         = excluded.reason,
      added_at       = now();

-- ---------------------------------------------------------------------------
-- 3. The audit, v2.
-- ---------------------------------------------------------------------------
create or replace function public.security_posture_audit()
returns table (severity text, check_name text, object_name text, detail text)
language sql
stable
security definer
set search_path to 'public'
as $$
  with gate as (
    -- A named permission predicate. Deliberately NOT `raise exception` (argument
    -- validation) and NOT a bare `auth.uid()` (usually attribution).
    select '(is_active_staff\(\)|is_staff_or_service\(\)|is_portal_admin\(\)|hmrc_can_read\(\)|is_recruitment_staff\(\)|can_[a-z_]+\(\)|my_entity_ids\(\))'::text as re
  ),
  fn as (
    select p.oid, p.proname, p.prosecdef, p.provolatile, p.prorettype,
           p.oid::regprocedure::text as sig,
           pg_get_functiondef(p.oid) as def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef
  ),
  fn_gated as (
    select f.*,
           (f.def ~* g.re)
             -- Several functions gate inline instead of via a named predicate, e.g.
             -- revoke_portal_access: `IF NOT (SELECT can_manage_portal FROM
             -- staff_profiles WHERE id = auth.uid())`. That is a real gate.
             or (f.def ~* 'staff_profiles' and f.def ~* 'auth\.uid\(\)') as gated
    from fn f cross join gate g
  ),

  -- A. RLS off on a table anyone with the anon key can reach.
  chk_a as (
    select 'CRITICAL', 'rls_disabled', c.relname,
           'public table with RLS disabled — anon can read and write it'
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r','p') and not c.relrowsecurity
  ),

  -- A2. A materialized view CANNOT have RLS, so any API-role grant on one is the
  --     whole table. PostgREST serves them like any other relation.
  chk_a2 as (
    select 'CRITICAL', 'matview_api_readable', c.relname,
           'materialized view readable by an API role — RLS cannot be enabled on a matview, so this exposes every row'
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('m','f')
      and (has_table_privilege('anon', c.oid, 'SELECT')
        or has_table_privilege('authenticated', c.oid, 'SELECT'))
  ),

  -- B. Definer view readable by anon = unauthenticated read.
  chk_b as (
    select 'CRITICAL', 'definer_view_anon_readable', c.relname,
           'SECURITY DEFINER view readable by anon — RLS on its base tables does not apply'
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'v'
      and (c.reloptions::text ilike '%security_invoker=t%') is not true
      and has_table_privilege('anon', c.oid, 'SELECT')
  ),

  -- C. Definer view with no predicate reading a base relation directly. Reading
  --    another *gated* view is fine — the inner predicate still runs.
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
          and base.relkind in ('r','p','m','f') and bn.nspname = 'public'
      )
  ),

  -- D. anon should not execute any definer function.
  chk_d as (
    select 'CRITICAL', 'definer_fn_anon_executable', f.proname,
           'SECURITY DEFINER function executable by anon via /rest/v1/rpc/' || f.proname
    from fn f
    where has_function_privilege('anon', f.oid, 'EXECUTE')
  ),

  -- E. `authenticated` is not `staff`. Now covers READS as well as writes: a definer
  --    reader callable by authenticated is how a portal client reads practice data.
  chk_e as (
    select 'HIGH', 'definer_fn_ungated', f.proname,
           'SECURITY DEFINER function callable by authenticated with no permission check — a portal client can call it (' ||
           case when f.def ~* '(insert |update |delete |truncate |merge )' then 'mutates' else 'reads' end || ')'
    from fn_gated f
    where f.prorettype <> 'trigger'::regtype
      and has_function_privilege('authenticated', f.oid, 'EXECUTE')
      and not f.gated
      and not exists (
        select 1 from public.security_audit_exemptions x
        where x.signature = f.sig and x.definition_md5 = md5(f.def)
      )
  ),

  -- F. EXECUTE held by PUBLIC, which makes a named-role revoke a no-op.
  chk_f as (
    select 'HIGH', 'definer_fn_public_grant', p.proname,
           'EXECUTE held by PUBLIC — a REVOKE FROM anon on this function is a no-op'
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef and p.proacl is not null
      and exists (select 1 from aclexplode(p.proacl) a
                  where a.grantee = 0 and a.privilege_type = 'EXECUTE')
  ),

  -- G. A public Storage bucket serves its objects with no auth at all. The
  --    client-documents bucket holds client KYC/AML material.
  chk_g as (
    select 'CRITICAL', 'storage_bucket_public', b.id,
           'Storage bucket is public — every object in it is readable with no credential'
    from storage.buckets b
    where b.public
  ),

  -- H. Storage object-level RLS off would expose every bucket at once.
  chk_h as (
    select 'CRITICAL', 'storage_objects_rls_off', 'storage.objects',
           'RLS is disabled on storage.objects — bucket policies do not apply'
    where exists (
      select 1 from pg_class c
      where c.oid = 'storage.objects'::regclass and not c.relrowsecurity
    )
  ),

  -- I. Realtime evaluates RLS per subscriber, so a published table without RLS
  --    streams to anyone. REPLICA IDENTITY FULL additionally broadcasts the OLD row
  --    on update/delete, which is checked against the NEW row's policy.
  chk_i as (
    select 'HIGH', 'realtime_published_unsafe', c.relname,
           case when not c.relrowsecurity
                then 'in the supabase_realtime publication with RLS disabled — streams every change to any subscriber'
                else 'in the supabase_realtime publication with REPLICA IDENTITY FULL — the pre-update row is broadcast and is not covered by the new row''s policy' end
    from pg_publication p
    join pg_publication_rel pr on pr.prpubid = p.oid
    join pg_class c on c.oid = pr.prrelid
    where p.pubname = 'supabase_realtime'
      and (not c.relrowsecurity or c.relreplident = 'f')
  ),

  -- J. An exemption whose function has since been edited. The judgement was made
  --    about the old body; it does not carry over.
  chk_j as (
    select 'HIGH', 'exemption_stale', x.signature,
           'audit exemption no longer matches the function definition — re-review it, then update security_audit_exemptions'
    from public.security_audit_exemptions x
    where not exists (
      select 1 from fn f where f.sig = x.signature and md5(f.def) = x.definition_md5
    )
  )

  select r.severity, r.check_name, r.object_name, r.detail
  from (
              select * from chk_a
    union all select * from chk_a2
    union all select * from chk_b
    union all select * from chk_c
    union all select * from chk_d
    union all select * from chk_e
    union all select * from chk_f
    union all select * from chk_g
    union all select * from chk_h
    union all select * from chk_i
    union all select * from chk_j
  ) as r(severity, check_name, object_name, detail)
  order by case r.severity when 'CRITICAL' then 1 else 2 end, r.check_name, r.object_name;
$$;

revoke all on function public.security_posture_audit() from public, anon, authenticated;
grant execute on function public.security_posture_audit() to service_role;
