-- 224_scheduled_jobs_configurable.sql
--
-- Step 2 of the Scheduled Jobs page: stop it being read-only.
--
-- Three things become editable from /admin/schedules, and one becomes
-- readable by the automations themselves:
--
--   1. The switches and tunables each job obeys. These already live in the
--      per-feature config tables (onboarding_chase_config, ch_refresh_config,
--      bk_drift_settings …) and the edge functions read them there — so this
--      does NOT copy them into a new table. scheduled_job_settings is a
--      BINDING registry: it says "this job has a setting called X, which is
--      really onboarding_chase_config.weekly_enabled, it's a boolean, and
--      changing it can email clients". One source of truth, described.
--
--   2. The schedule. For pg_cron jobs that means cron.alter_job; for work
--      scheduled outside the database it means recording the intended cadence
--      here for the outside scheduler to follow.
--
--   3. Instructions for Claude — free text, per job, held in Athena rather
--      than in a scheduled-task file on someone's laptop.
--
-- And scheduled_job_brief() is the read side of (3): an automation asks Athena
-- "what am I meant to do, am I armed, what are my settings" at the start of a
-- run instead of carrying a hardcoded copy.
--
-- Writes are allowlisted: set_scheduled_job_setting() will only touch a
-- (table, column) pair that already has a binding row, so the dynamic SQL can
-- never be pointed at an arbitrary column.

-- ── Instructions the automations read ────────────────────────────────────
alter table public.scheduled_job_docs
  add column if not exists claude_instructions text;

comment on column public.scheduled_job_docs.claude_instructions is
  'Operating instructions for an automated runner, editable in Athena and read back via scheduled_job_brief().';

-- Knobs for a job whose settings have no feature table to bind to — an
-- external runner has nowhere else to keep them. Bound settings win over
-- these in scheduled_job_brief(), because a bound value is the one the job
-- genuinely reads.
alter table public.scheduled_job_docs
  add column if not exists claude_settings jsonb not null default '{}'::jsonb;

comment on column public.scheduled_job_docs.claude_settings is
  'Free-form knobs for a job whose settings have no feature table of their own — typically an external runner. Merged under the bound settings by scheduled_job_brief().';

-- ── Binding registry: which setting belongs to which job ─────────────────
create table if not exists public.scheduled_job_settings (
  job_key           text not null references public.scheduled_job_docs(job_key) on delete cascade,
  setting_key       text not null,
  label             text not null,
  help              text,
  value_type        text not null check (value_type in ('boolean', 'int', 'text')),
  target_table      text not null,
  target_column     text not null,
  -- These config tables are singletons keyed either `id boolean = true`
  -- or `id integer = 1`. Storing which, rather than a predicate, keeps the
  -- dynamic SQL free of anything a caller could shape.
  id_kind           text not null check (id_kind in ('bool_true', 'int_one')),
  touch_updated_at  boolean not null default false,
  min_value         int,
  max_value         int,
  risk              text not null default 'internal'
                      check (risk in ('internal', 'client_facing')),
  risk_note         text,
  sort_order         int not null default 100,
  primary key (job_key, setting_key)
);

comment on table public.scheduled_job_settings is
  'Binding registry — maps a named setting on a scheduled job to the real config column the job reads. Also the write allowlist.';

alter table public.scheduled_job_settings enable row level security;

drop policy if exists scheduled_job_settings_read on public.scheduled_job_settings;
create policy scheduled_job_settings_read on public.scheduled_job_settings
  for select to authenticated using (public.is_active_staff());

revoke all on public.scheduled_job_settings from public, anon;
grant select on public.scheduled_job_settings to authenticated;

-- ── Who changed what ────────────────────────────────────────────────────
create table if not exists public.scheduled_job_changes (
  id           bigserial primary key,
  job_key      text not null,
  change_type  text not null check (change_type in ('setting', 'schedule', 'active', 'instructions', 'settings_json')),
  setting_key  text,
  old_value    text,
  new_value    text,
  changed_by   uuid references public.staff_profiles(id),
  changed_at   timestamptz not null default now()
);

