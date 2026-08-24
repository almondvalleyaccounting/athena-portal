-- 256 — Close the four findings the posture audit is reporting, and take the
-- token columns out of ordinary staff reach.
--
-- From the exposure review of 2026-08-24. The anon perimeter tested clean; every
-- finding here is internal. Two classes:
--
--   1. Authorisation (F1, F2). merge_person is SECURITY DEFINER, granted to
--      `authenticated`, and has no permission check anywhere in its body — and
--      client-portal users hold `authenticated` alongside staff, so a signed-in
--      client could call it and destroy person records. Three BM-person
--      functions carry an anon EXECUTE grant; they refuse unauthorised callers
--      internally, so nothing leaked, but the grant is one edit away from being
--      the only thing standing there.
--
--   2. Secret reach (F4). Every secret table has RLS on, but the ones added
--      earliest inherited a blanket `is_active_staff()` read and no column
--      restriction — so the policy that lets staff see *whether* QuickBooks is
--      connected also hands them the refresh token. All 11 active staff could
--      read AVA's own QBO tokens, the Drive token, 190 portal magic-link tokens
--      and a cron secret. None of those are consumed by a browser; they are
--      read by edge functions running as service_role, which bypasses all of
--      this. So the grant buys nothing and costs a blast radius.
--
-- Note on the mechanics of 4: Postgres will not let you revoke a *column* from
-- a role that holds table-level SELECT — column privileges are additive on top.
-- The only way to withhold one column is to revoke SELECT on the table and
-- grant it back column by column. Hence the verbose grant lists below; they are
-- each table's full column set minus the secret.

