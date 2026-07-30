-- 170_rollback.sql — undo 170_security_hardening.sql
--
-- Captured from the live database immediately before 170 was applied, on
-- 2026-07-30. Every statement below restores a state that was verified as
-- present at that moment (pg_get_viewdef / pg_get_functiondef / pg_class.relacl
-- / pg_proc.proacl), not reconstructed from the migration by hand.
--
-- Paste the whole file into the Supabase SQL editor to return the database to
-- exactly its pre-170 state.
--
-- WARNING: running this REOPENS the unauthenticated exposure described in
-- docs/SECURITY_AUDIT_2026-07-29.md — ~10k rows of client data readable with
-- the public anon key, plus anon-callable destructive RPCs. Only run it if
-- 170 has broken something you need working right now, and then fix forward.

begin;

-- ─── 1. Views: back to SECURITY DEFINER (the pre-170 default) ─────────────
alter view public.bm_task_schedule_with_progress set (security_invoker = false);
alter view public.v_bm_load_classified            set (security_invoker = false);
alter view public.v_capacity_load_monthly         set (security_invoker = false);
alter view public.v_client_group_links            set (security_invoker = false);
alter view public.v_client_group_pairs            set (security_invoker = false);
alter view public.v_client_groups                 set (security_invoker = false);
alter view public.v_email_reconciliation          set (security_invoker = false);
alter view public.v_inferred_allocations          set (security_invoker = false);
alter view public.v_service_cadence               set (security_invoker = false);

-- ─── 2. The two view bodies 170 replaced — original definitions, unguarded ─
create or replace view public.v_reminder_autoqueue as
 select id,
    enabled,
    comm_type,
    last_run_at
   from reminder_autoqueue_config;

create or replace view public.v_bug_review_config as
 select id,
    enabled,
    last_run_at
   from bug_review_config;

-- ─── 3. View grants ───────────────────────────────────────────────────────
-- 170 revoked SELECT from anon; the 170b addendum then revoked ALL remaining
-- anon privileges (INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER/MAINTAIN).
-- Pre-170 relacl was the full arwdDxtm set for anon on all twelve EXCEPT
-- v_gmail_connections, which had no anon entry at all. Restored to match.
grant all on
  public.bm_task_schedule_with_progress,
  public.v_bm_load_classified,
  public.v_bug_review_config,
  public.v_capacity_load_monthly,
  public.v_client_group_links,
  public.v_client_group_pairs,
  public.v_client_groups,
  public.v_email_reconciliation,
  public.v_inferred_allocations,
  public.v_reminder_autoqueue,
  public.v_service_cadence
to anon, authenticated;
-- v_gmail_connections: authenticated only, as before. Deliberately no anon.
grant all on public.v_gmail_connections to authenticated;