create index if not exists scheduled_job_changes_at_idx
  on public.scheduled_job_changes (changed_at desc);

alter table public.scheduled_job_changes enable row level security;

drop policy if exists scheduled_job_changes_read on public.scheduled_job_changes;
create policy scheduled_job_changes_read on public.scheduled_job_changes
  for select to authenticated using (public.is_active_staff());

revoke all on public.scheduled_job_changes from public, anon;
grant select on public.scheduled_job_changes to authenticated;

-- ── Runs reported by something outside pg_cron ───────────────────────────
create table if not exists public.scheduled_job_runs (
  id          bigserial primary key,
  job_key     text not null references public.scheduled_job_docs(job_key) on delete cascade,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  status      text not null check (status in ('running', 'ok', 'partial', 'failed', 'skipped')),
  notes       text,
  stats       jsonb,
  reported_by text
);

create index if not exists scheduled_job_runs_job_idx
  on public.scheduled_job_runs (job_key, started_at desc);

alter table public.scheduled_job_runs enable row level security;

drop policy if exists scheduled_job_runs_read on public.scheduled_job_runs;
create policy scheduled_job_runs_read on public.scheduled_job_runs
  for select to authenticated using (public.is_active_staff());

revoke all on public.scheduled_job_runs from public, anon;
grant select on public.scheduled_job_runs to authenticated;

-- ── Helpers ─────────────────────────────────────────────────────────────
create or replace function public.can_manage_schedules()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from staff_profiles
    where id = auth.uid() and is_active = true and can_manage_portal = true
  );
$$;

revoke all on function public.can_manage_schedules() from public, anon;
grant execute on function public.can_manage_schedules() to authenticated, service_role;

-- Shape check only. pg_cron does the semantic validation when the schedule
-- is applied, and its error is passed straight back to the caller.
create or replace function public.is_valid_cron(p_expr text)
returns boolean
language sql
immutable
as $$
  select coalesce(p_expr, '') ~
    '^\s*[-0-9*/,]+\s+[-0-9*/,]+\s+[-0-9*/,]+\s+[-0-9*/,]+\s+[-0-9*/,]+\s*$';
$$;

-- Predicate for a singleton config row. Not caller-controlled: id_kind is
-- constrained to two values and only ever set by a migration.
create or replace function public.scheduled_job_row_filter(p_id_kind text)
returns text
language sql
immutable
as $$
  select case p_id_kind
    when 'bool_true' then 'id'
    when 'int_one'   then 'id = 1'
  end;
$$;

