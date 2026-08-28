-- 270: notice when an integration connection goes quiet
--
-- On 2026-07-23 Google answered one Gmail token refresh with a 503. The helper
-- wrote status='error' on the connection, every cron scans status='active'
-- only, and so accounts@ stopped being ingested. Nothing said anything. It was
-- found 36 days later, by accident, because a quote was blind-copied there and
-- failed to appear on the client page.
--
-- _shared/oauth-refresh.ts fixes the cause: a transient failure no longer
-- disables a connection. But a genuinely revoked grant still disables one, and
-- correctly so — and that connection would sit dead in exactly the same silence
-- until somebody happened to look. Prevention narrowed the hole; only detection
-- closes it.
--
-- Same shape as sql/240: an audit function, a findings ledger so a standing
-- problem does not re-notify, and a tick on pg_cron. Deliberately checks the
-- work rather than the flag — a mailbox whose ingest has not advanced in 24
-- hours is broken whatever its status column says, which is the specific thing
-- that would have caught July within a day.

-- ---------------------------------------------------------------------------
-- The audit. Reads connection metadata only — never a token, an access code or
-- a refresh token, so the result is safe to put in a notification body.
-- ---------------------------------------------------------------------------
create or replace function public.connection_health_audit()
returns table (severity text, check_name text, object_name text, detail text)
language sql
stable
security definer
set search_path to 'public'
as $function$
  -- 1. A mailbox that has been disabled. Only 'error' — 'disconnected' is a
  --    deliberate act, not a fault.
  select 'HIGH'::text, 'gmail_disabled'::text, gc.account_email::text,
         'Gmail connection is disabled and is being skipped by every cron. '
         || coalesce(gc.error_message, 'No error recorded.')
         || ' Reconnect at /admin/connections.'
  from public.gmail_connections gc
  where gc.status = 'error'

  union all

  -- 2. The one that matters: an active mailbox whose ingest has stopped
  --    advancing. comms_ingest_state.updated_at is stamped on every run in both
  --    incremental and backfill mode, and processMailbox returns early WITHOUT
  --    stamping it when the token cannot be resolved — so this goes stale
  --    exactly when the mailbox stops being read, whatever the status says.
  select 'HIGH', 'gmail_not_scanned', gc.account_email::text,
         'Mailbox is marked active but has not been ingested since '
         || coalesce(to_char(cis.updated_at, 'YYYY-MM-DD HH24:MI'), 'never')
         || ' (cron runs every 15 minutes). Check the Gmail connection.'
  from public.gmail_connections gc
  left join public.comms_ingest_state cis
    on lower(cis.mailbox) = lower(gc.account_email)
  where gc.status = 'active'
    -- Give a freshly connected mailbox a day to complete its first pass.
    and gc.connected_at < now() - interval '24 hours'
    and coalesce(cis.updated_at, gc.connected_at) < now() - interval '24 hours'

  union all

  -- 3. Refresh is failing but the connection was deliberately left enabled
  --    (the transient path in _shared/oauth-refresh.ts). Self-healing by
  --    design, so MEDIUM — but if it persists it is worth a look.
  select 'MEDIUM', 'refresh_failing', src.label,
         'Token refresh is failing while the connection stays enabled: '
         || src.error_message
  from (
    select 'gmail:'   || account_email as label, error_message, status from public.gmail_connections
    union all
    select 'drive:'   || account_email,          error_message, status from public.gdrive_connections
    union all
    select 'qbo:'     || realm_id,               error_message, status from public.qbo_connections
    union all
    select 'qbo-client:' || realm_id,            error_message, status from public.qbo_report_tokens
  ) src
  where src.status = 'active' and src.error_message is not null

  union all

  -- 4. The billing QBO connection is the one every invoice push depends on.
  select 'HIGH', 'qbo_disabled', qc.realm_id::text,
         'QBO billing connection ('
         || coalesce(qc.company_name, 'unnamed realm')
         || ') is disabled. ' || coalesce(qc.error_message, 'No error recorded.')
  from public.qbo_connections qc
  where qc.status = 'error'

  union all

  -- 5. A single client's report token — the dashboard for that client goes
  --    blank, nothing else breaks.
  select 'MEDIUM', 'qbo_client_token_disabled', qrt.realm_id::text,
         'QBO client token is disabled; that client''s dashboard will not refresh. '
         || coalesce(qrt.error_message, 'No error recorded.')
  from public.qbo_report_tokens qrt
  where qrt.status = 'error'

  union all

  -- 6. Intuit rotates the refresh token on every use and expires it after ~100
  --    days. If one lapses the client has to reconnect, so say so while there
  --    is still time to avoid that.
  select 'HIGH', 'qbo_refresh_expiring', src.realm_id,
         'QBO refresh token expires ' || to_char(src.exp, 'YYYY-MM-DD')
         || '. Once it lapses the connection cannot be refreshed and needs a '
         || 'manual reconnect.'
  from (
    select realm_id::text, refresh_token_expires_at as exp, status from public.qbo_connections
    union all
    select realm_id::text, refresh_token_expires_at,          status from public.qbo_report_tokens
  ) src(realm_id, exp, status)
  where src.status = 'active'
    and src.exp is not null
    and src.exp < now() + interval '14 days'

  union all

  -- 7. Drive holds the client document filing.
  select 'HIGH', 'drive_disabled', gd.account_email::text,
         'Google Drive connection is disabled; document saves will fail. '
         || coalesce(gd.error_message, 'No error recorded.')
  from public.gdrive_connections gd
  where gd.status = 'error'

  order by 1, 2, 3;