-- ─── 4. Function EXECUTE grants ───────────────────────────────────────────
-- All 68 functions section 2 of 170 revoked. Pre-170 proacl on every one was
--   =X/postgres | postgres=X/postgres | anon=X | authenticated=X | service_role=X
-- so restoring `public, anon` reproduces it exactly (authenticated and
-- service_role were never revoked). Generated from the live catalogue.
grant execute on function public.admin_task_from_extract() to public, anon;
grant execute on function public.admin_update_user_email(uuid,text) to public, anon;
grant execute on function public.archive_bm_clients(uuid,text[]) to public, anon;
grant execute on function public.clear_company_number_on_entity(uuid) to public, anon;
grant execute on function public.clear_my_must_change_password() to public, anon;
grant execute on function public.confirm_nlac_mirror_tasks(text[]) to public, anon;
grant execute on function public.confirm_wont_happen_tasks() to public, anon;
grant execute on function public.create_prospect_for_bm_ref(text,text,entity_type) to public, anon;
grant execute on function public.dedupe_ch_clusters(boolean) to public, anon;
grant execute on function public.dedupe_people_by_code(boolean) to public, anon;
grant execute on function public.ignore_bm_ref(text,text) to public, anon;
grant execute on function public.import_bm_clients(uuid,jsonb) to public, anon;
grant execute on function public.import_bm_reviewers(uuid,jsonb) to public, anon;
grant execute on function public.import_bm_tasks(uuid,jsonb) to public, anon;
grant execute on function public.list_auth_users() to public, anon;
grant execute on function public.log_comm_preference_change() to public, anon;
grant execute on function public.map_bm_ref_to_entity(text,uuid) to public, anon;
grant execute on function public.mark_bm_tasks_wont_happen(uuid[],text) to public, anon;
grant execute on function public.mark_notifications_read(uuid[]) to public, anon;
grant execute on function public.match_bm_prospects(jsonb) to public, anon;
grant execute on function public.match_bm_tasks(jsonb) to public, anon;
grant execute on function public.merge_people(uuid,uuid) to public, anon;
grant execute on function public.merge_person(uuid,uuid) to public, anon;
grant execute on function public.notify_doc_extract() to public, anon;
grant execute on function public.notify_staff(uuid,text,text,text,text,text) to public, anon;
grant execute on function public.notify_triagers_bug(text,bigint) to public, anon;
grant execute on function public.offboard_entity(uuid,text) to public, anon;
grant execute on function public.onboarding_billing_names_for_entity(uuid) to public, anon;
grant execute on function public.onboarding_quote_for_entity(uuid) to public, anon;
grant execute on function public.open_job_review_cycle(date,uuid) to public, anon;
grant execute on function public.preview_bm_archive_candidates(text[]) to public, anon;
grant execute on function public.raise_person_dedup_tasks() to public, anon;
grant execute on function public.reconcile_allocation_changes() to public, anon;
grant execute on function public.reconcile_ch_codes(jsonb) to public, anon;
grant execute on function public.reconcile_field_overrides() to public, anon;
grant execute on function public.reconcile_qbo_sync_responses() to public, anon;
grant execute on function public.reconcile_ready_now_change_requests() to public, anon;
grant execute on function public.record_field_override(uuid,text,text,text) to public, anon;
grant execute on function public.reinstate_entity(uuid) to public, anon;
grant execute on function public.release_admin_task(uuid) to public, anon;
grant execute on function public.run_athena_reminder(text) to public, anon;
grant execute on function public.run_bug_review_digest() to public, anon;
grant execute on function public.run_ch_code_calls() to public, anon;
grant execute on function public.run_ch_code_chase() to public, anon;
grant execute on function public.run_ch_code_queue_fill() to public, anon;
grant execute on function public.run_ch_code_weekly() to public, anon;
grant execute on function public.run_ch_refresh_chunk() to public, anon;
grant execute on function public.run_ch_refresh_report() to public, anon;
grant execute on function public.run_chase_reply_scan() to public, anon;
grant execute on function public.run_comms_backfill_temp() to public, anon;
grant execute on function public.run_comms_ingest() to public, anon;
grant execute on function public.run_deadline_digest() to public, anon;
grant execute on function public.run_job_review_chase() to public, anon;
grant execute on function public.run_job_review_monthly() to public, anon;
grant execute on function public.run_notification_sweep() to public, anon;
grant execute on function public.run_onboarding_chase() to public, anon;
grant execute on function public.run_onboarding_checkin() to public, anon;
grant execute on function public.run_onboarding_weekly() to public, anon;
grant execute on function public.run_qbo_pull_nightly() to public, anon;
grant execute on function public.run_reminders_autoqueue() to public, anon;
grant execute on function public.search_entities_for_wizard(text,integer) to public, anon;
grant execute on function public.set_reminder_autoqueue_enabled(boolean) to public, anon;
grant execute on function public.suggest_entities_for_qbo(jsonb,numeric,integer) to public, anon;
grant execute on function public.tg_completed_tasks_audit_delete_fn() to public, anon;
grant execute on function public.triage_from_ch_status_event() to public, anon;
grant execute on function public.trigger_qbo_monthly_pull(text) to public, anon;
grant execute on function public.unignore_bm_ref(text) to public, anon;
grant execute on function public.unmark_bm_task_wont_happen(uuid) to public, anon;

