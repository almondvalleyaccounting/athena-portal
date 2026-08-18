-- 230: staff-only RPCs were callable by any logged-in user
--
-- `authenticated` is not the same thing as "staff". Client-portal users sign in
-- through Supabase auth, so they hold the `authenticated` role too (3 live portal
-- accounts today). A batch of SECURITY DEFINER functions that mutate practice-wide
-- data had EXECUTE granted to `authenticated` and no permission check of their own,
-- so a portal client could have fired them straight at /rest/v1/rpc/<name>.
--
-- Two shapes of fix:
--   A. Functions the staff UI calls  -> add an active-staff guard.
--   B. Functions only cron / edge functions call -> revoke the API-role grants.
--
-- Self-scoped functions (clear_my_must_change_password, mark_notifications_read,
-- portal_claim_invites) are deliberately left alone: they already key off
-- auth.uid() / the caller's own JWT email, so a portal user only ever touches
-- their own rows.

-- ---------------------------------------------------------------------------
-- The guard predicate.
--
-- current_user / current_role are useless here: inside a SECURITY DEFINER
-- function they read as the owner (postgres) no matter who called. request.jwt.claims
-- is a request-scoped GUC set by PostgREST and is not rewritten by the definer
-- switch, so it is the one reliable way to tell a service-role call from a user call.
--   - staff session          -> is_active_staff() is true
--   - service_role key       -> claims.role = 'service_role'
--   - pg_cron / psql         -> no claims GUC at all
--   - portal client / anon   -> claims present, role <> service_role, not staff -> denied
-- anon is additionally revoked below so it never reaches a function body.
-- ---------------------------------------------------------------------------
create or replace function public.is_staff_or_service()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select is_active_staff()
      or coalesce(
           nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
           ''
         ) = 'service_role'
      or nullif(current_setting('request.jwt.claims', true), '') is null;
$$;

revoke execute on function public.is_staff_or_service() from anon;

-- ---------------------------------------------------------------------------
-- A. Guard the staff-UI RPCs.
-- ---------------------------------------------------------------------------

create or replace function public.admin_tasks_confirm_from_bm()
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  n int := 0;
  t record;
  entity_val text;
begin
  if not is_staff_or_service() then
    raise exception 'not authorised' using errcode = '42501';
  end if;

  for t in
    select a.id, a.entity_id, a.field, a.value from admin_tasks a
     where a.kind = 'bm_code' and a.field is not null
       and a.confirmed_at is null and a.dismissed_at is null
       -- a reopened task stays open until it is manually completed again
       and (a.reopened_at is null or a.done_at is not null)
       -- only fields that live on entities can be checked here; person-level
       -- fields (ch_personal_code) are confirmed by reconcile_ch_codes
       and a.field in (select column_name from information_schema.columns
                        where table_schema = 'public' and table_name = 'entities')
  loop
    execute format('select %I from entities where id = $1', t.field) into entity_val using t.entity_id;
    if entity_val is not null and (
         t.value is null
         or regexp_replace(lower(entity_val), '[^a-z0-9]', '', 'g') = regexp_replace(lower(t.value), '[^a-z0-9]', '', 'g')
       ) then
      update admin_tasks set confirmed_at = now(), done_at = coalesce(done_at, now()) where id = t.id;
      n := n + 1;
    end if;
  end loop;
  return n;
end;
$function$;

create or replace function public.bk_autolink_realms()
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_n int;
begin
  if not is_staff_or_service() then
    raise exception 'not authorised' using errcode = '42501';
  end if;

  with one as (
    select realm_id, (array_agg(entity_id))[1] entity_id
    from public.v_bk_realm_link_candidates
    where confidence = 'exact' and not is_former
    group by realm_id having count(*) = 1
  )
  update public.qbo_report_connections rc
     set entity_id = one.entity_id,
         entity_link_source = 'auto_exact',
         entity_linked_at = now()
    from one
   where rc.realm_id = one.realm_id
     and rc.entity_id is null
     and coalesce(rc.is_practice, false) = false
     and rc.status = 'active';
  get diagnostics v_n = row_count;
  return v_n;
end;
$function$;

create or replace function public.bk_seed_watch_config()
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_n int;
begin
  if not is_staff_or_service() then
    raise exception 'not authorised' using errcode = '42501';
  end if;

  with src as (
    select entity_id,
           bool_or(canonical_service_id = 'bookkeeping') as does_bk,
           bool_or(canonical_service_id = 'vat_review')  as does_vat,
           min(cadence) filter (where canonical_service_id in ('bookkeeping', 'vat_review')) as cadence
    from public.v_service_cadence
    where canonical_service_id in ('bookkeeping', 'vat_review')
    group by entity_id
  ),
  linked as (
    select distinct rc.entity_id
    from public.qbo_report_connections rc
    join public.qbo_report_tokens t on t.realm_id = rc.realm_id and t.status = 'active'
    where rc.entity_id is not null and rc.status = 'active'
  )
  insert into public.bk_watch_config as w (entity_id, books_owner, books_owner_source, cadence)
  select s.entity_id,
         case when s.does_bk then 'us' else 'client' end,
         'auto_service_cadence', s.cadence
  from src s join linked l on l.entity_id = s.entity_id
  on conflict (entity_id) do update
    set books_owner = case when w.books_owner_source = 'manual' then w.books_owner else excluded.books_owner end,
        cadence     = coalesce(w.cadence, excluded.cadence),
        updated_at  = now();
  get diagnostics v_n = row_count;
  return v_n;
