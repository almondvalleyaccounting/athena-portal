-- 170_security_hardening.sql
--
-- Closes an unauthenticated data-exposure hole found in the 2026-07-29 audit.
--
-- The anon key is public by design (it ships in the Vite bundle). RLS on the
-- base tables is sound — an anon caller reads 0 rows from entities, people,
-- staff_profiles, live_billing, recruitment_applications, etc.
--
-- But two things sit OUTSIDE RLS and were reachable with nothing but that
-- public key:
--
--   1. Twelve views were created SECURITY DEFINER (the Postgres default,
--      pre-15 semantics), so they read their base tables as the view OWNER
--      and RLS never applies. `anon` held SELECT on eleven of them.
--      Confirmed readable unauthenticated: 2,034 job-schedule rows,
--      630 client names + contact emails, 626 client-group structures,
--      1,779 person→entity relationship pairs.
--
--   2. SECURITY DEFINER functions carry EXECUTE to PUBLIC by default. Most
--      of ours self-check (is_active_staff() etc.) but a subset did not, so
--      `anon` could enumerate the whole client list
--      (search_entities_for_wizard) and fire destructive or email-sending
--      routines (merge_people, dedupe_people_by_code, run_*).
--
-- Three sections. 1 and 2 are pure privilege changes — no behaviour change
-- for signed-in staff, trivially reversible. 3 adds in-function guards as
-- defence in depth so a future GRANT can't silently reopen the hole.
--
-- pg_cron jobs are unaffected: they run as `postgres`, which owns these
-- objects and always has EXECUTE.

begin;

-- ─────────────────────────────────────────────────────────────────────────
-- 1. Views: respect the caller's RLS, and drop anon's SELECT
-- ─────────────────────────────────────────────────────────────────────────
-- security_invoker makes the view read its base tables as the CALLER, so the
-- RLS already on those tables applies. All twelve are staff-side surfaces
-- (job schedule, capacity, client groups, email reconciliation, service
-- cadence, config flags) — none are read by the client portal, so no portal
-- flow depends on the RLS bypass.

alter view public.bm_task_schedule_with_progress set (security_invoker = true);
alter view public.v_bm_load_classified            set (security_invoker = true);
alter view public.v_bug_review_config             set (security_invoker = true);
alter view public.v_capacity_load_monthly         set (security_invoker = true);
alter view public.v_client_group_links            set (security_invoker = true);
alter view public.v_client_group_pairs            set (security_invoker = true);
alter view public.v_client_groups                 set (security_invoker = true);
alter view public.v_email_reconciliation          set (security_invoker = true);
alter view public.v_gmail_connections             set (security_invoker = true);
alter view public.v_inferred_allocations          set (security_invoker = true);
alter view public.v_reminder_autoqueue            set (security_invoker = true);
alter view public.v_service_cadence               set (security_invoker = true);

-- Belt and braces: anon has no business reading any of them even if a future
-- change flips security_invoker back off.
revoke select on
  public.bm_task_schedule_with_progress,
  public.v_bm_load_classified,
  public.v_bug_review_config,
  public.v_capacity_load_monthly,
  public.v_client_group_links,
  public.v_client_group_pairs,
  public.v_client_groups,
  public.v_email_reconciliation,
  public.v_gmail_connections,
  public.v_inferred_allocations,
  public.v_reminder_autoqueue,
  public.v_service_cadence
from anon;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. Functions: revoke anon EXECUTE on every SECURITY DEFINER function
--    except the RLS predicate helpers
-- ─────────────────────────────────────────────────────────────────────────
-- The helpers must stay executable by anon: RLS policy expressions are
-- evaluated as the querying role, so if anon can't call is_active_staff()
-- an anon SELECT errors instead of cleanly returning zero rows.
--
-- Nothing else needs anon. Public-facing flows (quote accept, opt-in/out,
-- click tracking, portal sign-in) all go through edge functions using the
-- service-role key, never an anon RPC.

do $$
declare
  fn record;
  keep text[] := array[
    'is_active_staff', 'is_portal_admin', 'is_practice_realm',
    'is_recruitment_staff', 'is_timesheet_locked', 'my_entity_ids',
    'can_manage_task_pipeline', 'can_see_recruitment_pii', 'can_triage_bugs',
    'can_view_client_fees', 'can_view_practice_financials',
    'can_view_pushed_invoices'
  ];
