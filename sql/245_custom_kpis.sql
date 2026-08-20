-- 245 — Custom KPIs: sector packs, dimensions, entry values
--
-- The Client Dashboard reports what QuickBooks knows. A nursery's owner does not
-- run their business on turnover alone — they run it on occupancy, and occupancy
-- is children ÷ places, neither of which is in the ledger. This is the machinery
-- for the numbers that are not in QuickBooks: some typed in, some pulled from
-- another system later (BrightPay headcount), some calculated from the others.
--
-- ── Sector packs ────────────────────────────────────────────────
-- Definitions belong to a SECTOR, not to a client. "Childcare" carries children,
-- places and occupancy once; every client allocated to that sector gets them.
-- Otherwise the same four KPIs get hand-built twenty times and drift apart, and
-- fixing a formula means twenty edits.
--
-- A client's effective KPI list is therefore:
--     its sector's definitions
--   + any bespoke definitions of its own
--   − anything hidden by a per-client override
--
-- Sparse overrides, so a pack fix reaches every client that has not deliberately
-- diverged. See kpi_definitions_for_entity().
--
-- ── Dimensions ──────────────────────────────────────────────────
-- The DIMENSION is a property of the pack ("childcare KPIs break down by Room");
-- the VALUES are the client's own (Puddleduck's rooms are not another nursery's).
-- That split is why kpi_dimension_value carries entity_id and kpi_dimension
-- does not have to.
--
-- ── Two rules that decide whether the numbers are right ─────────
--
-- 1. AGGREGATION IS PER-KPI. A quarter's headcount is not three months of
--    headcount added together; nor is "maximum places". Every entry KPI declares
--    sum / average / last / max / min, and the reader obeys it. Getting this
--    wrong makes every non-monthly view quietly wrong — the same trap as
--    treating a balance-sheet stock as a flow.
--
-- 2. CALCULATED KPIS ARE RECOMPUTED AFTER THEIR INPUTS AGGREGATE, NEVER
--    AGGREGATED THEMSELVES. A quarter's occupancy is total children ÷ total
--    places. It is NOT the average of three monthly percentages unless all three
--    denominators happen to match. This is uniformly correct for additive
--    formulas too, so calculated KPIs carry no aggregation of their own — the
--    reader always re-evaluates. Same rule one level up: total occupancy across
--    rooms is total children ÷ total places, not the mean of the room figures.
--
-- Consequently calculated KPIs have NO rows in kpi_value. They are derived at
-- read time; storing them would let a stored figure disagree with the chart
-- beside it the moment an input changed.
--
-- Formulas are evaluated by src/modules/forecast/lib/expr.js — the forecast
-- engine's parser, reused rather than reinvented. Its own documented example is
-- `children_attending[babies] / 3`, which is exactly this shape: a key, a
-- dimension subscript, arithmetic. One formula language in Athena, not two.

begin;

-- ── Sectors ─────────────────────────────────────────────────────
create table if not exists kpi_sector (
  id          uuid primary key default gen_random_uuid(),
  key         text not null unique,
  label       text not null,
  description text,
  is_active   boolean not null default true,
  sort_order  int not null default 0,
  created_by  uuid references staff_profiles(id),
  created_at  timestamptz not null default now()
);
comment on table kpi_sector is
  'A business sector with its own KPI pack (Childcare, Construction…). Definitions hang off the sector so one edit reaches every client in it.';

alter table entities
  add column if not exists kpi_sector_id uuid references kpi_sector(id) on delete set null;
comment on column entities.kpi_sector_id is
  'Which KPI pack this client gets. entities.type is legal form (limited company / sole trader), which is a different question.';
create index if not exists idx_entities_kpi_sector on entities(kpi_sector_id);

-- ── Dimensions ──────────────────────────────────────────────────
create table if not exists kpi_dimension (
  id         uuid primary key default gen_random_uuid(),
  sector_id  uuid references kpi_sector(id) on delete cascade,
  entity_id  uuid references entities(id) on delete cascade,
  key        text not null,
  label      text not null,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  -- Pack-level or bespoke to one client, never both and never neither.
  constraint kpi_dimension_owner check (num_nonnulls(sector_id, entity_id) = 1)
);
comment on table kpi_dimension is
  'A breakdown a KPI can be split by — "Room". Belongs to a sector pack, or to one client for a bespoke KPI.';