begin;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. merge_person — add the missing gate.
--
-- is_staff_or_service() passes active staff, service_role and no-JWT callers
-- (pg_cron, psql), so the import path and automation keep working while a
-- portal client is refused. Body is otherwise unchanged from the deployed
-- version. Nothing in the frontend calls this directly; it is reached through
-- apply_bm_person_merges, which has its own can_import_data check.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.merge_person(p_target uuid, p_source uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  src people%rowtype;
  tgt people%rowtype;
  best_open uuid;
  rec record;
begin
  if not is_staff_or_service() then
    raise exception 'forbidden: staff only' using errcode = '42501';
  end if;

  if p_target = p_source or p_target is null or p_source is null then return; end if;
  select * into src from people where id = p_source; if not found then return; end if;
  select * into tgt from people where id = p_target; if not found then return; end if;

  -- ch_code_requests: terminal source requests simply repoint - the partial
  -- unique index only covers non-terminal statuses so duplicates are ok.
  update ch_code_requests set person_id = p_target
   where person_id = p_source and status in ('entered_on_bm','stalled');

  -- Open requests: pair up source's and target's open requests by entity.
  -- Same entity on both sides = a genuine duplicate chase for one company -
  -- collapse to the furthest stage, drop the other. Different entities =
  -- the person is mid-chase on more than one company at once - repoint,
  -- don't delete, so every company's chase stays live under the survivor.
  for rec in
    select coalesce(s.entity_id, t.entity_id) as ent_id, s.id as source_req, t.id as target_req
    from (select * from ch_code_requests where person_id = p_source and status not in ('entered_on_bm','stalled')) s
    full outer join (select * from ch_code_requests where person_id = p_target and status not in ('entered_on_bm','stalled')) t
      on t.entity_id = s.entity_id
  loop
    if rec.source_req is not null and rec.target_req is not null then
      select id into best_open from (
        select id,
          case stage
            when 's5_entered'  then 6 when 's4_code'    then 5 when 's3b_us'     then 4
            when 's3a_client'  then 3 when 's2_decision' then 2 when 's1_offer'  then 1
            else 0 end as rk
        from ch_code_requests where id in (rec.source_req, rec.target_req)
      ) q order by rk desc, id limit 1;
      delete from ch_code_requests where id in (rec.source_req, rec.target_req) and id <> best_open;
      update ch_code_requests set person_id = p_target where id = best_open;
    elsif rec.source_req is not null then
      update ch_code_requests set person_id = p_target where id = rec.source_req;
    end if;
  end loop;

  update admin_tasks set person_id = p_target where person_id = p_source;

  -- entity_people: keep the surviving link's primary-contact flag if either
  -- side had it, then drop conflicting (entity, role) and move the rest.
  update entity_people tp set is_primary_contact = true
   where tp.person_id = p_target
     and exists (select 1 from entity_people sp
                  where sp.person_id = p_source and sp.entity_id = tp.entity_id
                    and sp.role = tp.role and sp.is_primary_contact);

  delete from entity_people sp
   where sp.person_id = p_source
     and exists (select 1 from entity_people tp
                  where tp.person_id = p_target and tp.entity_id = sp.entity_id and tp.role = sp.role);
  update entity_people set person_id = p_target where person_id = p_source;

  update entities set linked_person_id = p_target where linked_person_id = p_source;

  -- Delete source first to free ch_officer_id / ch_psc_id unique constraints.
  delete from people where id = p_source;

  -- Backfill missing fields onto target from the source snapshot. Name is set
  -- by the cluster driver to the fullest legal name, so it is not overwritten.
  update people set
    ch_personal_code = coalesce(nullif(ch_personal_code,''), src.ch_personal_code),
    ch_officer_id    = coalesce(ch_officer_id,    src.ch_officer_id),
    ch_psc_id        = coalesce(ch_psc_id,        src.ch_psc_id),
    dob_year         = coalesce(dob_year,         src.dob_year),
    dob_month        = coalesce(dob_month,        src.dob_month),
    date_of_birth    = coalesce(date_of_birth,    src.date_of_birth),
    bm_person_ref    = coalesce(bm_person_ref,    src.bm_person_ref),
    ni_number        = coalesce(ni_number,        src.ni_number),
    email            = coalesce(nullif(email,''), src.email),
    preferred_name   = coalesce(preferred_name,   src.preferred_name),
    updated_at       = now()
  where id = p_target;

  insert into audit_log(action, entity_type, entity_id, detail)
  values ('person_merge','person', p_target,
          jsonb_build_object('source_id', p_source, 'source_name', src.name,
                             'source_source', src.source, 'source_code', src.ch_personal_code,
                             'target_name', tgt.name));
end $function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Drop the anon EXECUTE grants on the BM-person functions.
--
-- `revoke from public` as well as from anon: if the grant had belonged to
-- PUBLIC the named revoke would have been a silent no-op. It does not here
-- (the ACL reads anon=X/postgres explicitly) but the pair costs nothing and
-- the failure mode is invisible.
-- ─────────────────────────────────────────────────────────────────────────────

revoke execute on function public.import_bm_people(uuid, jsonb)            from anon, public;
revoke execute on function public.apply_bm_person_merges(uuid[])           from anon, public;
revoke execute on function public.set_bm_person_merge_verdict(uuid[], text) from anon, public;

grant execute on function public.import_bm_people(uuid, jsonb)             to authenticated, service_role;
grant execute on function public.apply_bm_person_merges(uuid[])            to authenticated, service_role;
grant execute on function public.set_bm_person_merge_verdict(uuid[], text)  to authenticated, service_role;

-- The review view alongside them. It is security_invoker, so the base-table
-- policy already returned anon nothing — but anon has no business holding the
-- grant either.
revoke select on public.v_bm_person_merge_review from anon;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Token columns: withhold the secret, keep the status.
--
-- Each block revokes the blanket SELECT and grants back every column except
-- the credential. anon loses its grants outright — it never legitimately reads
-- these, and RLS was the only thing stopping it.
-- ─────────────────────────────────────────────────────────────────────────────

-- qbo_connections — the firm's own QuickBooks. The browser never queries this
-- table at all (verified: no .from('qbo_connections') anywhere in src/), so the
-- surviving grant is purely so a future status panel does not need a migration.
revoke all    on public.qbo_connections from anon;
revoke select on public.qbo_connections from authenticated;
grant  select (id, realm_id, company_name, token_expires_at, refresh_token_expires_at,
               scope, connected_by, connected_at, last_refreshed_at, status,
               error_message, created_at, updated_at, default_tax_code_id,
               default_tax_code_name, default_due_date_offset_days)
  on public.qbo_connections to authenticated;

-- gdrive_connections — the Reports-module Drive token. The browser reads
-- (id, account_email, status, connected_at) in onboarding/api.js.
revoke all    on public.gdrive_connections from anon;
revoke select on public.gdrive_connections from authenticated;
grant  select (id, account_email, token_expires_at, scope, connected_by,
               connected_at, last_refreshed_at, status, error_message, updated_at)
  on public.gdrive_connections to authenticated;

-- reminder_emails.token — the unguessable hex that authenticates a client's
-- click-through and opt-in. Reading one is enough to act as that client in
-- those flows. comm-click and comm-optin look it up as service_role.
-- UPDATE is left intact: staff drop queued reminders by setting status, and
-- `update ... returning id` needs SELECT only on id, which it still has.
revoke all    on public.reminder_emails from anon;
revoke select on public.reminder_emails from authenticated;
grant  select (id, kind, comm_type, entity_id, batch_id, payment_id, to_email,
               subject, gmail_message_id, gmail_thread_id, sent_at, sent_by,
               clicked_choice, clicked_at, reply_seen_at, created_at, status,
               body_html, body_text, queued_at, queued_by, clicked_link, is_resend)
  on public.reminder_emails to authenticated;

-- onboarding_chase_config.cron_secret — authenticates the chaser invocation.
-- getChaseConfig() in onboarding/api.js was select('*'); it is now an explicit
-- column list in the same commit.
revoke all    on public.onboarding_chase_config from anon;
revoke select on public.onboarding_chase_config from authenticated;
grant  select (id, sending_enabled, first_chase_after_days, chase_every_days,
               max_chases, internal_digest_enabled, updated_at, call_assignee_id,
               offboard_after_days, weekly_enabled, checkin_auto_send_enabled,
               reply_scan_enabled, weekly_recipient_ids, comms_ingest_enabled)
  on public.onboarding_chase_config to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Retire the dormant QBO credential.
--
-- Two rows for realm 123145912118784: one active (refreshed today), one
-- disconnected since 21 Jul whose refresh token is nonetheless still valid
-- until 30 Oct. qbo-push selects on status='active' with .single(), so the
-- dormant row is unreachable by the application and exists only as history.
-- Keep the row, blank the credential.
--
-- Both token columns are NOT NULL, so the tombstone is an empty string rather
-- than null. qbo-auth overwrites both on reconnect, so an empty string is not a
-- state any live code path can misread as a usable token.
-- ─────────────────────────────────────────────────────────────────────────────

update public.qbo_connections
   set access_token = '', refresh_token = ''
 where status = 'disconnected'
   and (access_token <> '' or refresh_token <> '');

commit;