end;
$function$;

create or replace function public.confirm_wont_happen_tasks()
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare n int;
begin
  if not is_staff_or_service() then
    raise exception 'not authorised' using errcode = '42501';
  end if;

  update admin_tasks t
     set confirmed_at = now()
   where t.source = 'bm_task_wont_happen'
     and t.confirmed_at is null and t.dismissed_at is null
     and not exists (
       select 1 from bm_task_schedule s
       where s.bm_task_id = t.detail and s.state = 'planned'
     );
  get diagnostics n = row_count;
  return n;
end $function$;

create or replace function public.reconcile_field_overrides()
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare o record; v_bm text; v_diff int := 0;
begin
  if not is_staff_or_service() then
    raise exception 'not authorised' using errcode = '42501';
  end if;

  for o in select id, entity_id, field, value from admin_tasks
            where kind = 'bm_field' and confirmed_at is null and dismissed_at is null
  loop
    execute format('select %I::text from entities where id = $1', o.field) into v_bm using o.entity_id;
    if _norm_code(v_bm) = _norm_code(o.value) then
      update admin_tasks set bm_value = v_bm, confirmed_at = now() where id = o.id;
    else
      execute format('update entities set %I = $1, updated_at = now() where id = $2', o.field)
        using nullif(o.value,''), o.entity_id;
      update admin_tasks set bm_value = v_bm where id = o.id;
      v_diff := v_diff + 1;
    end if;
  end loop;
  return v_diff;
end;
$function$;

create or replace function public.reconcile_ready_now_change_requests()
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  cr record;
  bm_target date;
  resolved int := 0;
begin
  if not is_staff_or_service() then
    raise exception 'not authorised' using errcode = '42501';
  end if;

  for cr in
    select id, entity_id, service, period_end, proposed_value
    from ready_now_change_requests
    where status = 'pending' and field = 'bm_target'
  loop
    begin
      bm_target := null;
      select rnj.bm_target_date into bm_target
      from ready_now_jobs rnj
      where rnj.entity_id = cr.entity_id
        and rnj.service = cr.service
        and rnj.period_end is not distinct from cr.period_end;

      if bm_target is not null and cr.proposed_value is not null
         and bm_target = cr.proposed_value::date then
        update ready_now_change_requests
        set status = 'applied', applied_at = now()
        where id = cr.id;
        resolved := resolved + 1;
      end if;
    exception when others then
      continue;
    end;
  end loop;
  return resolved;
end;
$function$;

-- This one reads the service-role key out of Vault and fires an HTTP POST, so an
-- unguarded grant to `authenticated` was the sharpest edge in the batch.
create or replace function public.trigger_qbo_monthly_pull(p_trigger text default 'cron'::text)
returns bigint
language plpgsql
security definer
set search_path to 'public', 'extensions', 'net', 'vault'
as $function$
DECLARE
  v_run_id bigint;
  v_request_id bigint;
  v_url text;
  v_service_key text;
BEGIN
  IF NOT is_staff_or_service() THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;

  -- Pull project URL + service-role key from Vault.
  -- Secret names expected: 'planning_project_url' and 'planning_service_role_key'.
  SELECT decrypted_secret INTO v_url FROM vault.decrypted_secrets WHERE name = 'planning_project_url' LIMIT 1;
  SELECT decrypted_secret INTO v_service_key FROM vault.decrypted_secrets WHERE name = 'planning_service_role_key' LIMIT 1;

  IF v_url IS NULL OR v_service_key IS NULL THEN
    INSERT INTO plan_qbo_sync_runs (trigger, status, error_message, completed_at)
    VALUES (p_trigger, 'error', 'vault secrets not set: planning_project_url and/or planning_service_role_key', now())
    RETURNING id INTO v_run_id;
    RETURN v_run_id;
  END IF;

  INSERT INTO plan_qbo_sync_runs (trigger, status) VALUES (p_trigger, 'pending') RETURNING id INTO v_run_id;

  SELECT net.http_post(
    url := v_url || '/functions/v1/planning-qbo-pull',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_service_key,
      'apikey', v_service_key
    ),
    body := jsonb_build_object('granularity', 'monthly', 'months_back', 12)
  ) INTO v_request_id;

  UPDATE plan_qbo_sync_runs SET request_id = v_request_id WHERE id = v_run_id;
  RETURN v_run_id;
END;
$function$;

revoke execute on function public.admin_tasks_confirm_from_bm() from anon;
revoke execute on function public.bk_autolink_realms() from anon;
revoke execute on function public.bk_seed_watch_config() from anon;
revoke execute on function public.confirm_wont_happen_tasks() from anon;
revoke execute on function public.reconcile_field_overrides() from anon;
revoke execute on function public.reconcile_ready_now_change_requests() from anon;
revoke execute on function public.trigger_qbo_monthly_pull(text) from anon;

-- ---------------------------------------------------------------------------
-- B. Cron / edge-function-only RPCs: no API role needs to call these at all.
--    service_role and pg_cron are unaffected by revoking anon + authenticated.
-- ---------------------------------------------------------------------------
revoke execute on function public.bk_drift_tick() from anon, authenticated;
revoke execute on function public.bk_seed_assignees() from anon, authenticated;
revoke execute on function public.bk_suggest_tiers() from anon, authenticated;
revoke execute on function public.reconcile_allocation_changes() from anon, authenticated;
revoke execute on function public.reconcile_qbo_sync_responses() from anon, authenticated;
revoke execute on function public.run_bug_review_digest() from anon, authenticated;
