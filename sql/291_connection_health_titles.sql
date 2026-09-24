-- 291 — Connection-health notifications a person can act on.
--
-- They read "MEDIUM: qbo client token disabled — 9130348689331606": a severity
-- label, the check's internal name and a QuickBooks realm id. The title now names
-- the client (or mailbox) and says what to do. object_name stays the realm id /
-- email, because finding_key (the dedup key) is built from it.
--
-- connection_health_tick is copied from sql/270 with only the title expression
-- changed, and carries 270's grants.

create or replace function public.connection_health_title(p_check text, p_object text)
returns text
language sql
stable
set search_path to 'public'
as $function$
  with client as (
    select coalesce(e.name, qrc.company_name) as name
      from public.qbo_report_connections qrc
      left join public.entities e on e.id = qrc.entity_id
     where qrc.realm_id = p_object
     limit 1
  )
  select case p_check
    when 'qbo_client_token_disabled' then
      'QuickBooks connection lost for ' || coalesce((select name from client), 'a client')
      || ' — their dashboard won''t refresh until they reconnect'
    when 'qbo_refresh_expiring' then
      'QuickBooks connection for ' || coalesce((select name from client), 'the practice')
      || ' expires within 14 days — reconnect before it lapses'
    when 'qbo_disabled'       then 'QuickBooks billing connection is disconnected — invoices can''t be pushed'
    when 'gmail_disabled'     then 'Gmail connection stopped for ' || p_object || ' — reconnect it'
    when 'gmail_not_scanned'  then p_object || ' hasn''t been read for over a day — check the connection'
    when 'refresh_failing'    then 'A connection is struggling to refresh (' || p_object || ')'
    when 'drive_disabled'     then 'Google Drive connection stopped — document saves will fail'
    else replace(p_check, '_', ' ') || ' — ' || p_object
  end
$function$;

revoke all on function public.connection_health_title(text, text) from public, anon, authenticated;
grant execute on function public.connection_health_title(text, text) to service_role;

create or replace function public.connection_health_tick()
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public'
as $function$
declare
  v_new     int := 0;
  v_open    int := 0;
  v_cleared int := 0;
begin
  -- pg_cron (postgres) and service_role. Not is_active_staff(): under pg_cron
  -- auth.uid() is null, which would abort the whole tick. See sql/230.
  if not is_staff_or_service() then
    raise exception 'not authorised' using errcode = '42501';
  end if;

  create temp table _conn_now on commit drop as
  select a.severity, a.check_name, a.object_name, a.detail,
         a.check_name || ':' || a.object_name as finding_key
  from public.connection_health_audit() a;

  with upserted as (
    insert into public.connection_health_findings as f
      (finding_key, severity, check_name, object_name, detail)
    select n.finding_key, n.severity, n.check_name, n.object_name, n.detail
    from pg_temp._conn_now n
    on conflict (finding_key) do update
      set severity      = excluded.severity,
          detail        = excluded.detail,
          last_seen_at  = now(),
          -- A finding that comes back after being cleared counts as new again.
          first_seen_at = case when f.cleared_at is not null then now() else f.first_seen_at end,
          cleared_at    = null
    returning (first_seen_at = last_seen_at) as is_new
  )
  select count(*) filter (where is_new), count(*) into v_new, v_open from upserted;

  update public.connection_health_findings f
     set cleared_at = now()
   where f.cleared_at is null
     and not exists (select 1 from pg_temp._conn_now n where n.finding_key = f.finding_key);
  get diagnostics v_cleared = row_count;

  -- Written straight into notifications rather than through notify_staff(),
  -- which raises unless is_active_staff(). The unique index on
  -- (recipient_id, source_key) means a standing finding notifies once.
  if v_new > 0 then
    insert into notifications (recipient_id, kind, title, body, link_path, source_key)
    select sp.id,
           'connection_health',
           public.connection_health_title(n.check_name, n.object_name),
           n.detail,
           '/admin/connections',
           'conn_health:' || n.finding_key
    from pg_temp._conn_now n
    join public.connection_health_findings f
      on f.finding_key = n.finding_key and f.first_seen_at = f.last_seen_at
    cross join staff_profiles sp
    where sp.is_active and sp.can_manage_portal
    on conflict (recipient_id, source_key) where source_key is not null do nothing;
  end if;

  insert into public.scheduled_job_runs (job_key, started_at, finished_at, status, notes, stats, reported_by)
  values ('connection-health-watch', now(), now(),
          case when v_open = 0 then 'ok' else 'failed' end,
          case when v_open = 0 then 'All integration connections healthy.'
               else v_open || ' connection issue(s), ' || v_new || ' new.' end,
          jsonb_build_object('open', v_open, 'new', v_new, 'cleared', v_cleared),
          'connection_health_tick');

  return jsonb_build_object('open', v_open, 'new', v_new, 'cleared', v_cleared);
end $function$;

revoke all on function public.connection_health_tick() from public, anon, authenticated;
grant execute on function public.connection_health_tick() to service_role;

-- Reword the notifications already sent.
update notifications n
   set title = public.connection_health_title(f.check_name, f.object_name)
  from public.connection_health_findings f
 where n.kind = 'connection_health'
   and n.source_key = 'conn_health:' || f.finding_key;
