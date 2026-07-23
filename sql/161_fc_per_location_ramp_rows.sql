-- 161: Client Forecast — seed blank per-location ramp/capacity driver
-- rows into every existing scenario.
--
-- The ramp overrides (ramp.*) and per-location band-curve overrides
-- (capacity.* entity scope) are blank-by-default drivers: a row with no
-- value means "use the location / group default". Existing scenarios
-- were seeded before these drivers existed, so the rows are missing and
-- the drivers grid has nothing to edit. This seeds the blank rows for
-- every (scenario × location) pair — values stay unset.

insert into fc_driver (scenario_id, entity_id, module_key, driver_key, label, unit, kind)
select s.id, e.id, 'locations', k.driver_key, k.label, k.unit, 'scalar'
from fc_scenario s
join fc_version v on v.id = s.version_id
join fc_forecast f on f.id = v.forecast_id
join fc_entity e on e.forecast_id = f.id
cross join (values
  ('ramp.starting_occupancy_pct', 'Ramp override — opening occupancy % (blank = location default)', 'pct'),
  ('ramp.target_occupancy_pct',   'Ramp override — target occupancy % (blank = location default)',  'pct'),
  ('ramp.months_to_target',       'Ramp override — months to target (blank = location default)',    'count'),
  ('capacity.opening_pct.babies',        'Capacity at opening — 0-2 — this location (blank = default)',  'pct'),
  ('capacity.opening_pct.twos',          'Capacity at opening — 2-3 — this location (blank = default)',  'pct'),
  ('capacity.opening_pct.three_to_five', 'Capacity at opening — 3-5 — this location (blank = default)',  'pct'),
  ('capacity.opening_pct.after_school',  'Capacity at opening — After-school — this location (blank = default)', 'pct'),
  ('capacity.target_pct.babies',         'Capacity target — 0-2 — this location (blank = default)',      'pct'),
  ('capacity.target_pct.twos',           'Capacity target — 2-3 — this location (blank = default)',      'pct'),
  ('capacity.target_pct.three_to_five',  'Capacity target — 3-5 — this location (blank = default)',      'pct'),
  ('capacity.target_pct.after_school',   'Capacity target — After-school — this location (blank = default)', 'pct'),
  ('capacity.phase_up_months.babies',        'Phase-up to target — 0-2 (months) — this location (blank = default)', 'count'),
  ('capacity.phase_up_months.twos',          'Phase-up to target — 2-3 (months) — this location (blank = default)', 'count'),
  ('capacity.phase_up_months.three_to_five', 'Phase-up to target — 3-5 (months) — this location (blank = default)', 'count'),
  ('capacity.phase_up_months.after_school',  'Phase-up to target — After-school (months) — this location (blank = default)', 'count')
) as k(driver_key, label, unit)
where not exists (
  select 1 from fc_driver d
  where d.scenario_id = s.id and d.entity_id = e.id
    and d.module_key = 'locations' and d.driver_key = k.driver_key
);
