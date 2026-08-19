-- 237 — Client Dashboard: Projection tab
--
-- Links one client dashboard (realm) to one Client Forecast scenario, and
-- records how that scenario's output lines land on the dashboard's own
-- statement categories.
--
-- Why a mapping table at all: fc_output speaks in nominal_type keys that differ
-- by vertical pack ('pnl.revenue_la_funded' in childcare, 'pnl.cost_payroll' in
-- general cashflow), and the QBO actuals speak in account ids. Both have to land
-- on ONE set of dashboard rows or the actual/forecast columns can't sit side by
-- side. Sensible defaults are derived in code (projectionMapping.js); this table
-- only stores the overrides a human has made, so a pack change doesn't silently
-- re-map anything someone has already decided.
--
-- Anything with no rule and no override falls into the catch-all for its
-- statement section (unmapped_income / unmapped_costs / unmapped_assets /
-- unmapped_liabilities / unmapped_capital). Nothing is ever dropped on the
-- floor: an unrecognised line shows up in a bucket the reader can see rather
-- than quietly vanishing out of a total.
--
-- Access: staff read/write per the same rule as the rest of the dashboard
-- config tables (any active staff, practice books gated). Client-portal reads
-- go through the portal RPCs in sql/238, never through these policies.

begin;

-- ── Linked scenario ──────────────────────────────────────────
create table if not exists dashboard_projections (
  id              uuid primary key default gen_random_uuid(),
  realm_id        text not null unique,
  entity_id       uuid references entities(id) on delete set null,
  forecast_id     uuid references fc_forecast(id) on delete set null,
  version_id      uuid references fc_version(id) on delete set null,
  scenario_id     uuid not null references fc_scenario(id) on delete cascade,
  -- Last month whose ACTUALS are used. Forecast takes over from the month
  -- after. Stored as a month end date.
  actuals_through date,
  created_by      uuid references staff_profiles(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
comment on table dashboard_projections is
  'One Client Forecast scenario linked to one client dashboard (realm), plus the actuals cut-off the Projection tab splits on.';
comment on column dashboard_projections.actuals_through is
  'Month end of the last actuals month. Buckets ending on or before this are actual; later buckets come from the scenario.';

create index if not exists idx_dashboard_projections_entity on dashboard_projections(entity_id);
create index if not exists idx_dashboard_projections_scenario on dashboard_projections(scenario_id);

-- ── Line → category overrides ────────────────────────────────
create table if not exists dashboard_projection_map (
  id          uuid primary key default gen_random_uuid(),
  realm_id    text not null,
  -- 'forecast' → source_key is an fc_output.nominal_type
  -- 'actual'   → source_key is a QBO account id
  source      text not null check (source in ('forecast', 'actual')),
  source_key  text not null,
  category    text not null,
  created_by  uuid references staff_profiles(id),
  created_at  timestamptz not null default now(),
  unique (realm_id, source, source_key)
);
comment on table dashboard_projection_map is
  'Human overrides of the default forecast-line / QBO-account to dashboard-category mapping. Absence of a row means the code default applies.';

create index if not exists idx_dashboard_projection_map_realm on dashboard_projection_map(realm_id, source);

-- ── RLS ──────────────────────────────────────────────────────
-- Mirrors dashboard_adjustment_accounts: active staff only, and AVA's own
-- books (is_practice) gated behind can_view_practice_financials so the
-- practice's numbers don't leak to the whole team through a side door.
alter table dashboard_projections enable row level security;
alter table dashboard_projection_map enable row level security;

create or replace function dashboard_realm_visible(p_realm_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select is_active_staff()
     and not exists (
       select 1 from qbo_report_connections c
       where c.realm_id = p_realm_id
         and c.is_practice
         and not coalesce(
           (select sp.can_view_practice_financials from staff_profiles sp where sp.id = auth.uid()),
           false)
     );
$$;
comment on function dashboard_realm_visible is
  'True when the caller is active staff AND (the realm is not the practice''s own books, or they hold can_view_practice_financials).';

-- Supabase's default privileges grant EXECUTE on new public functions to anon,
-- authenticated AND service_role EXPLICITLY, so a revoke from PUBLIC leaves an
-- `anon=X/postgres` entry standing and the posture audit flags the function as
-- anon-reachable. anon has to be named.
revoke execute on function dashboard_realm_visible(text) from public, anon;
grant execute on function dashboard_realm_visible(text) to authenticated, service_role;

drop policy if exists dashboard_projections_staff on dashboard_projections;
create policy dashboard_projections_staff on dashboard_projections
  for all using (dashboard_realm_visible(realm_id))
  with check (dashboard_realm_visible(realm_id));

drop policy if exists dashboard_projection_map_staff on dashboard_projection_map;
create policy dashboard_projection_map_staff on dashboard_projection_map
  for all using (dashboard_realm_visible(realm_id))
  with check (dashboard_realm_visible(realm_id));

-- ── Client-safe scenario picker ──────────────────────────────
-- The Projection tab offers "link an existing scenario". fc_* is staff-only and
-- stays that way; this just saves the UI three joins.
create or replace function dashboard_scenarios_for_entity(p_entity_id uuid)
returns table (
  forecast_id     uuid,
  forecast_name   text,
  vertical_pack   text,
  opening_period  date,
  horizon_months  int,
  version_id      uuid,
  version_name    text,
  scenario_id     uuid,
  scenario_name   text,
  scenario_kind   text,
  output_rows     bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select f.id, f.name, f.vertical_pack, f.opening_period, f.horizon_months,
         v.id, v.name, s.id, s.name, s.kind,
         (select count(*) from fc_output o where o.scenario_id = s.id)
  from fc_forecast f
  join fc_version v on v.forecast_id = f.id
  join fc_scenario s on s.version_id = v.id
  where is_active_staff()
    and (p_entity_id is null or f.client_entity_id = p_entity_id)
  order by f.updated_at desc, v.created_at, s.created_at;
$$;

revoke execute on function dashboard_scenarios_for_entity(uuid) from public, anon;
grant execute on function dashboard_scenarios_for_entity(uuid) to authenticated, service_role;

commit;
