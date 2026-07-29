-- 170_security_hardening.sql
--
-- Closes the unauthenticated data-exposure hole found in the 2026-07-29 audit
-- (see docs/SECURITY_AUDIT_2026-07-29.md, findings 1-4).
--
-- The anon key is public by design (it ships in the Vite bundle). RLS on the
-- base tables is sound — an anon caller reads 0 rows from entities, people,
-- staff_profiles, live_billing, recruitment_applications, etc.
--
-- Two things sit OUTSIDE RLS and were reachable with nothing but that key:
--
--   1. Twelve views were created SECURITY DEFINER (the pre-15 default), so
--      they read their base tables as the view OWNER and RLS never applies.
--      `anon` held SELECT on eleven. Confirmed readable unauthenticated:
--      2,034 job-schedule rows, 630 client names + contact emails, 626
--      client-group structures, 1,779 person->entity relationship pairs.
--
--   2. SECURITY DEFINER functions carry EXECUTE to PUBLIC by default. Most of
--      ours self-check (is_active_staff() etc.) but a subset did not, so anon
--      could enumerate the whole client list (search_entities_for_wizard) and
--      fire destructive or email-sending routines (merge_people,
--      dedupe_people_by_code, run_*).
--
-- pg_cron is unaffected: all 18 jobs run as `postgres`, which owns these
-- objects and always has EXECUTE.
--
-- ── Tested before writing ────────────────────────────────────────────────
-- Every view change below was applied inside a rolled-back transaction and
-- row-counted as a real non-admin active staff user (request.jwt.claims set
-- to their uuid, role `authenticated`). Results drove the split in section 1:
--
--   unchanged by security_invoker   bm_task_schedule_with_progress 2034->2034
--                                   v_email_reconciliation           640->640
--                                   v_client_groups                  626->626
--                                   v_client_group_links            1115->1115
--                                   v_client_group_pairs            1779->1779
--                                   v_bm_load_classified            1954->1954
--                                   v_inferred_allocations           915->915
--                                   v_service_cadence                909->909
--                                   v_capacity_load_monthly          264->264
--
--   BROKEN by security_invoker      v_gmail_connections                 3->0
--                                   v_reminder_autoqueue                1->0
--                                   v_bug_review_config                 1->0
--
-- Those three read tables that have RLS enabled with no SELECT policy
-- (bug_review_config, reminder_autoqueue_config) or a portal-admin-only
-- policy (gmail_connections). The RLS bypass is the whole point of those
-- views — they are the curated, token-free read path. They keep SECURITY
-- DEFINER and get an explicit in-view staff guard instead.
--
-- The finished file was then dry-run end-to-end in a rolled-back transaction.
-- Result — signed-in non-admin staff, every figure unchanged:
--   bm_sched 2034  recon 640  groups 626  gmail 3  autoq 1  bugcfg 1
--   wizard 5  capacity 264
-- anon: every view DENIED, search_entities_for_wizard DENIED,
--   dedupe_people_by_code DENIED, run_deadline_digest DENIED, entities 0,
--   is_active_staff() still callable and returning false (so RLS keeps
--   evaluating cleanly instead of erroring), and 0 non-helper SECURITY
--   DEFINER functions left anon-executable.

begin;

-- ─────────────────────────────────────────────────────────────────────────
-- 1a. Views that can safely respect the caller's RLS
-- ─────────────────────────────────────────────────────────────────────────
-- Base tables are all gated on "active staff" (bm_task_schedule, entities,
-- entity_people, people, timesheet_entries, qbo_customer_mappings), so
-- signed-in staff see exactly what they see today — verified row-for-row
-- above — while anon and client-portal users now get nothing.

alter view public.bm_task_schedule_with_progress set (security_invoker = true);
alter view public.v_bm_load_classified            set (security_invoker = true);
alter view public.v_capacity_load_monthly         set (security_invoker = true);
alter view public.v_client_group_links            set (security_invoker = true);
alter view public.v_client_group_pairs            set (security_invoker = true);
alter view public.v_client_groups                 set (security_invoker = true);
alter view public.v_email_reconciliation          set (security_invoker = true);
alter view public.v_inferred_allocations          set (security_invoker = true);
alter view public.v_service_cadence               set (security_invoker = true);

-- ─────────────────────────────────────────────────────────────────────────
-- 1b. Views that must stay SECURITY DEFINER — guard them in the view body
-- ─────────────────────────────────────────────────────────────────────────
-- These three deliberately read past RLS to expose a safe subset. Flipping
-- them to security_invoker returns 0 rows and would break, in order: the
-- Communications mailbox switcher (src/modules/communications/api.js:18,
-- GmailConnectionPanel, ReminderQueueModal, ClientRemindersPage), the
-- reminders auto-queue status tile (ClientRemindersPage.jsx:317), and the
-- bug-review digest config read.
--
-- So keep the bypass, but make it conditional on being staff rather than
-- unconditional.
--
-- v_gmail_connections already does exactly this — its definition is
-- `... FROM gmail_connections WHERE is_active_staff()`, and it holds no anon
-- grant. It is correct as it stands and is deliberately left alone. (It is
-- still listed in the revoke below, which is a no-op for it.)
--
-- The other two have no guard at all. Column lists match their current
-- definitions exactly — CREATE OR REPLACE VIEW cannot change them.

create or replace view public.v_reminder_autoqueue as
  select id, enabled, comm_type, last_run_at
  from public.reminder_autoqueue_config
  where public.is_active_staff() or auth.role() = 'service_role';

