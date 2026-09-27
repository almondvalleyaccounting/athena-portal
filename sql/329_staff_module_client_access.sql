-- 329 — Access by staff member, by module, and (for client figures) by client.
--
-- Bobby, 2026-09-27: "Access by staff member, by module." Two exceptions:
--   1. Client financial figures are also switched on/off per staff member per
--      client — by hand, from the Staff & Permissions screen. Nothing derives it
--      (not the client's manager, not task assignments): "don't code this into
--      Athena". A switched-off client hides only its FIGURES; its name, tasks,
--      deadlines and comms stay visible so work keeps running.
--   2. In-development modules are hidden from everyone except portal admins and
--      the testers ticked for that module.
-- Portal admin sees every module and every client and cannot be limited.
--
-- Shape:
--   app_modules          every module / sub-module key the sidebar knows, with its
--                        status (live | in_development). Labels live in
--                        src/modules.config.js; the database only needs keys.
--   staff_module_access  one row = this person has this module. For an
--                        in-development module the row makes them a tester.
--                        Billing carries a level: submitter | approver.
--   staff_client_access  one explicit row per person per client. A missing row is
--                        OFF — fail closed. New clients and new staff get rows
--                        from the 'new_client_figures_default' setting (starts
--                        true: everyone on until switched off).
--
-- The legacy staff_profiles flags that 400-odd policies and a dozen edge
-- functions read (can_view_billing, can_view_reports, work_planner …) become
-- DERIVED from staff_module_access by trigger, so every existing check keeps
-- working and there is one source of truth. Ability flags inside a module
-- (can_edit_quotes, can_view_client_fees, can_view_practice_financials …) stay as
-- they are and are set directly.
--
-- Writes to all three tables go through the staff-access edge function
-- (service_role). authenticated gets SELECT only, scoped to its own rows.
--
-- Enforcement of the client switch: set-based helpers used by restrictive RLS
-- policies (tables), by a filter wrapped round each HMRC / Working Papers definer
-- view, and by a guard added to the definer RPCs that serve figures per client.
-- This replaces sql/296's "reports flag required" policies, which were module-
-- level only.

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------

create table if not exists public.app_modules (
  key         text primary key,
  parent_key  text references public.app_modules(key),
  -- grantable = switched on per person. Otherwise the key inherits its parent
  -- (Fee Engine's sub-pages) — unless it is in development, when it needs a row.
  grantable   boolean not null default false,
  status      text not null default 'live' check (status in ('live', 'in_development')),
  updated_at  timestamptz not null default now(),
  updated_by  uuid references public.staff_profiles(id)
);

create table if not exists public.staff_module_access (
  staff_id    uuid not null references public.staff_profiles(id) on delete cascade,
  module_key  text not null references public.app_modules(key) on update cascade on delete cascade,
  level       text not null default 'on' check (level in ('on', 'submitter', 'approver')),
  granted_at  timestamptz not null default now(),
  granted_by  uuid references public.staff_profiles(id),
  primary key (staff_id, module_key)
);

create table if not exists public.staff_client_access (
  staff_id    uuid not null references public.staff_profiles(id) on delete cascade,
  entity_id   uuid not null references public.entities(id) on delete cascade,
  enabled     boolean not null,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references public.staff_profiles(id),
  primary key (staff_id, entity_id)
);
create index if not exists staff_client_access_entity_idx on public.staff_client_access (entity_id);

insert into public.app_settings (setting_key, setting_value, description)
values ('new_client_figures_default', 'true'::jsonb,
        'When a new client (or a new staff member) arrives, are its figures on for every staff member until switched off? true = on, false = off until switched on.')
on conflict (setting_key) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Module registry, seeded from src/modules.config.js as of 2026-09-27
-- ---------------------------------------------------------------------------

insert into public.app_modules (key, parent_key, grantable, status) values
  ('fee-engine', null, true, 'live'),
  ('billing', null, true, 'live'),
  ('clients', null, true, 'live'),
  ('onboarding', null, true, 'live'),
  ('communications', null, true, 'live'),
  ('work-planner', null, true, 'live'),
  ('client-work', null, false, 'live'),        -- a heading; its children are the modules
  ('working-papers', null, true, 'in_development'),
  ('planning', null, true, 'in_development'),
  ('pd-tracker', null, true, 'live'),
  ('recruitment', null, true, 'in_development'),
  ('bugs', null, true, 'live'),
  ('ideas', null, true, 'live')
on conflict (key) do nothing;

insert into public.app_modules (key, parent_key, grantable, status) values
  ('fe-dashboard', 'fee-engine', false, 'live'),
  ('fe-new-quote', 'fee-engine', false, 'live'),
  ('fe-clients', 'fee-engine', false, 'live'),
  ('fe-quotes', 'fee-engine', false, 'live'),
  ('fe-groups', 'fee-engine', false, 'live'),
  ('fe-billing', 'fee-engine', false, 'in_development'),
  ('fe-pricing', 'fee-engine', false, 'live'),
  ('onboarding-list', 'onboarding', false, 'in_development'),
  ('onboarding-board', 'onboarding', false, 'in_development'),
  ('onboarding-crosscheck', 'onboarding', false, 'in_development'),
  ('onboarding-ch-codes', 'onboarding', false, 'live'),
  ('comms-email', 'communications', false, 'live'),
  ('comms-sms', 'communications', false, 'live'),
  ('comms-whatsapp', 'communications', false, 'live'),
  ('comms-reminders', 'communications', false, 'live'),
  ('comms-preferences', 'communications', false, 'live'),
  ('wp-task', 'work-planner', false, 'in_development'),
  ('wp-ready', 'work-planner', false, 'live'),
  ('wp-plan', 'work-planner', false, 'in_development'),
  ('wp-team', 'work-planner', false, 'in_development'),
  ('wp-bk-health', 'work-planner', false, 'in_development'),
  ('wp-capacity', 'work-planner', false, 'in_development'),
  ('wp-job-review', 'work-planner', false, 'in_development'),
  ('wp-timesheets', 'work-planner', false, 'in_development'),
  ('wp-triage', 'work-planner', false, 'in_development'),
  ('cw-dashboard', 'client-work', true, 'live'),
  ('cw-portfolio', 'client-work', true, 'live'),
  ('cw-reports', 'client-work', true, 'live'),
  ('cw-hmrc', 'client-work', true, 'in_development'),
  ('cw-forecast', 'client-work', true, 'live'),
  ('wp-paye', 'working-papers', false, 'live'),
  ('wp-mapping', 'working-papers', false, 'live'),
  ('wp-ct', 'working-papers', false, 'live'),
  ('wp-net-wages', 'working-papers', false, 'live'),
  ('rec-vacancies', 'recruitment', false, 'live'),
  ('rec-interviews', 'recruitment', false, 'live')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 3. Core predicates
--
-- current_user is useless inside a definer function (it reads as the owner), so
-- "who is calling" comes from request.jwt.claims, exactly as is_staff_or_service()
-- does in sql/230: no claims at all = pg_cron / psql; role service_role = an edge
-- function or cron via pg_net. Both see everything, as they do today.
-- ---------------------------------------------------------------------------

create or replace function public.access_is_machine()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select nullif(current_setting('request.jwt.claims', true), '') is null
      or coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') = 'service_role';
$$;

create or replace function public.staff_is_admin(p_staff uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from staff_profiles where id = p_staff and is_active and is_portal_admin);
$$;

-- Does this person have this module? The single rule the sidebar mirrors in
-- src/modules.config.js (moduleGranted). Admins: always. Otherwise the parent must
-- be granted, and a grantable or in-development key needs its own row.
create or replace function public.module_granted(p_staff uuid, p_key text)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  m app_modules%rowtype;
begin
  if p_staff is null then return false; end if;
  if staff_is_admin(p_staff) then return true; end if;
  if not exists (select 1 from staff_profiles where id = p_staff and is_active) then return false; end if;
  select * into m from app_modules where key = p_key;
  if not found then return false; end if;
  if m.parent_key is not null and not module_granted(p_staff, m.parent_key) then return false; end if;
  if m.grantable or m.status = 'in_development' then
    return exists (select 1 from staff_module_access where staff_id = p_staff and module_key = p_key);
  end if;
  return true;
end;
$$;

create or replace function public.staff_has_figure_module(p_staff uuid, p_modules text[])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from unnest(p_modules) k where module_granted(p_staff, k));
$$;

-- The caller-facing helpers the policies and views use.

create or replace function public.has_all_figures()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select access_is_machine() or staff_is_admin(auth.uid());
$$;

create or replace function public.has_figure_module(p_modules text[])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select access_is_machine() or staff_has_figure_module(auth.uid(), p_modules);
$$;

-- Clients whose figures the caller may see through any of these modules.
-- Admins / machines are short-circuited in the policies by has_all_figures(), so
-- this only ever enumerates one person's switched-on clients.
create or replace function public.my_figure_entities(p_modules text[])
returns setof uuid
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if has_all_figures() then
    return query select e.id from entities e;
  elsif staff_has_figure_module(auth.uid(), p_modules) then
    return query select a.entity_id from staff_client_access a
                  where a.staff_id = auth.uid() and a.enabled;
  end if;
end;
$$;

-- The same, as QuickBooks realms. A realm linked to no client has no switch to
-- respect, so it follows the module alone; the practice-books rule (sql/113) is a
-- separate policy and still applies on top.
create or replace function public.my_figure_realms(p_modules text[])
returns setof text
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if has_all_figures() then
    return query select c.realm_id from qbo_report_connections c;
  elsif staff_has_figure_module(auth.uid(), p_modules) then
    return query
      select c.realm_id from qbo_report_connections c
        join staff_client_access a on a.entity_id = c.entity_id
       where a.staff_id = auth.uid() and a.enabled
      union
      select c.realm_id from qbo_report_connections c where c.entity_id is null;
  end if;
end;
$$;

-- Row-at-a-time forms, for RPC guards.
create or replace function public.figures_visible(p_modules text[], p_entity uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select has_all_figures()
      or (staff_has_figure_module(auth.uid(), p_modules)
          and (p_entity is null
               or exists (select 1 from staff_client_access
                           where staff_id = auth.uid() and entity_id = p_entity and enabled)));
$$;

create or replace function public.figures_visible_paye(p_modules text[], p_paye_ref text)
returns boolean
language sql
stable
security definer
set search_path = public, hmrc
as $$
  select has_all_figures()
      or (staff_has_figure_module(auth.uid(), p_modules)
          and not exists (
            select 1 from hmrc.client c
             where c.paye_ref = p_paye_ref and c.entity_id is not null
               and not exists (select 1 from staff_client_access a
                                where a.staff_id = auth.uid() and a.entity_id = c.entity_id and a.enabled)));
$$;

-- For edge functions, which run as service_role and must name the staff member.
-- Also carries the practice-books rule (sql/113) for a realm, so a function
-- that checks this needs nothing else: the practice's own QuickBooks needs
-- can_view_practice_financials, admin or not, exactly as the RLS policy does.
create or replace function public.staff_figures_visible(p_staff uuid, p_modules text[], p_entity uuid default null, p_realm text default null)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select (p_realm is null
          or not exists (select 1 from qbo_report_connections c where c.realm_id = p_realm and c.is_practice)
          or exists (select 1 from staff_profiles s
                      where s.id = p_staff and s.is_active and s.can_view_practice_financials))
     and (staff_is_admin(p_staff)
      or (staff_has_figure_module(p_staff, p_modules)
          and case
                when p_entity is not null then
                  exists (select 1 from staff_client_access
                           where staff_id = p_staff and entity_id = p_entity and enabled)
                when p_realm is not null then
                  not exists (
                    select 1 from qbo_report_connections c
                     where c.realm_id = p_realm and c.entity_id is not null
                       and not exists (select 1 from staff_client_access a
                                        where a.staff_id = p_staff and a.entity_id = c.entity_id and a.enabled))
                else true
              end));
$$;

-- ---------------------------------------------------------------------------
-- 4. Legacy flags become derived from module access
-- ---------------------------------------------------------------------------

create or replace function public.staff_access_sync_flags(p_staff uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update staff_profiles sp set
    can_view_quotes      = module_granted(sp.id, 'fee-engine'),
    can_view_billing     = module_granted(sp.id, 'billing'),
    can_approve_billing  = sp.is_portal_admin
                           or (module_granted(sp.id, 'billing')
                               and exists (select 1 from staff_module_access
                                            where staff_id = sp.id and module_key = 'billing' and level = 'approver')),
    can_view_onboarding  = module_granted(sp.id, 'onboarding'),
    work_planner         = module_granted(sp.id, 'work-planner'),
    can_view_reports     = module_granted(sp.id, 'cw-dashboard') or module_granted(sp.id, 'cw-portfolio')
                           or module_granted(sp.id, 'cw-reports') or module_granted(sp.id, 'working-papers'),
    can_view_pd_tracker  = module_granted(sp.id, 'pd-tracker'),
    can_view_recruitment = module_granted(sp.id, 'recruitment'),
    can_view_timesheets  = module_granted(sp.id, 'wp-timesheets'),
    can_view_job_review  = module_granted(sp.id, 'wp-job-review')
  where sp.id = p_staff;
end;
$$;

create or replace function public.trg_staff_module_access_sync()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform staff_access_sync_flags(coalesce(new.staff_id, old.staff_id));
  if tg_op = 'UPDATE' and new.staff_id is distinct from old.staff_id then
    perform staff_access_sync_flags(old.staff_id);
  end if;
  return null;
end;
$$;

drop trigger if exists trg_staff_module_access_sync on public.staff_module_access;
create trigger trg_staff_module_access_sync
  after insert or update or delete on public.staff_module_access
  for each row execute function public.trg_staff_module_access_sync();

create or replace function public.trg_staff_profiles_access_sync()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform staff_access_sync_flags(new.id);
  return null;
end;
$$;

drop trigger if exists trg_staff_profiles_access_sync on public.staff_profiles;
create trigger trg_staff_profiles_access_sync
  after update of is_portal_admin, is_active on public.staff_profiles
  for each row execute function public.trg_staff_profiles_access_sync();

create or replace function public.trg_app_modules_access_sync()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare s uuid;
begin
  for s in select id from staff_profiles loop
    perform staff_access_sync_flags(s);
  end loop;
  return null;
end;
$$;

drop trigger if exists trg_app_modules_access_sync on public.app_modules;
create trigger trg_app_modules_access_sync
  after update of status, parent_key, grantable on public.app_modules
  for each statement execute function public.trg_app_modules_access_sync();

-- New clients and new staff get explicit rows from the setting, so nothing is
-- ever decided by a missing row except "off". Covers every write path, the BM
-- importer included.
create or replace function public.new_client_figures_default()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select (setting_value #>> '{}')::boolean from app_settings
                    where setting_key = 'new_client_figures_default'), true);
$$;

create or replace function public.trg_entities_seed_client_access()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into staff_client_access (staff_id, entity_id, enabled)
  select sp.id, new.id, new_client_figures_default()
    from staff_profiles sp
   where sp.is_active
  on conflict do nothing;
  return null;
end;
$$;

drop trigger if exists trg_entities_seed_client_access on public.entities;
create trigger trg_entities_seed_client_access
  after insert on public.entities
  for each row execute function public.trg_entities_seed_client_access();

-- A new starter also gets the modules everyone had before sql/329 (the ones
-- with no flag): Clients, Communications, Bug Reports, Ideas. Everything else is
-- switched on from Staff & Permissions.
create or replace function public.trg_staff_seed_client_access()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into staff_client_access (staff_id, entity_id, enabled)
  select new.id, e.id, new_client_figures_default()
    from entities e
  on conflict do nothing;
  insert into staff_module_access (staff_id, module_key, level)
  select new.id, k, 'on' from unnest(array['clients', 'communications', 'bugs', 'ideas']) k
  on conflict do nothing;
  return null;
end;
$$;

drop trigger if exists trg_staff_seed_client_access on public.staff_profiles;
create trigger trg_staff_seed_client_access
  after insert on public.staff_profiles
  for each row execute function public.trg_staff_seed_client_access();

-- ---------------------------------------------------------------------------
-- 5. Seed: nobody's access changes on day one except that in-development
--    modules disappear for anyone who isn't an admin. No testers are seeded;
--    Bobby ticks them.
-- ---------------------------------------------------------------------------

insert into public.staff_module_access (staff_id, module_key, level)
select sp.id, x.key, x.level
  from public.staff_profiles sp
  cross join lateral (values
    ('fee-engine',     sp.can_view_quotes,     'on'),
    ('billing',        sp.can_view_billing,    case when sp.can_approve_billing then 'approver' else 'submitter' end),
    ('clients',        true,                   'on'),
    ('onboarding',     sp.can_view_onboarding, 'on'),
    ('communications', true,                   'on'),
    ('work-planner',   sp.work_planner,        'on'),
    ('cw-dashboard',   sp.can_view_reports,    'on'),
    ('cw-portfolio',   sp.can_view_reports,    'on'),
    ('cw-reports',     sp.can_view_reports,    'on'),
    ('pd-tracker',     sp.can_view_pd_tracker, 'on'),
    ('bugs',           true,                   'on'),
    ('ideas',          true,                   'on')
  ) as x(key, has, level)
 where sp.is_active and x.has
on conflict do nothing;

insert into public.staff_client_access (staff_id, entity_id, enabled)
select sp.id, e.id, true
  from public.staff_profiles sp
 cross join public.entities e
 where sp.is_active
on conflict do nothing;

-- The inserts above fired the per-row sync; run it once more for everyone so
-- staff with no rows at all (and admins) are consistent too.
do $$
declare s uuid;
begin
  for s in select id from public.staff_profiles loop
    perform public.staff_access_sync_flags(s);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 6. RLS on the new tables. Reads only; writes are the edge function's.
-- ---------------------------------------------------------------------------

alter table public.app_modules enable row level security;
alter table public.staff_module_access enable row level security;
alter table public.staff_client_access enable row level security;

drop policy if exists "staff read modules" on public.app_modules;
create policy "staff read modules" on public.app_modules
  for select to authenticated using (is_active_staff());

drop policy if exists "own or admin" on public.staff_module_access;
create policy "own or admin" on public.staff_module_access
  for select to authenticated using (staff_id = auth.uid() or is_portal_admin());

drop policy if exists "own or admin" on public.staff_client_access;
create policy "own or admin" on public.staff_client_access
  for select to authenticated using (staff_id = auth.uid() or is_portal_admin());

revoke all on public.app_modules, public.staff_module_access, public.staff_client_access from public, anon, authenticated;
grant select on public.app_modules, public.staff_module_access, public.staff_client_access to authenticated;
grant all on public.app_modules, public.staff_module_access, public.staff_client_access to service_role;

-- ---------------------------------------------------------------------------
-- 7. Function grants. A new function is EXECUTE-able by anon through the schema
--    default privilege, and revoking from PUBLIC misses that grant — so name anon.
-- ---------------------------------------------------------------------------

do $$
declare f text;
begin
  -- Called from policies, views and RPCs as the signed-in user.
  foreach f in array array[
    'public.access_is_machine()',
    'public.has_all_figures()',
    'public.has_figure_module(text[])',
    'public.my_figure_entities(text[])',
    'public.my_figure_realms(text[])',
    'public.figures_visible(text[], uuid)',
    'public.figures_visible_paye(text[], text)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;

  -- Take a staff id as an argument, so only the server may ask about someone else.
  foreach f in array array[
    'public.staff_is_admin(uuid)',
    'public.module_granted(uuid, text)',
    'public.staff_has_figure_module(uuid, text[])',
    'public.staff_figures_visible(uuid, text[], uuid, text)',
    'public.staff_access_sync_flags(uuid)',
    'public.new_client_figures_default()',
    'public.trg_staff_module_access_sync()',
    'public.trg_staff_profiles_access_sync()',
    'public.trg_app_modules_access_sync()',
    'public.trg_entities_seed_client_access()',
    'public.trg_staff_seed_client_access()'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 8. Tables that hold client figures: restrictive policy, per client.
--    Replaces sql/296's module-level "reports flag required".
--    (select …) around each helper makes it an initplan — evaluated once per
--    query, not once per row.
-- ---------------------------------------------------------------------------

do $$
declare
  r record;
  pred text;
begin
  for r in
    select * from (values
      -- table,                      key column, kind,     modules
      ('qbo_dashboard_cache',        'realm_id',  'realm',  array['cw-dashboard','cw-portfolio','cw-reports','cw-forecast']),
      ('dashboard_adjustment_accounts','realm_id','realm',  array['cw-dashboard','cw-portfolio']),
      ('dashboard_oneoff_items',     'realm_id',  'realm',  array['cw-dashboard','cw-portfolio']),
      ('dashboard_projection_map',   'realm_id',  'realm',  array['cw-dashboard','cw-portfolio']),
      ('dashboard_projections',      'realm_id',  'realm',  array['cw-dashboard','cw-portfolio']),
      ('report_runs',                'realm_id',  'realm',  array['cw-reports']),
      ('wp_qbo_account',             'realm_id',  'realm',  array['working-papers']),
      ('wp_qbo_balance',             'realm_id',  'realm',  array['working-papers']),
      ('dashboard_report',           'entity_id', 'entity', array['cw-dashboard','cw-reports']),
      ('kpi_value',                  'entity_id', 'entity', array['cw-dashboard','cw-portfolio']),
      ('kpi_client_override',        'entity_id', 'entity', array['cw-dashboard','cw-portfolio']),
      ('kpi_dimension_value',        'entity_id', 'entity', array['cw-dashboard','cw-portfolio']),
      ('kpi_definition',             'entity_id', 'entity', array['cw-dashboard','cw-portfolio']),
      ('wp_brightpay_period',        'entity_id', 'entity', array['working-papers']),
      ('wp_nominal_map',             'entity_id', 'entity', array['working-papers']),
      ('wp_signoff',                 'entity_id', 'entity', array['working-papers']),
      ('bk_drift_snapshots',         'entity_id', 'entity', array['clients','work-planner','wp-bk-health']),
      ('live_billing',               'entity_id', 'entity', array['clients','fee-engine','billing']),
      ('quotes',                     'entity_id', 'entity', array['clients','fee-engine','billing']),
      ('quote_line_items',           'quote_entity_id', 'entity', array['clients','fee-engine','billing']),
      ('client_service_allocations', 'entity_id', 'entity', array['clients','fee-engine','billing']),
      ('billing_items',              'entity_id', 'entity', array['clients','fee-engine','billing']),
      ('fee_proposals',              'entity_id', 'entity', array['clients','fee-engine','billing']),
      -- Not client-keyed: module only.
      ('qbo_report_connections',     null, 'module', array['cw-dashboard','cw-portfolio','cw-reports','cw-forecast','working-papers','wp-bk-health']),
      ('kpi_dimension',              null, 'module', array['cw-dashboard','cw-portfolio']),
      ('kpi_sector',                 null, 'module', array['cw-dashboard','cw-portfolio'])
    ) v(tbl, col, kind, mods)
  loop
    if r.kind = 'realm' then
      pred := format('(select public.has_all_figures()) or %I in (select public.my_figure_realms(%L::text[]))',
                     r.col, r.mods);
    elsif r.kind = 'entity' then
      pred := format('(select public.has_all_figures()) or (%1$I is null and (select public.has_figure_module(%2$L::text[]))) or %1$I in (select public.my_figure_entities(%2$L::text[]))',
                     r.col, r.mods);
    else
      pred := format('(select public.has_figure_module(%L::text[]))', r.mods);
    end if;

    execute format('drop policy if exists %I on public.%I', 'reports flag required', r.tbl);
    execute format('drop policy if exists %I on public.%I', 'client figures scoped', r.tbl);
    execute format(
      'create policy %I on public.%I as restrictive for all to authenticated using (%s) with check (%s)',
      'client figures scoped', r.tbl, pred, pred);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 9. Definer views over the hmrc schema and Working Papers. RLS never reaches a
--    definer view, so each gets the client filter wrapped round its existing
--    definition: select s.* from (<old>) s where <filter>. Same columns, so
--    create or replace keeps grants and dependants; the old gate
--    (hmrc_can_read()) stays inside.
-- ---------------------------------------------------------------------------

do $$
declare
  v record;
  d text;
  mods constant text := quote_literal(array['cw-hmrc','working-papers']::text) || '::text[]';
  pred text;
begin
  for v in
    select c.oid, c.relname,
           exists (select 1 from pg_attribute a
                    where a.attrelid = c.oid and a.attname = 'entity_id' and not a.attisdropped) as has_entity
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'v'
       and (c.relname like 'v\_hmrc\_%' or c.relname like 'v\_wp\_%')
       and not coalesce('security_invoker=true' = any(c.reloptions), false)
     order by c.relname
  loop
    d := pg_get_viewdef(v.oid);
    continue when position('has_figure_module' in d) > 0;  -- already wrapped
    d := rtrim(rtrim(d), ';');
    if v.has_entity then
      pred := format('(select public.has_all_figures()) or (s.entity_id is null and (select public.has_figure_module(%1$s))) or s.entity_id in (select public.my_figure_entities(%1$s))', mods);
    else
      pred := format('(select public.has_figure_module(%s))', mods);
    end if;
    execute format('create or replace view public.%I as select s.* from (%s) s where %s', v.relname, d, pred);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 10. Definer RPCs that serve one client's figures. Patched in place from the
--     live definition (as sql/296 did), so nothing else in them changes and their
--     grants are kept. Each patch asserts it landed.
-- ---------------------------------------------------------------------------

do $$
declare
  r record;
  d text;
begin
  for r in
    select * from (values
      ('public.dashboard_reports_for_entity(uuid)',
       'where is_active_staff()',
       'where is_active_staff() and public.figures_visible(array[''cw-dashboard'',''cw-reports''], p_entity_id)'),
      ('public.dashboard_scenarios_for_entity(uuid)',
       'where is_active_staff()',
       'where is_active_staff() and public.figures_visible(array[''cw-dashboard'',''cw-forecast''], f.client_entity_id)'),
      ('public.kpi_definitions_for_entity(uuid)',
       'where is_staff_or_service()',
       'where is_staff_or_service() and public.has_figure_module(array[''cw-dashboard'',''cw-portfolio''])'),
      ('public.kpi_set_value(uuid, uuid, date, uuid, numeric, text)',
       'if not is_active_staff() then',
       'if not is_active_staff() or not public.figures_visible(array[''cw-dashboard''], p_entity_id) then'),
      ('public.hmrc_paye_balance_at(text, date)',
       'where public.hmrc_can_read();',
       'where public.hmrc_can_read() and public.figures_visible_paye(array[''cw-hmrc'',''working-papers''], p_paye_ref);')
    ) v(fn, find, repl)
  loop
    d := pg_get_functiondef(r.fn::regprocedure);
    continue when position('figures_visible' in d) > 0 or position('has_figure_module' in d) > 0;
    if position(r.find in d) = 0 then
      raise exception '% gate "%" not found — definition changed, update 329', r.fn, r.find;
    end if;
    d := replace(d, r.find, r.repl);
    execute d;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 11. Audit exemptions for the caller-facing predicates.
--
-- The posture audit flags them as definer functions callable by authenticated
-- with no permission check. They are the check: each answers only about the
-- caller (auth.uid() / the request's own JWT role) and discloses nothing about
-- anyone else. Verified by impersonation before recording (2026-09-27):
--   portal client JWT  -> has_figure_module / has_all_figures / figures_visible false,
--                         my_figure_entities / my_figure_realms empty
--   anon               -> no EXECUTE (revoked above)
--   staff              -> their own switched-on clients only
-- Hash-bound: editing any of them re-flags it.
-- ---------------------------------------------------------------------------

insert into public.security_audit_exemptions (signature, definition_md5, reason)
select p.oid::regprocedure::text,
       md5(pg_get_functiondef(p.oid)),
       'Self-scoped access predicate (sql/329): answers only for the caller''s own auth.uid()/JWT role — a portal client gets false/empty, anon holds no EXECUTE. It is the gate the client-figures policies call, not a data reader.'
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('access_is_machine', 'has_all_figures', 'has_figure_module',
                     'my_figure_entities', 'my_figure_realms', 'figures_visible', 'figures_visible_paye')
on conflict (signature) do update
  set definition_md5 = excluded.definition_md5,
      reason         = excluded.reason,
      added_at       = now();

-- ---------------------------------------------------------------------------
-- 12. Per-person client counts for the Staff & Permissions screen. Aggregated in
--     SQL: staff × clients is ~8,000 rows, past PostgREST's silent 1,000-row cap.
--     security_invoker, so staff_client_access's own policy decides the rows
--     (yourself, or everyone for an admin).
-- ---------------------------------------------------------------------------

create or replace view public.v_staff_client_access_counts with (security_invoker = true) as
select a.staff_id,
       count(*) filter (where a.enabled) as clients_on,
       count(*)                          as clients_total
  from public.staff_client_access a
  join public.entities e on e.id = a.entity_id
 where e.entity_status in ('active', 'prospect')
 group by a.staff_id;

revoke all on public.v_staff_client_access_counts from public, anon;
grant select on public.v_staff_client_access_counts to authenticated, service_role;