$function$;

comment on function public.connection_health_audit() is
  'Integration connections that are disabled, failing to refresh, expiring, or no longer being read. Reads metadata only, never token material. See sql/270.';

revoke all on function public.connection_health_audit() from public, anon, authenticated;
grant execute on function public.connection_health_audit() to service_role;

-- ---------------------------------------------------------------------------
-- Findings ledger. One row per finding so a standing problem notifies once, and
-- a resolved one is stamped cleared_at rather than deleted.
-- ---------------------------------------------------------------------------
create table if not exists public.connection_health_findings (
  finding_key   text primary key,          -- check_name:object_name
  severity      text not null,
  check_name    text not null,
  object_name   text not null,
  detail        text not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  cleared_at    timestamptz
);

comment on table public.connection_health_findings is
  'Open + historical findings from connection_health_audit(), written hourly by connection_health_tick(). See sql/270.';

create index if not exists connection_health_findings_open_idx
  on public.connection_health_findings (cleared_at, severity);

alter table public.connection_health_findings enable row level security;
revoke all on public.connection_health_findings from anon, authenticated;
grant select, insert, update, delete on public.connection_health_findings to service_role;

-- ---------------------------------------------------------------------------
-- The tick.
-- ---------------------------------------------------------------------------
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
           n.severity || ': ' || replace(n.check_name, '_', ' ') || ' — ' || n.object_name,
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

-- ---------------------------------------------------------------------------
-- Schedule + register. Hourly at :17 — the staleness threshold is 24 hours, but
-- a disabled connection is worth catching within the hour, and the findings
-- ledger means checking often costs nothing in noise.
-- ---------------------------------------------------------------------------
select cron.unschedule('connection-health-watch')
where exists (select 1 from cron.job where jobname = 'connection-health-watch');

select cron.schedule('connection-health-watch', '17 * * * *',
                     $$select public.connection_health_tick()$$);

insert into public.scheduled_job_docs
  (job_key, source, title, category, purpose, data_source, mechanism, run_as, gate_label, sort_order)
values (
  'connection-health-watch', 'pg_cron',
  'Connection health watch',
  'Platform safety',
  'Checks every hour that the integrations Athena depends on are still alive: each Gmail mailbox, the QBO billing connection, all client QBO report tokens, and Google Drive. Flags a connection that has been disabled, one whose token refresh keeps failing, a QBO refresh token within 14 days of expiring, and — the important one — a mailbox that is marked active but whose ingest has not advanced in 24 hours. Exists because accounts@ was silently dropped from ingest for 36 days in July after a single transient Google 503, and nothing noticed.',
  'Connection metadata only — status, error message, last refresh and last ingest timestamps. No token, refresh token or message content is read.',
  'Automatic. pg_cron runs connection_health_tick() hourly, which calls connection_health_audit() and writes to connection_health_findings. Zero rows is the expected state. Anyone with can_manage_portal is notified once per finding, not once per run.',
  'System — the database itself, no user login involved.',
  null,
  6
)
on conflict (job_key) do update
  set title       = excluded.title,
      category    = excluded.category,
      purpose     = excluded.purpose,
      data_source = excluded.data_source,
      mechanism   = excluded.mechanism,
      run_as      = excluded.run_as,
      sort_order  = excluded.sort_order,
      updated_at  = now();