create unique index if not exists idx_kpi_dimension_sector_key
  on kpi_dimension(sector_id, key) where sector_id is not null;
create unique index if not exists idx_kpi_dimension_entity_key
  on kpi_dimension(entity_id, key) where entity_id is not null;

create table if not exists kpi_dimension_value (
  id           uuid primary key default gen_random_uuid(),
  dimension_id uuid not null references kpi_dimension(id) on delete cascade,
  entity_id    uuid not null references entities(id) on delete cascade,
  key          text not null,
  label        text not null,
  sort_order   int not null default 0,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  unique (dimension_id, entity_id, key)
);
comment on table kpi_dimension_value is
  'The client''s own values for a dimension — Puddleduck''s actual rooms. Always per client, even when the dimension is pack-level: the pack says KPIs split by Room, each client says which rooms.';
create index if not exists idx_kpi_dimension_value_entity on kpi_dimension_value(entity_id);

-- ── Definitions ─────────────────────────────────────────────────
create table if not exists kpi_definition (
  id               uuid primary key default gen_random_uuid(),
  sector_id        uuid references kpi_sector(id) on delete cascade,
  entity_id        uuid references entities(id) on delete cascade,
  key              text not null,
  label            text not null,
  kind             text not null check (kind in ('entry', 'calculated')),
  unit             text not null default 'number'
                     check (unit in ('number', 'money', 'percent', 'hours', 'ratio')),
  decimals         smallint not null default 0 check (decimals between 0 and 4),
  -- Entry KPIs only. Calculated ones are re-evaluated after their inputs
  -- aggregate and so have no aggregation of their own — see the header.
  aggregation      text check (aggregation in ('sum', 'average', 'last', 'max', 'min')),
  dimension_id     uuid references kpi_dimension(id) on delete set null,
  formula          text,
  hint             text,
  show_on_overview boolean not null default false,
  sort_order       int not null default 0,
  is_active        boolean not null default true,
  created_by       uuid references staff_profiles(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint kpi_definition_owner check (num_nonnulls(sector_id, entity_id) = 1),
  constraint kpi_definition_formula check ((kind = 'calculated') = (formula is not null)),
  constraint kpi_definition_aggregation check ((kind = 'entry') = (aggregation is not null))
);
comment on table kpi_definition is
  'One KPI. Pack-level (sector_id) or bespoke to a client (entity_id). `key` is the identifier a formula refers to.';
comment on column kpi_definition.aggregation is
  'How this KPI rolls monthly figures into a quarter or a year. Headcount averages, places take the last, most things sum. Only entry KPIs have one: calculated KPIs are recomputed from aggregated inputs instead.';
comment on column kpi_definition.formula is
  'Expression over other KPI keys and dashboard financial categories, parsed by forecast/lib/expr.js. Dimension subscripts allowed: children[room] / places[room].';

create unique index if not exists idx_kpi_definition_sector_key
  on kpi_definition(sector_id, key) where sector_id is not null;
create unique index if not exists idx_kpi_definition_entity_key
  on kpi_definition(entity_id, key) where entity_id is not null;

-- ── Per-client overrides of a pack definition ───────────────────
create table if not exists kpi_client_override (
  id               uuid primary key default gen_random_uuid(),
  entity_id        uuid not null references entities(id) on delete cascade,
  definition_id    uuid not null references kpi_definition(id) on delete cascade,
  is_hidden        boolean not null default false,
  label            text,
  sort_order       int,
  show_on_overview boolean,
  created_at       timestamptz not null default now(),
  unique (entity_id, definition_id)
);
comment on table kpi_client_override is
  'Sparse per-client divergence from a sector pack — hide it, rename it, reorder it. Absence means the pack applies, so a pack fix reaches everyone who has not deliberately diverged.';

-- ── Values ──────────────────────────────────────────────────────
create table if not exists kpi_value (
  id                 uuid primary key default gen_random_uuid(),
  entity_id          uuid not null references entities(id) on delete cascade,
  definition_id      uuid not null references kpi_definition(id) on delete cascade,
  period             date not null,
  dimension_value_id uuid references kpi_dimension_value(id) on delete cascade,
  value              numeric,
  source             text not null default 'manual'
                       check (source in ('manual', 'brightpay', 'import', 'api')),
  -- A human has typed over an automated figure. The next import must not
  -- silently undo the correction.
  is_override        boolean not null default false,
  note               text,
  entered_by         uuid references staff_profiles(id),
  entered_at         timestamptz not null default now(),
  constraint kpi_value_month_start check (date_trunc('month', period) = period)
);
comment on table kpi_value is
  'An entered or imported KPI figure for one client, one month, optionally one dimension value. Calculated KPIs never appear here — they are derived at read time so a stored figure can never disagree with the chart beside it.';
comment on column kpi_value.is_override is
  'Set when someone typed over an automated figure. An importer must leave these alone or it will quietly undo a correction.';

-- NULLS NOT DISTINCT so an undimensioned KPI gets one row per month rather
-- than unlimited rows that all look identical (Postgres 15+; this is 17).
create unique index if not exists idx_kpi_value_unique
  on kpi_value (entity_id, definition_id, period, dimension_value_id) nulls not distinct;
create index if not exists idx_kpi_value_entity_period on kpi_value(entity_id, period);

-- ── Permission ──────────────────────────────────────────────────
-- Editing a pack changes every client in that sector, so it is gated separately
-- from entering one client's figures, which any active staff member may do.
alter table staff_profiles
  add column if not exists can_manage_kpi_packs boolean not null default false;
comment on column staff_profiles.can_manage_kpi_packs is
  'Create and edit sector KPI packs. A pack edit fans out to every client in the sector, which is why it is not simply is_active_staff().';

create or replace function can_manage_kpi_packs()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select is_active_staff()
     and coalesce((select sp.can_manage_kpi_packs from staff_profiles sp where sp.id = auth.uid()), false);
$$;
revoke execute on function can_manage_kpi_packs() from public, anon;
grant execute on function can_manage_kpi_packs() to authenticated, service_role;

-- ── RLS ─────────────────────────────────────────────────────────
-- Pack-shaped tables: read by any active staff, written only with the flag.
-- Client-shaped tables (dimension values, overrides, figures): any active staff,
-- same as the rest of the dashboard's per-client configuration.
alter table kpi_sector enable row level security;
alter table kpi_dimension enable row level security;
alter table kpi_dimension_value enable row level security;
alter table kpi_definition enable row level security;
alter table kpi_client_override enable row level security;
alter table kpi_value enable row level security;

drop policy if exists kpi_sector_read on kpi_sector;
create policy kpi_sector_read on kpi_sector for select using (is_active_staff());
drop policy if exists kpi_sector_write on kpi_sector;
create policy kpi_sector_write on kpi_sector for all
  using (can_manage_kpi_packs()) with check (can_manage_kpi_packs());

-- A dimension or definition is pack-level or bespoke, and the two need
-- different rules in the same policy: the pack half needs the flag, the
-- client half does not.
drop policy if exists kpi_dimension_read on kpi_dimension;
create policy kpi_dimension_read on kpi_dimension for select using (is_active_staff());
drop policy if exists kpi_dimension_write on kpi_dimension;
create policy kpi_dimension_write on kpi_dimension for all
  using (case when sector_id is not null then can_manage_kpi_packs() else is_active_staff() end)
  with check (case when sector_id is not null then can_manage_kpi_packs() else is_active_staff() end);

drop policy if exists kpi_definition_read on kpi_definition;
create policy kpi_definition_read on kpi_definition for select using (is_active_staff());
drop policy if exists kpi_definition_write on kpi_definition;
create policy kpi_definition_write on kpi_definition for all
  using (case when sector_id is not null then can_manage_kpi_packs() else is_active_staff() end)
  with check (case when sector_id is not null then can_manage_kpi_packs() else is_active_staff() end);

drop policy if exists kpi_dimension_value_staff on kpi_dimension_value;
create policy kpi_dimension_value_staff on kpi_dimension_value for all
  using (is_active_staff()) with check (is_active_staff());

drop policy if exists kpi_client_override_staff on kpi_client_override;
create policy kpi_client_override_staff on kpi_client_override for all
  using (is_active_staff()) with check (is_active_staff());

drop policy if exists kpi_value_staff on kpi_value;
create policy kpi_value_staff on kpi_value for all
  using (is_active_staff()) with check (is_active_staff());

-- ── Effective definitions for one client ────────────────────────
-- Pack + bespoke, minus hidden, with overrides folded in. One place, so the
-- entry grid, the tiles and the formula resolver can never disagree about what
-- this client's KPIs are.
create or replace function kpi_definitions_for_entity(p_entity_id uuid)
returns table (
  id               uuid,
  key              text,
  label            text,
  kind             text,
  unit             text,
  decimals         smallint,
  aggregation      text,
  dimension_id     uuid,
  dimension_key    text,
  dimension_label  text,
  formula          text,
  hint             text,
  show_on_overview boolean,
  sort_order       int,
  origin           text
)
language sql
stable
security definer
set search_path = public
as $$
  select d.id,
         d.key,
         coalesce(o.label, d.label),
         d.kind, d.unit, d.decimals, d.aggregation,
         d.dimension_id, dim.key, dim.label,
         d.formula, d.hint,
         coalesce(o.show_on_overview, d.show_on_overview),
         coalesce(o.sort_order, d.sort_order),
         case when d.sector_id is not null then 'pack' else 'client' end
  from kpi_definition d
  left join kpi_dimension dim on dim.id = d.dimension_id
  left join kpi_client_override o
         on o.definition_id = d.id and o.entity_id = p_entity_id
  where is_active_staff()
    and d.is_active
    and coalesce(o.is_hidden, false) = false
    and (
      d.entity_id = p_entity_id
      or d.sector_id = (select e.kpi_sector_id from entities e where e.id = p_entity_id)
    )
  order by coalesce(o.sort_order, d.sort_order), coalesce(o.label, d.label);
$$;

revoke execute on function kpi_definitions_for_entity(uuid) from public, anon;
grant execute on function kpi_definitions_for_entity(uuid) to authenticated, service_role;

-- ── What hasn't been entered ────────────────────────────────────
-- Monthly entry is remembered for a fortnight and then it isn't. This is the
-- list that makes it visible across the whole practice: every client, every
-- month in range, every entry KPI with no figure. Calculated KPIs are excluded
-- — nobody enters those.
create or replace function kpi_outstanding(p_from date, p_to date)
returns table (
  entity_id     uuid,
  entity_name   text,
  sector_label  text,
  period        date,
  definition_id uuid,
  kpi_label     text,
  missing       int,
  expected      int
)
language sql
stable
security definer
set search_path = public
as $$
  with months as (
    select generate_series(date_trunc('month', p_from), date_trunc('month', p_to), interval '1 month')::date as period
  ),
  -- Only clients that have been given a sector, or a bespoke KPI of their own.
  tracked as (
    select distinct e.id, e.name, s.label as sector_label
    from entities e
    left join kpi_sector s on s.id = e.kpi_sector_id
    where e.kpi_sector_id is not null
       or exists (select 1 from kpi_definition d where d.entity_id = e.id and d.is_active)
  ),
  defs as (
    select t.id as entity_id, t.name, t.sector_label, d.id as definition_id, d.label, d.dimension_id
    from tracked t
    join lateral kpi_definitions_for_entity(t.id) d on true
    where d.kind = 'entry'
  ),
  -- A dimensioned KPI expects one figure per active dimension value.
  expected as (
    select f.*, m.period,
           case when f.dimension_id is null then 1
                else greatest((select count(*) from kpi_dimension_value v
                               where v.dimension_id = f.dimension_id
                                 and v.entity_id = f.entity_id
                                 and v.is_active), 1)
           end::int as expected_n
    from defs f cross join months m
  ),
  got as (
    select x.entity_id, x.definition_id, x.period, count(v.id)::int as have
    from expected x
    left join kpi_value v
           on v.entity_id = x.entity_id
          and v.definition_id = x.definition_id
          and v.period = x.period
          and v.value is not null
    group by 1, 2, 3
  )
  select x.entity_id, x.name, x.sector_label, x.period, x.definition_id, x.label,
         (x.expected_n - coalesce(g.have, 0))::int, x.expected_n
  from expected x
  left join got g
         on g.entity_id = x.entity_id and g.definition_id = x.definition_id and g.period = x.period
  where is_active_staff()
    and (x.expected_n - coalesce(g.have, 0)) > 0
  order by x.period desc, x.name, x.label;
$$;

revoke execute on function kpi_outstanding(date, date) from public, anon;
grant execute on function kpi_outstanding(date, date) to authenticated, service_role;

commit;