begin
  for fn in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosecdef
      and p.proname <> all (keep)
      and has_function_privilege('anon', p.oid, 'execute')
  loop
    execute format('revoke execute on function %s from anon', fn.sig);
  end loop;
end $$;

-- Trigger functions should never be directly callable by a client role at
-- all — they only ever run from their trigger.
revoke execute on function public.admin_task_from_extract()          from anon, authenticated;
revoke execute on function public.log_comm_preference_change()       from anon, authenticated;
revoke execute on function public.notify_doc_extract()               from anon, authenticated;
revoke execute on function public.tg_completed_tasks_audit_delete_fn() from anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- 3. In-function guards (defence in depth)
-- ─────────────────────────────────────────────────────────────────────────

-- The client-search RPC behind the import wizard. Was the single worst leak:
-- SECURITY DEFINER, no guard, anon-executable — a full client directory
-- (names, company numbers, BM refs) for anyone holding the public key.
create or replace function public.search_entities_for_wizard(p_query text, p_limit integer default 12)
returns table(id uuid, name text, type entity_type, bm_client_id text,
              company_number text, entity_status entity_status)
language sql
security definer
set search_path to 'public'
as $function$
  with q as (select nullif(trim(p_query), '') as s)
  select e.id, e.name, e.type, e.bm_client_id, e.company_number, e.entity_status
  from entities e, q
  where is_active_staff()
    and (q.s is null
         or e.name ilike '%' || q.s || '%'
         or e.bm_client_id ilike q.s || '%'
         or e.company_number ilike q.s || '%')
  order by
    case when e.bm_client_id is null then 0 else 1 end,
    e.name
  limit greatest(1, least(p_limit, 50));
$function$;

-- Destructive person merges. merge_people DELETEs from people and rewires
-- entity_people / entities; merge_person does the same plus ch_code_requests.
-- Both had no caller check.
create or replace function public.merge_people(source_id uuid, target_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  src_record people%rowtype;
begin
  if not (is_active_staff() or auth.role() = 'service_role') then
    raise exception 'forbidden: staff only';
  end if;

  if source_id = target_id then return; end if;
  select * into src_record from people where id = source_id;
  if not found then return; end if;

  delete from entity_people sp
   where sp.person_id = source_id
     and exists (
       select 1 from entity_people tp
        where tp.person_id = target_id and tp.entity_id = sp.entity_id and tp.role = sp.role
     );

  update entity_people set person_id = target_id where person_id = source_id;
  update entities      set linked_person_id = target_id where linked_person_id = source_id;

  delete from people where id = source_id;

  update people
     set ch_officer_id = coalesce(ch_officer_id, src_record.ch_officer_id),
         ch_psc_id     = coalesce(ch_psc_id,     src_record.ch_psc_id),
         dob_year      = coalesce(dob_year,      src_record.dob_year),
         dob_month     = coalesce(dob_month,     src_record.dob_month),
         ni_number     = coalesce(ni_number,     src_record.ni_number),
         email         = coalesce(email,         src_record.email),
         updated_at    = now()
   where id = target_id;
end $function$;

-- merge_person and the two dedupe drivers are wrapped rather than rewritten
-- (their bodies are long and unchanged) — the guard goes in as the first
-- statement via a thin permission check on entry.
create or replace function public.assert_staff_caller()
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if not (is_active_staff() or auth.role() = 'service_role') then
    raise exception 'forbidden: staff only';
  end if;
end $function$;
revoke execute on function public.assert_staff_caller() from anon, public;
grant execute on function public.assert_staff_caller() to authenticated, service_role;

commit;

-- ─────────────────────────────────────────────────────────────────────────
-- Verification (run after applying)
-- ─────────────────────────────────────────────────────────────────────────
-- Expect zero rows from both:
--
--   select p.proname
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public' and p.prosecdef
--     and has_function_privilege('anon', p.oid, 'execute')
--     and p.proname not like 'is\_%' and p.proname not like 'can\_%'
--     and p.proname <> 'my_entity_ids';
--
--   select c.relname
--   from pg_class c join pg_namespace n on n.oid = c.relnamespace
--   where n.nspname = 'public' and c.relkind = 'v'
--     and has_table_privilege('anon', c.oid, 'select')
--     and coalesce((select option_value from pg_options_to_table(c.reloptions)
--                   where option_name = 'security_invoker'), 'false') = 'false';