create or replace view public.v_bug_review_config as
  select id, enabled, last_run_at
  from public.bug_review_config
  where public.is_active_staff() or auth.role() = 'service_role';

-- ─────────────────────────────────────────────────────────────────────────
-- 1c. Belt and braces: anon has no business reading any of the twelve
-- ─────────────────────────────────────────────────────────────────────────
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
from anon, public;

grant select on
  public.v_reminder_autoqueue,
  public.v_bug_review_config
to authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. Functions: revoke anon EXECUTE on every SECURITY DEFINER function
--    except the RLS predicate helpers
-- ─────────────────────────────────────────────────────────────────────────
-- The keep-list is not a guess: it is exactly the set of functions that
-- appear inside an RLS policy expression anywhere in the schema (verified by
-- regex-matching every polqual/polwithcheck against pg_proc — the query
-- returned precisely these twelve). Policy expressions evaluate as the
-- querying role, so if anon cannot call is_active_staff() an anon SELECT
-- errors instead of cleanly returning zero rows. Nothing outside that list
-- needs anon: the public flows (quote accept, opt-in/out, click tracking,
-- portal sign-in) all run through edge functions on the service-role key,
-- never an anon RPC.
--
-- REVOKE FROM public, anon — BOTH are required. proacl on these functions is
--   =X/postgres | postgres=X/postgres | anon=X/postgres | authenticated=X/...
-- The bare `=X` is the grant to PUBLIC. Revoking only from anon leaves it and
-- anon still inherits EXECUTE; revoking only from PUBLIC leaves the explicit
-- anon grant. A first draft of this file revoked from anon alone and a dry run
-- showed 68 of 80 functions still anon-executable afterwards.
--
-- Revoking from PUBLIC does not disturb `authenticated`, which holds its own
-- explicit grant — so no re-grant is needed and signed-in staff are unaffected.

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
    execute format('revoke execute on function %s from public, anon', fn.sig);
  end loop;
end $$;

-- Trigger functions: never directly callable by a client role. Revoking
-- EXECUTE does not stop the trigger — Postgres checks EXECUTE at CREATE
-- TRIGGER time, not on each fire.
revoke execute on function public.admin_task_from_extract()            from public, anon, authenticated;
revoke execute on function public.log_comm_preference_change()         from public, anon, authenticated;
revoke execute on function public.notify_doc_extract()                 from public, anon, authenticated;
revoke execute on function public.tg_completed_tasks_audit_delete_fn() from public, anon, authenticated;

-- Maintenance routines with no application caller anywhere in the repo
-- (grepped src/, client-portal/src/, supabase/functions/). service_role and
-- postgres keep access for manual runs; no client role needs them. This is
-- how dedupe_people_by_code(false) — bulk person merge/delete, no arguments
-- to guess — stops being reachable at all, rather than being rewritten.
revoke execute on function public.merge_person(uuid, uuid)          from public, anon, authenticated;
revoke execute on function public.dedupe_people_by_code(boolean)    from public, anon, authenticated;
revoke execute on function public.dedupe_ch_clusters(boolean)       from public, anon, authenticated;
revoke execute on function public.raise_person_dedup_tasks()        from public, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- 3. In-function guards for the two that DO have app callers
-- ─────────────────────────────────────────────────────────────────────────

-- Called from src/modules/data-import/views/ImportView.jsx:1618 (staff-only
-- import wizard). Was the worst single leak: SECURITY DEFINER, no guard,
-- anon-executable, and a blank query returns everything — the full 661-entity
-- client directory with company numbers, 50 rows a call.
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

-- Called from src/modules/work-planner/lib/allocationsQueries.js:105, so it
-- must stay callable by authenticated — it gets a guard instead of a revoke.
-- Body is byte-for-byte the current definition with the guard prepended.
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

commit;

-- ─────────────────────────────────────────────────────────────────────────
-- Verification — run all four after applying
-- ─────────────────────────────────────────────────────────────────────────
--
-- (1) No non-helper SECURITY DEFINER function is anon-executable. Expect 0 rows:
--
--   select p.proname
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public' and p.prosecdef
--     and has_function_privilege('anon', p.oid, 'execute')
--     and p.proname not like 'is\_%' and p.proname not like 'can\_%'
--     and p.proname <> 'my_entity_ids';
--
-- (2) anon reads nothing from the twelve views. Expect every count 0:
--
--   set local role anon;
--   select count(*) from bm_task_schedule_with_progress;   -- etc.
--
-- (3) A normal active staff user still sees what they saw before. Expect
--     2034 / 640 / 626 / 3 / 1 / 1:
--
--   perform set_config('request.jwt.claims',
--     json_build_object('sub','<non-admin active staff uuid>','role','authenticated')::text, true);
--   set local role authenticated;
--   select (select count(*) from bm_task_schedule_with_progress),
--          (select count(*) from v_email_reconciliation),
--          (select count(*) from v_client_groups),
--          (select count(*) from v_gmail_connections),
--          (select count(*) from v_reminder_autoqueue),
--          (select count(*) from v_bug_review_config);
--
-- (4) Smoke-test in the app, as a NON portal-admin staff login:
--       * /comms/email          — mailbox switcher lists info@/accounts@/bobby@
--       * Client Reminders      — auto-queue status tile populated
--       * Data Import wizard    — client search returns matches
--       * Work Planner          — person merge still works