-- Also restore what 170 revoked from `authenticated` on the four trigger
-- functions and the four maintenance routines.
grant execute on function public.admin_task_from_extract()            to authenticated;
grant execute on function public.log_comm_preference_change()         to authenticated;
grant execute on function public.notify_doc_extract()                 to authenticated;
grant execute on function public.tg_completed_tasks_audit_delete_fn() to authenticated;
grant execute on function public.merge_person(uuid,uuid)              to authenticated;
grant execute on function public.dedupe_people_by_code(boolean)       to authenticated;
grant execute on function public.dedupe_ch_clusters(boolean)          to authenticated;
grant execute on function public.raise_person_dedup_tasks()           to authenticated;

-- ─── 5. The two function bodies 170 replaced — original definitions ────────
-- Verbatim pg_get_functiondef output captured pre-170. Note the absence of any
-- caller check in both: that is the point of the rollback, and the hole.
create or replace function public.search_entities_for_wizard(p_query text, p_limit integer default 12)
 returns table(id uuid, name text, type entity_type, bm_client_id text, company_number text, entity_status entity_status)
 language sql
 security definer
 set search_path to 'public'
as $function$
  WITH q AS (SELECT NULLIF(trim(p_query), '') AS s)
  SELECT e.id, e.name, e.type, e.bm_client_id, e.company_number, e.entity_status
  FROM entities e, q
  WHERE q.s IS NULL
     OR e.name ILIKE '%' || q.s || '%'
     OR e.bm_client_id ILIKE q.s || '%'
     OR e.company_number ILIKE q.s || '%'
  ORDER BY
    CASE WHEN e.bm_client_id IS NULL THEN 0 ELSE 1 END,
    e.name
  LIMIT GREATEST(1, LEAST(p_limit, 50));
$function$;

create or replace function public.merge_people(source_id uuid, target_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  src_record people%ROWTYPE;
BEGIN
  IF source_id = target_id THEN RETURN; END IF;
  SELECT * INTO src_record FROM people WHERE id = source_id;
  IF NOT FOUND THEN RETURN; END IF;

  DELETE FROM entity_people sp
   WHERE sp.person_id = source_id
     AND EXISTS (
       SELECT 1 FROM entity_people tp
        WHERE tp.person_id = target_id AND tp.entity_id = sp.entity_id AND tp.role = sp.role
     );

  UPDATE entity_people SET person_id = target_id WHERE person_id = source_id;
  UPDATE entities      SET linked_person_id = target_id WHERE linked_person_id = source_id;

  DELETE FROM people WHERE id = source_id;

  UPDATE people
     SET ch_officer_id = COALESCE(ch_officer_id, src_record.ch_officer_id),
         ch_psc_id     = COALESCE(ch_psc_id,     src_record.ch_psc_id),
         dob_year      = COALESCE(dob_year,      src_record.dob_year),
         dob_month     = COALESCE(dob_month,     src_record.dob_month),
         ni_number     = COALESCE(ni_number,     src_record.ni_number),
         email         = COALESCE(email,         src_record.email),
         updated_at    = now()
   WHERE id = target_id;
END $function$;

commit;

-- ─── Confirm the rollback landed ──────────────────────────────────────────
-- Expect 80 and 0 — the pre-170 figures:
--
--   select
--     (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
--       where n.nspname='public' and p.prosecdef
--         and has_function_privilege('anon',p.oid,'execute')) as anon_execable_fns,
--     (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
--       where n.nspname='public' and c.relkind='v'
--         and coalesce((select option_value from pg_options_to_table(c.reloptions)
--                       where option_name='security_invoker'),'off')='on') as invoker_views;
