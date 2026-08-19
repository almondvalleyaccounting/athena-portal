-- 240: run the posture audit continuously, instead of only at commit time
--
-- The pre-commit gate (scripts/security-gate.cjs) has a structural hole that no
-- amount of tightening fixes: it guards `git`, and this project changes the database
-- through the Supabase MCP and the SQL editor. Those paths produce no diff to hash
-- and no commit to block. Worse, the ordering is inverted — a new object does not
-- exist until the migration is applied, so either prod carries the exposure before
-- the gate can see it, or the audit runs against a database that does not contain the
-- change and passes vacuously.
--
-- So detection has to be continuous and live in the database. Every 15 minutes,
-- whatever the change arrived through — migration, MCP, Studio, cron, or a commit
-- that was never gated — a new finding is recorded and the people who can act on it
-- are notified. Detection you cannot bypass beats prevention you can.
--
-- This does not replace the gate. The gate stops a bad change landing in the repo;
-- this catches the ones that never went through the repo at all.

-- ---------------------------------------------------------------------------
-- Open-findings ledger. One row per finding, so a finding that persists does not
-- re-notify, and one that is fixed is stamped cleared_at rather than deleted —
-- the history is the useful part.
-- ---------------------------------------------------------------------------
create table if not exists public.security_posture_findings (
  finding_key   text primary key,          -- check_name:object_name
  severity      text not null,
  check_name    text not null,
  object_name   text not null,
  detail        text not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  cleared_at    timestamptz
);

comment on table public.security_posture_findings is
  'Open + historical findings from security_posture_audit(), written every 15 minutes by security_posture_tick(). cleared_at set when a finding stops appearing. See sql/240.';

create index if not exists security_posture_findings_open_idx
  on public.security_posture_findings (cleared_at, severity);

alter table public.security_posture_findings enable row level security;
revoke all on public.security_posture_findings from anon, authenticated;
grant select, insert, update, delete on public.security_posture_findings to service_role;

-- ---------------------------------------------------------------------------
-- The tick.
-- ---------------------------------------------------------------------------
create or replace function public.security_posture_tick()
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public'
as $function$
declare
  v_new      int := 0;
  v_open     int := 0;
  v_cleared  int := 0;
begin
  -- pg_cron (postgres) and service_role only. Not is_active_staff(), so a
  -- no-JWT caller still passes; see is_staff_or_service() in sql/230.
  if not is_staff_or_service() then
    raise exception 'not authorised' using errcode = '42501';
  end if;

  create temp table _posture_now on commit drop as
  select a.severity, a.check_name, a.object_name, a.detail,
         a.check_name || ':' || a.object_name as finding_key
  from public.security_posture_audit() a;

  -- Re-open or refresh anything currently failing.
  with upserted as (
    insert into public.security_posture_findings as f
      (finding_key, severity, check_name, object_name, detail)
    select n.finding_key, n.severity, n.check_name, n.object_name, n.detail
    from pg_temp._posture_now n
    on conflict (finding_key) do update
      set severity     = excluded.severity,
          detail       = excluded.detail,
          last_seen_at = now(),
          -- A finding that comes back after being cleared counts as new again.
          first_seen_at = case when f.cleared_at is not null then now() else f.first_seen_at end,
          cleared_at   = null
    returning (first_seen_at = last_seen_at) as is_new
  )
  select count(*) filter (where is_new), count(*) into v_new, v_open from upserted;

  -- Anything that has stopped failing.
  update public.security_posture_findings f
     set cleared_at = now()
   where f.cleared_at is null
     and not exists (select 1 from pg_temp._posture_now n where n.finding_key = f.finding_key);
  get diagnostics v_cleared = row_count;

  -- Tell the people who can act. Written straight into `notifications` rather than
  -- through notify_staff(), which raises 'forbidden' unless is_active_staff() — under
  -- pg_cron auth.uid() is null, so calling it would abort the whole tick. The unique
  -- index notifications_dedupe (recipient_id, source_key) means a standing finding
  -- notifies once rather than every 15 minutes.
  if v_new > 0 then
    insert into notifications (recipient_id, kind, title, body, link_path, source_key)
    select sp.id,
           'security_posture',
           n.severity || ': ' || n.check_name || ' — ' || n.object_name,
           n.detail || '  Run: select * from public.security_posture_audit();',
           '/admin/schedules',
           'sec_posture:' || n.finding_key
    from pg_temp._posture_now n
    join public.security_posture_findings f
      on f.finding_key = n.finding_key and f.first_seen_at = f.last_seen_at
    cross join staff_profiles sp
    where sp.is_active and sp.can_manage_portal
    on conflict (recipient_id, source_key) where source_key is not null do nothing;
  end if;

  insert into public.scheduled_job_runs (job_key, started_at, finished_at, status, notes, stats, reported_by)
  values ('security-posture-audit', now(), now(),
          case when v_open = 0 then 'ok' else 'failed' end,
          case when v_open = 0 then 'No exposure findings.'
               else v_open || ' open finding(s), ' || v_new || ' new.' end,
          jsonb_build_object('open', v_open, 'new', v_new, 'cleared', v_cleared),
          'security_posture_tick');

  return jsonb_build_object('open', v_open, 'new', v_new, 'cleared', v_cleared);
end $function$;

revoke all on function public.security_posture_tick() from public, anon, authenticated;
grant execute on function public.security_posture_tick() to service_role;

-- ---------------------------------------------------------------------------
-- Schedule it, and register it so it shows up in /admin/schedules rather than
-- being an invisible timer.
-- ---------------------------------------------------------------------------
select cron.unschedule('security-posture-audit')
where exists (select 1 from cron.job where jobname = 'security-posture-audit');

select cron.schedule('security-posture-audit', '*/15 * * * *',
                     $$select public.security_posture_tick()$$);

insert into public.scheduled_job_docs
  (job_key, source, title, category, purpose, data_source, mechanism, run_as, gate_label, sort_order)
values (
  'security-posture-audit', 'pg_cron',
  'Security posture audit',
  'Platform safety',
  'Checks every 15 minutes for the ways client data can be exposed: a table with RLS off, a SECURITY DEFINER view or function reachable by anon or by a logged-in portal client, EXECUTE held by PUBLIC, a public Storage bucket, and unsafe realtime publication. Records anything it finds and notifies whoever can manage the portal. Exists because the pre-commit gate only sees changes that arrive as a git commit, and plenty arrive straight through the SQL editor.',
  'Athena''s own Postgres catalogue — grants, RLS flags, view and function definitions, Storage buckets. No client data is read.',
  'Automatic. pg_cron runs security_posture_tick() every 15 minutes, which calls security_posture_audit() and writes to security_posture_findings. Zero rows is the expected state; any row is treated as live exposure.',
  'System — the database itself, no user login involved.',
  null,
  5
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
