-- 246 — Custom reports, and the write path for KPI entry
--
-- Reports turn out to be thinner than they sound once KPIs exist. A report is a
-- named selection of rows — financial categories and KPIs together — at a grain
-- and a basis, with an optional chart. A saved view. The heavy lifting is
-- already done by the bucketing and the KPI engine; this only remembers what
-- somebody chose.
--
-- Scope, in the same shape as KPI definitions so there is one idea to learn:
-- a report belongs to a SECTOR (offered to every client in it), or to ONE
-- CLIENT, or to NEITHER (a practice-wide template available everywhere).
--
-- The write path for figures is an RPC rather than a direct table write, for
-- one reason: typing over an automated figure has to be recorded as an
-- override, or the next BrightPay import silently undoes the correction and
-- nobody finds out until a client asks why the number moved back.

begin;

-- ── Saved reports ───────────────────────────────────────────────
create table if not exists dashboard_report (
  id          uuid primary key default gen_random_uuid(),
  entity_id   uuid references entities(id) on delete cascade,
  sector_id   uuid references kpi_sector(id) on delete cascade,
  name        text not null,
  description text,
  grain       text not null default 'month' check (grain in ('month', 'quarter', 'year')),
  basis       text not null default 'fiscal' check (basis in ('fiscal', 'calendar')),
  view        text not null default 'reported' check (view in ('reported', 'underlying')),
  periods     smallint not null default 12 check (periods between 2 and 60),
  -- [{ source: 'financial' | 'kpi', key, label? }] in display order. Kept as
  -- jsonb rather than rows because it is a list somebody drags around, read
  -- whole and written whole; a child table would buy nothing.
  rows        jsonb not null default '[]'::jsonb,
  chart       text not null default 'none' check (chart in ('none', 'bars_line', 'line')),
  created_by  uuid references staff_profiles(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- Entity-scoped, sector-scoped, or practice-wide. Never both scopes at once.
  constraint dashboard_report_scope check (num_nonnulls(entity_id, sector_id) <= 1)
);
comment on table dashboard_report is
  'A saved arrangement of dashboard rows — financial categories and KPIs together — at a grain and basis. Scoped to one client, to a sector, or practice-wide.';
comment on column dashboard_report.rows is
  'Ordered [{source, key, label}]. source is ''financial'' for a dashboard category or ''kpi'' for a KPI key.';

create index if not exists idx_dashboard_report_entity on dashboard_report(entity_id);
create index if not exists idx_dashboard_report_sector on dashboard_report(sector_id);

alter table dashboard_report enable row level security;

-- Client-scoped reports: any active staff. Sector and practice-wide ones reach
-- every client at once, so they follow the pack flag.
drop policy if exists dashboard_report_read on dashboard_report;
create policy dashboard_report_read on dashboard_report
  for select using (is_active_staff());
drop policy if exists dashboard_report_write on dashboard_report;
create policy dashboard_report_write on dashboard_report
  for all
  using (case when entity_id is not null then is_active_staff() else can_manage_kpi_packs() end)
  with check (case when entity_id is not null then is_active_staff() else can_manage_kpi_packs() end);

-- Reports a given client can offer: its own, its sector's, and the global ones.
create or replace function dashboard_reports_for_entity(p_entity_id uuid)
returns setof dashboard_report
language sql
stable
security definer
set search_path = public
as $$
  select r.* from dashboard_report r
  where is_active_staff()
    and (
      r.entity_id = p_entity_id
      or r.sector_id = (select e.kpi_sector_id from entities e where e.id = p_entity_id)
      or (r.entity_id is null and r.sector_id is null)
    )
  order by r.name;
$$;
revoke execute on function dashboard_reports_for_entity(uuid) from public, anon;
grant execute on function dashboard_reports_for_entity(uuid) to authenticated, service_role;

-- ── Writing a KPI figure ────────────────────────────────────────
/*
  One figure. Blank clears it rather than storing null, so "no value" has a
  single representation and the outstanding list cannot be fooled by a row that
  exists but says nothing.

  If the existing row came from an automated source and a person is now typing a
  different number, the row is flagged is_override. An importer must respect
  that flag or it will quietly undo somebody's correction — which is the failure
  mode that makes people stop trusting a number they cannot see the provenance
  of.
*/
create or replace function kpi_set_value(
  p_entity_id          uuid,
  p_definition_id      uuid,
  p_period             date,
  p_dimension_value_id uuid,
  p_value              numeric,
  p_note               text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_period date := date_trunc('month', p_period)::date;
  v_kind text;
  v_existing kpi_value%rowtype;
begin
  if not is_active_staff() then
    raise exception 'Not authorised' using errcode = '42501';
  end if;

  select kind into v_kind from kpi_definition where id = p_definition_id;
  if v_kind is null then
    raise exception 'Unknown KPI';
  end if;
  -- Calculated KPIs are derived at read time. Storing one would let a stored
  -- figure disagree with the chart beside it the moment an input changed.
  if v_kind = 'calculated' then
    raise exception 'This KPI is calculated — its value comes from its formula, not from entry';
  end if;

  if p_value is null then
    delete from kpi_value
    where entity_id = p_entity_id and definition_id = p_definition_id
      and period = v_period
      and dimension_value_id is not distinct from p_dimension_value_id;
    return;
  end if;

  select * into v_existing from kpi_value
  where entity_id = p_entity_id and definition_id = p_definition_id
    and period = v_period
    and dimension_value_id is not distinct from p_dimension_value_id;

  if found then
    update kpi_value set
      value       = p_value,
      note        = coalesce(p_note, note),
      source      = 'manual',
      is_override = (v_existing.source <> 'manual' and v_existing.value is distinct from p_value)
                    or v_existing.is_override,
      entered_by  = auth.uid(),
      entered_at  = now()
    where id = v_existing.id;
  else
    insert into kpi_value (entity_id, definition_id, period, dimension_value_id,
                           value, note, source, entered_by)
    values (p_entity_id, p_definition_id, v_period, p_dimension_value_id,
            p_value, p_note, 'manual', auth.uid());
  end if;
end;
$$;
revoke execute on function kpi_set_value(uuid, uuid, date, uuid, numeric, text) from public, anon;
grant execute on function kpi_set_value(uuid, uuid, date, uuid, numeric, text) to authenticated, service_role;

-- ── Allocating a client to a sector ─────────────────────────────
-- An RPC rather than an update on `entities`, so this does not depend on
-- whatever the entities policies happen to allow today.
create or replace function set_entity_kpi_sector(p_entity_id uuid, p_sector_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_active_staff() then
    raise exception 'Not authorised' using errcode = '42501';
  end if;
  update entities set kpi_sector_id = p_sector_id where id = p_entity_id;
end;
$$;
revoke execute on function set_entity_kpi_sector(uuid, uuid) from public, anon;
grant execute on function set_entity_kpi_sector(uuid, uuid) to authenticated, service_role;

-- Sector list plus how many clients sit in each, for the pack editor.
create or replace function kpi_sectors_with_counts()
returns table (id uuid, key text, label text, description text, is_active boolean,
               sort_order int, client_count bigint, definition_count bigint)
language sql
stable
security definer
set search_path = public
as $$
  select s.id, s.key, s.label, s.description, s.is_active, s.sort_order,
         (select count(*) from entities e where e.kpi_sector_id = s.id),
         (select count(*) from kpi_definition d where d.sector_id = s.id and d.is_active)
  from kpi_sector s
  where is_active_staff()
  order by s.sort_order, s.label;
$$;
revoke execute on function kpi_sectors_with_counts() from public, anon;
grant execute on function kpi_sectors_with_counts() to authenticated, service_role;

commit;