-- ── Read the live value of every setting on a job ────────────────────────
create or replace function public.scheduled_job_setting_values(p_job_key text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  r   record;
  v   jsonb;
  out jsonb := '[]'::jsonb;
begin
  for r in
    select * from scheduled_job_settings
    where job_key = p_job_key
    order by sort_order, setting_key
  loop
    execute format(
      'select to_jsonb(%I) from public.%I where %s limit 1',
      r.target_column, r.target_table, public.scheduled_job_row_filter(r.id_kind)
    ) into v;

    out := out || jsonb_build_object(
      'setting_key', r.setting_key,
      'label',       r.label,
      'help',        r.help,
      'value_type',  r.value_type,
      'value',       v,
      'min_value',   r.min_value,
      'max_value',   r.max_value,
      'risk',        r.risk,
      'risk_note',   r.risk_note,
      'binding',     r.target_table || '.' || r.target_column
    );
  end loop;
  return out;
end;
$$;

revoke all on function public.scheduled_job_setting_values(text) from public, anon;
grant execute on function public.scheduled_job_setting_values(text) to authenticated, service_role;

-- ── Change a setting ────────────────────────────────────────────────────
create or replace function public.set_scheduled_job_setting(
  p_job_key     text,
  p_setting_key text,
  p_value       jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  s       scheduled_job_settings;
  v_old   jsonb;
  v_text  text;
  v_int   int;
  v_where text;
begin
  if not public.can_manage_schedules() then
    raise exception 'not authorised';
  end if;

  select * into s from scheduled_job_settings
  where job_key = p_job_key and setting_key = p_setting_key;

  if s.job_key is null then
    raise exception 'no such setting: %.%', p_job_key, p_setting_key;
  end if;

  v_where := public.scheduled_job_row_filter(s.id_kind);

  -- Type check before anything is written.
  if s.value_type = 'boolean' then
    if jsonb_typeof(p_value) <> 'boolean' then
      raise exception '% expects true or false', s.label;
    end if;
    v_text := p_value #>> '{}';
  elsif s.value_type = 'int' then
    if jsonb_typeof(p_value) <> 'number' then
      raise exception '% expects a whole number', s.label;
    end if;
    v_int := (p_value #>> '{}')::numeric::int;
    if s.min_value is not null and v_int < s.min_value then
      raise exception '% must be % or more', s.label, s.min_value;
    end if;
    if s.max_value is not null and v_int > s.max_value then
      raise exception '% must be % or less', s.label, s.max_value;
    end if;
    v_text := v_int::text;
  else
    if jsonb_typeof(p_value) <> 'string' then
      raise exception '% expects text', s.label;
    end if;
    v_text := p_value #>> '{}';
  end if;

  execute format(
    'select to_jsonb(%I) from public.%I where %s limit 1',
    s.target_column, s.target_table, v_where
  ) into v_old;

  execute format(
    'update public.%I set %I = $1::%s where %s',
    s.target_table, s.target_column,
    case s.value_type when 'boolean' then 'boolean'
                      when 'int'     then 'integer'
                      else 'text' end,
    v_where
  ) using v_text;

  if s.touch_updated_at then
    execute format('update public.%I set updated_at = now() where %s', s.target_table, v_where);
  end if;

  -- Arming the bookkeeping-drift nudges is recorded on the settings row
  -- itself (who armed it, when) — that table is built to remember.
  if s.target_table = 'bk_drift_settings' and s.target_column = 'nudges_armed' then
    update bk_drift_settings
       set armed_by = case when v_text = 'true' then auth.uid() else null end,
           armed_at = case when v_text = 'true' then now() else null end
     where id = 1;
  end if;

  insert into scheduled_job_changes (job_key, change_type, setting_key, old_value, new_value, changed_by)
  values (p_job_key, 'setting', p_setting_key, v_old #>> '{}', v_text, auth.uid());

  return jsonb_build_object('ok', true, 'value', p_value);
end;
$$;

revoke all on function public.set_scheduled_job_setting(text, text, jsonb) from public, anon;
grant execute on function public.set_scheduled_job_setting(text, text, jsonb) to authenticated;

-- ── Change the schedule ─────────────────────────────────────────────────
create or replace function public.set_scheduled_job_schedule(p_job_key text, p_cron text)
returns jsonb
language plpgsql
security definer
set search_path = public, cron
as $$
declare
  v_jobid bigint;
  v_old   text;
begin
  if not public.can_manage_schedules() then
    raise exception 'not authorised';
  end if;

  if not public.is_valid_cron(p_cron) then
    raise exception 'that is not a 5-field cron expression (minute hour day-of-month month day-of-week)';
  end if;

  select jobid, schedule into v_jobid, v_old from cron.job where jobname = p_job_key;

  if v_jobid is not null then
    perform cron.alter_job(job_id := v_jobid, schedule := p_cron);
  else
    -- Scheduled outside the database. Athena records the intended cadence;
    -- the outside scheduler has to be pointed at it separately.
    select external_cron into v_old from scheduled_job_docs where job_key = p_job_key;
    if not found then
      raise exception 'no such job: %', p_job_key;
    end if;
    update scheduled_job_docs
       set external_cron = p_cron, updated_at = now(), updated_by = auth.uid()
     where job_key = p_job_key;
  end if;

  insert into scheduled_job_changes (job_key, change_type, old_value, new_value, changed_by)
  values (p_job_key, 'schedule', v_old, p_cron, auth.uid());

  return jsonb_build_object('ok', true, 'schedule', p_cron, 'pg_cron', v_jobid is not null);
end;
$$;

revoke all on function public.set_scheduled_job_schedule(text, text) from public, anon;
grant execute on function public.set_scheduled_job_schedule(text, text) to authenticated;

-- ── Pause / resume ──────────────────────────────────────────────────────
create or replace function public.set_scheduled_job_active(p_job_key text, p_active boolean)
returns jsonb
language plpgsql
security definer
set search_path = public, cron
as $$
declare
  v_jobid bigint;
  v_old   boolean;
begin
  if not public.can_manage_schedules() then
    raise exception 'not authorised';
  end if;

  select jobid, active into v_jobid, v_old from cron.job where jobname = p_job_key;
  if v_jobid is null then
    raise exception 'only database-scheduled jobs can be paused here';
  end if;

  perform cron.alter_job(job_id := v_jobid, active := p_active);

  insert into scheduled_job_changes (job_key, change_type, old_value, new_value, changed_by)
  values (p_job_key, 'active', v_old::text, p_active::text, auth.uid());

  return jsonb_build_object('ok', true, 'active', p_active);
end;
$$;

revoke all on function public.set_scheduled_job_active(text, boolean) from public, anon;
grant execute on function public.set_scheduled_job_active(text, boolean) to authenticated;

-- ── Instructions ────────────────────────────────────────────────────────
create or replace function public.set_scheduled_job_instructions(p_job_key text, p_text text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_old text;
begin
  if not public.can_manage_schedules() then
    raise exception 'not authorised';
  end if;

  select claude_instructions into v_old from scheduled_job_docs where job_key = p_job_key;
  if not found then
    raise exception 'no such job: %', p_job_key;
  end if;

  update scheduled_job_docs
     set claude_instructions = nullif(btrim(p_text), ''),
         updated_at = now(), updated_by = auth.uid()
   where job_key = p_job_key;

  insert into scheduled_job_changes (job_key, change_type, old_value, new_value, changed_by)
  values (p_job_key, 'instructions', left(v_old, 200), left(p_text, 200), auth.uid());

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.set_scheduled_job_instructions(text, text) from public, anon;
grant execute on function public.set_scheduled_job_instructions(text, text) to authenticated;

create or replace function public.set_scheduled_job_claude_settings(p_job_key text, p_settings jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_old jsonb;
begin
  if not public.can_manage_schedules() then
    raise exception 'not authorised';
  end if;

  if p_settings is null or jsonb_typeof(p_settings) <> 'object' then
    raise exception 'settings must be a JSON object, e.g. {"services": ["paye", "corporation-tax"]}';
  end if;

  select claude_settings into v_old from scheduled_job_docs where job_key = p_job_key;
  if not found then
    raise exception 'no such job: %', p_job_key;
  end if;

  update scheduled_job_docs
     set claude_settings = p_settings, updated_at = now(), updated_by = auth.uid()
   where job_key = p_job_key;

  insert into scheduled_job_changes (job_key, change_type, old_value, new_value, changed_by)
  values (p_job_key, 'settings_json', left(v_old::text, 200), left(p_settings::text, 200), auth.uid());

  return jsonb_build_object('ok', true, 'settings', p_settings);
end;
$$;

revoke all on function public.set_scheduled_job_claude_settings(text, jsonb) from public, anon;
grant execute on function public.set_scheduled_job_claude_settings(text, jsonb) to authenticated;

-- ── The read side: what an automation asks Athena before it runs ────────
create or replace function public.scheduled_job_brief(p_job_key text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, cron
as $$
declare
  d        scheduled_job_docs;
  v_cron   text;
  v_active boolean;
  v_gate   boolean;
  v_set    jsonb;
  v_flat   jsonb := '{}'::jsonb;
  v_last   jsonb;
begin
  if not (public.is_active_staff() or auth.role() = 'service_role') then
    raise exception 'not authorised';
  end if;

  select * into d from scheduled_job_docs where job_key = p_job_key;
  if d.job_key is null then
    raise exception 'no such job: %', p_job_key;
  end if;

  select schedule, active into v_cron, v_active from cron.job where jobname = p_job_key;
  v_cron   := coalesce(v_cron, d.external_cron);
  v_active := coalesce(v_active, true);
  v_gate   := public.scheduled_job_gate(p_job_key);

  -- Settings as a flat key/value map — what a caller actually wants to read.
  v_set := public.scheduled_job_setting_values(p_job_key);
  select coalesce(jsonb_object_agg(x ->> 'setting_key', x -> 'value'), '{}'::jsonb)
    into v_flat
    from jsonb_array_elements(v_set) x;

  -- A bound setting always wins: it is the value the job actually reads.
  v_flat := coalesce(d.claude_settings, '{}'::jsonb) || v_flat;

  select to_jsonb(x) into v_last from (
    select started_at, finished_at, status, notes, stats
    from scheduled_job_runs where job_key = p_job_key
    order by started_at desc limit 1
  ) x;

  return jsonb_build_object(
    'job_key',      d.job_key,
    'title',        d.title,
    'purpose',      d.purpose,
    'armed',        (v_active and coalesce(v_gate, true)),
    'paused',       not v_active,
    'gate_enabled', v_gate,
    'schedule',     v_cron,
    'timezone',     'UTC',
    'runs_where',   d.source,
    'run_as',       d.run_as,
    'instructions', d.claude_instructions,
    'settings',     v_flat,
    'last_run',     v_last,
    'as_at',        now()
  );
end;
$$;

revoke all on function public.scheduled_job_brief(text) from public, anon;
grant execute on function public.scheduled_job_brief(text) to authenticated, service_role;

-- ── The write side for externally-run work ───────────────────────────────
create or replace function public.scheduled_job_report_run(
  p_job_key text,
  p_status  text,
  p_notes   text default null,
  p_stats   jsonb default null,
  p_started timestamptz default null
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare v_id bigint;
begin
  if not (public.can_manage_schedules() or auth.role() = 'service_role') then
    raise exception 'not authorised';
  end if;

  insert into scheduled_job_runs (job_key, started_at, finished_at, status, notes, stats, reported_by)
  values (
    p_job_key,
    coalesce(p_started, now()),
    case when p_status = 'running' then null else now() end,
    p_status, p_notes, p_stats,
    case when auth.uid() is null then 'automation' else 'staff:' || auth.uid()::text end
  )
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.scheduled_job_report_run(text, text, text, jsonb, timestamptz) from public, anon;
grant execute on function public.scheduled_job_report_run(text, text, text, jsonb, timestamptz) to authenticated, service_role;

-- ── Recent changes, for the page footer ─────────────────────────────────
create or replace function public.list_scheduled_job_changes(p_limit int default 20)
returns table (
  job_key text, title text, change_type text, setting_key text,
  old_value text, new_value text, changed_at timestamptz, changed_by_name text
)
language sql
stable
security definer
set search_path = public
as $$
  select c.job_key, coalesce(d.title, c.job_key), c.change_type, c.setting_key,
         c.old_value, c.new_value, c.changed_at, s.name
  from scheduled_job_changes c
  left join scheduled_job_docs d on d.job_key = c.job_key
  left join staff_profiles s on s.id = c.changed_by
  where public.can_manage_schedules()
  order by c.changed_at desc
  limit least(coalesce(p_limit, 20), 100);
$$;

revoke all on function public.list_scheduled_job_changes(int) from public, anon;
grant execute on function public.list_scheduled_job_changes(int) to authenticated;

-- ── list_scheduled_jobs(): now carries settings and instructions ─────────
drop function if exists public.list_scheduled_jobs();

create or replace function public.list_scheduled_jobs()
returns table (
  job_key           text,
  source            text,
  title             text,
  category          text,
  purpose           text,
  data_source       text,
  mechanism         text,
  run_as            text,
  gate_label        text,
  cron_expression   text,
  external_schedule text,
  cron_active       boolean,
  gate_enabled      boolean,
  command           text,
  sort_order        int,
  last_run_at       timestamptz,
  last_run_status   text,
  last_run_message  text,
  documented        boolean,
  settings          jsonb,
  instructions      text,
  claude_settings   jsonb
)
language plpgsql
stable
security definer
set search_path = public, cron, hmrc
as $$
begin
  if not public.can_manage_schedules() then
    raise exception 'not authorised';
  end if;

  return query
  select
    j.jobname::text,
    'pg_cron'::text,
    coalesce(d.title, j.jobname)::text,
    coalesce(d.category, 'Undocumented')::text,
    coalesce(d.purpose, '')::text,
    coalesce(d.data_source, '')::text,
    coalesce(d.mechanism, '')::text,
    d.run_as,
    d.gate_label,
    j.schedule::text,
    null::text,
    j.active,
    public.scheduled_job_gate(j.jobname),
    j.command::text,
    coalesce(d.sort_order, 900),
    r.ran_at,
    r.status::text,
    left(r.return_message, 300),
    (d.job_key is not null),
    public.scheduled_job_setting_values(j.jobname),
    d.claude_instructions,
    d.claude_settings
  from cron.job j
  left join public.scheduled_job_docs d
    on d.job_key = j.jobname and d.source = 'pg_cron'
  left join lateral (
    select coalesce(x.end_time, x.start_time) as ran_at, x.status, x.return_message
    from cron.job_run_details x
    where x.jobid = j.jobid
    order by x.runid desc
    limit 1
  ) r on true

  union all

  select
    d.job_key,
    d.source,
    d.title,
    d.category,
    d.purpose,
    d.data_source,
    d.mechanism,
    d.run_as,
    d.gate_label,
    d.external_cron,
    d.external_schedule,
    true,
    null::boolean,
    null::text,
    d.sort_order,
    -- A reported run wins; otherwise fall back to the scraper's own log.
    coalesce(
      er.finished_at, er.started_at,
      case d.job_key when 'hmrc-monthly-scrape' then (select max(started_at) from hmrc.run) end
    ),
    er.status,
    er.notes,
    true,
    public.scheduled_job_setting_values(d.job_key),
    d.claude_instructions,
    d.claude_settings
  from public.scheduled_job_docs d
  left join lateral (
    select y.started_at, y.finished_at, y.status, y.notes
    from public.scheduled_job_runs y
    where y.job_key = d.job_key
    order by y.started_at desc
    limit 1
  ) er on true
  where d.source = 'external';
end;
$$;

revoke all on function public.list_scheduled_jobs() from public, anon;
grant execute on function public.list_scheduled_jobs() to authenticated, service_role;

-- ── Seed the bindings ───────────────────────────────────────────────────
insert into public.scheduled_job_settings
  (job_key, setting_key, label, help, value_type, target_table, target_column,
   id_kind, touch_updated_at, min_value, max_value, risk, risk_note, sort_order)
values

('ch-refresh-nightly', 'refresh_enabled',
 'Refresh companies overnight',
 'Off means the nightly job still fires but reads nothing from Companies House, so entity records slowly go stale.',
 'boolean', 'ch_refresh_config', 'refresh_enabled', 'bool_true', false, null, null,
 'internal', null, 10),

('ch-refresh-report', 'report_enabled',
 'Email the morning report',
 'Errors-only summary of what the overnight refresh changed. Off means nobody hears about failures.',
 'boolean', 'ch_refresh_config', 'report_enabled', 'bool_true', false, null, null,
 'internal', null, 10),

('comms-ingest', 'comms_ingest_enabled',
 'Pull new mail from the mailboxes',
 'Off stops the client Communications tab filling and stops chases noticing replies.',
 'boolean', 'onboarding_chase_config', 'comms_ingest_enabled', 'bool_true', true, null, null,
 'internal', null, 10),

('chase-reply-scan', 'reply_scan_enabled',
 'Match replies to open chases',
 'Off means a client who has already replied can still be chased again.',
 'boolean', 'onboarding_chase_config', 'reply_scan_enabled', 'bool_true', true, null, null,
 'internal', null, 10),

('onboarding-checkin', 'checkin_auto_send_enabled',
 'Send check-in emails automatically',
 'Turning this on lets Athena email clients partway through onboarding without anyone pressing send.',
 'boolean', 'onboarding_chase_config', 'checkin_auto_send_enabled', 'bool_true', true, null, null,
 'client_facing', 'Clients receive email from this job.', 10),

('onboarding-weekly', 'weekly_enabled',
 'Send the Monday onboarding digest',
 'Internal only — goes to the named recipients, not the whole team.',
 'boolean', 'onboarding_chase_config', 'weekly_enabled', 'bool_true', true, null, null,
 'internal', null, 10),

('ch-code-weekly', 'weekly_enabled',
 'Send the Monday code digest',
 'Internal summary of outstanding Companies House authentication codes.',
 'boolean', 'ch_code_chase_config', 'weekly_enabled', 'bool_true', true, null, null,
 'internal', null, 10),

('ch-code-calls', 'calls_email_enabled',
 'Send the Wednesday call list',
 'Goes to the named call assignee only.',
 'boolean', 'ch_code_chase_config', 'calls_email_enabled', 'bool_true', true, null, null,
 'internal', null, 10),

('ch-code-queue-fill', 'auto_queue_enabled',
 'Queue code chases automatically',
 'Builds the queue. Nothing is sent from the queue unless the sending switch below is also on.',
 'boolean', 'ch_code_chase_config', 'auto_queue_enabled', 'bool_true', true, null, null,
 'internal', null, 10),

('ch-code-queue-fill', 'sending_enabled',
 'Actually send queued chases',
 'Read by the ch-code-queue-send function. This is the switch that puts email in front of clients — it has deliberately been left off.',
 'boolean', 'ch_code_chase_config', 'sending_enabled', 'bool_true', true, null, null,
 'client_facing', 'Clients receive chase email once this is on.', 20),

('ch-code-queue-fill', 'chase_every_days',
 'Days between chases',
 'How long to leave a client before the next chase in the sequence.',
 'int', 'ch_code_chase_config', 'chase_every_days', 'bool_true', true, 1, 90,
 'internal', null, 30),

('ch-code-queue-fill', 'max_chases',
 'Maximum chases per client',
 'After this many, the client stops being chased and is left for a call instead.',
 'int', 'ch_code_chase_config', 'max_chases', 'bool_true', true, 1, 10,
 'internal', null, 40),

('reminders-autoqueue', 'enabled',
 'Queue tax reminders in January and July',
 'The queue feeds the client reminder emails — opt-in first, then UTR and payment details.',
 'boolean', 'reminder_autoqueue_config', 'enabled', 'bool_true', false, null, null,
 'client_facing', 'Clients receive reminder email from this run.', 10),

('deadline-digest', 'weekly_enabled',
 'Send the Monday deadline digest',
 'The one automated all-team email Bobby wants kept.',
 'boolean', 'deadline_digest_config', 'weekly_enabled', 'bool_true', true, null, null,
 'internal', null, 10),

('deadline-digest', 'sending_enabled',
 'Actually deliver it',
 'Off computes the digest and skips delivery — useful for a dry run.',
 'boolean', 'deadline_digest_config', 'sending_enabled', 'bool_true', true, null, null,
 'internal', null, 20),

('notification-sweep', 'sweep_enabled',
 'Fill the in-app bell',
 'What each person has waiting for them. Cheap and silent — normally left on.',
 'boolean', 'notification_config', 'sweep_enabled', 'bool_true', true, null, null,
 'internal', null, 10),

('notification-sweep', 'digest_enabled',
 'Also email everyone their list',
 'Switched off Aug 2026 as part of quietening internal automation. Turning it on emails every active staff member each weekday.',
 'boolean', 'notification_config', 'digest_enabled', 'bool_true', true, null, null,
 'internal', 'Emails the whole team every weekday morning.', 20),

('bug-review-digest', 'enabled',
 'Run the Friday bug review',
 'In-app notifications to everyone who can triage bugs. Sends no email.',
 'boolean', 'bug_review_config', 'enabled', 'bool_true', false, null, null,
 'internal', null, 10),

('bk-drift-tick', 'nudges_armed',
 'Arm the drift nudges',
 'Cases are opened and escalated either way. This switch decides whether anyone gets nudged about them.',
 'boolean', 'bk_drift_settings', 'nudges_armed', 'int_one', false, null, null,
 'client_facing', 'Arming this starts nudging about late books. Who receives them depends on whether we or the client keep them.', 10),

('bk-drift-tick', 'first_nudge_days',
 'Days over tolerance before the first nudge',
 'Zero means nudge as soon as a client breaches tolerance.',
 'int', 'bk_drift_settings', 'first_nudge_days', 'int_one', false, 0, 90,
 'internal', null, 20),

('bk-drift-tick', 'reminder_after_days',
 'Days before a reminder',
 'How long a nudge is left unanswered before it is repeated.',
 'int', 'bk_drift_settings', 'reminder_after_days', 'int_one', false, 1, 90,
 'internal', null, 30),

('bk-drift-tick', 'escalate_after_days',
 'Days before escalation',
 'How long a case sits before it goes up to a manager.',
 'int', 'bk_drift_settings', 'escalate_after_days', 'int_one', false, 1, 180,
 'internal', null, 40)

on conflict (job_key, setting_key) do update set
  label            = excluded.label,
  help             = excluded.help,
  value_type       = excluded.value_type,
  target_table     = excluded.target_table,
  target_column    = excluded.target_column,
  id_kind          = excluded.id_kind,
  touch_updated_at = excluded.touch_updated_at,
  min_value        = excluded.min_value,
  max_value        = excluded.max_value,
  risk             = excluded.risk,
  risk_note        = excluded.risk_note,
  sort_order       = excluded.sort_order;

-- ── Seed the instructions the HMRC scrape reads ─────────────────────────
update public.scheduled_job_docs
   set claude_instructions =
'Before scraping, call scheduled_job_brief(''hmrc-monthly-scrape'') and stop if armed is false.

1. Ask Bobby to sign in to HMRC agent services. Never type his password or access code.
2. Walk the full client list for each service listed in settings, currently PAYE and Corporation Tax.
3. Write into the private hmrc schema as its own run — the tables append per run, they do not replace.
4. Drain Athena''s refresh queue (npm run refresh in ~/HMRC-Scraper) before finishing.
5. Report the outcome with scheduled_job_report_run(''hmrc-monthly-scrape'', ''ok''|''partial''|''failed'', notes, stats).'
 where job_key = 'hmrc-monthly-scrape'
   and claude_instructions is null;

update public.scheduled_job_docs
   set claude_settings = jsonb_build_object(
         'services', jsonb_build_array('paye', 'corporation-tax'),
         'drain_refresh_queue', true
       )
 where job_key = 'hmrc-monthly-scrape'
   and claude_settings = '{}'::jsonb;
