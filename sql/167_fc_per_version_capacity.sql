-- 167: Client Forecast — registered places become a PER-VERSION assumption.
--
-- fc_entity is forecast-level, so config.capacity_by_age_band was shared by
-- every version: editing the room split in one version silently rewrote it
-- for all of them (Puddleduck, 2026-07-25 — three versions collapsed onto
-- one split). New entity-scoped `capacity.places.<band>` drivers live on the
-- scenario, so they are per version; blank = the location default.
--
-- Part 1 creates the driver rows (no values — blank inherits).
-- Part 2 repairs Puddleduck: restores the location default and pins each
-- version to its recovered split. Splits recovered by inverting the model:
--   capacity = floor_positions x ratio / (occupancy/100)
-- from each version's own stored outputs; all three total 62.

-- ── Part 1: driver rows for every scenario x location ────────────────
insert into fc_driver (scenario_id, entity_id, module_key, driver_key, label, unit, kind)
select s.id, e.id, 'locations', k.driver_key, k.label, 'count', 'scalar'
from fc_scenario s
join fc_version v on v.id = s.version_id
join fc_forecast f on f.id = v.forecast_id
join fc_entity e on e.forecast_id = f.id
cross join (values
  ('capacity.places.babies',        'Registered places — 0-2 (blank = location default)'),
  ('capacity.places.twos',          'Registered places — 2-3 (blank = location default)'),
  ('capacity.places.three_to_five', 'Registered places — 3-5 (blank = location default)'),
  ('capacity.places.after_school',  'Registered places — After-school (blank = location default)')
) as k(driver_key, label)
where not exists (
  select 1 from fc_driver d
  where d.scenario_id = s.id and d.entity_id = e.id
    and d.module_key = 'locations' and d.driver_key = k.driver_key
);

-- ── Part 2: repair the Puddleduck splits ────────────────────────────
-- Location default = the actual registered split (12 / 21 / 29).
update fc_entity
set config = jsonb_set(config, '{capacity_by_age_band}',
      '{"babies": 12, "twos": 21, "three_to_five": 29, "after_school": 0}'::jsonb),
    updated_at = now()
where id = '1fe8dae3-e494-4382-ba5a-0cd1dbd079bc';

-- Pin each version explicitly so none of them can drift again.
with target(scenario_id, band, places) as (values
  -- original: 12 / 21 / 29
  ('5b65c524-cf37-4dd9-b1e4-37d87e6ad6aa'::uuid, 'babies',        12),
  ('5b65c524-cf37-4dd9-b1e4-37d87e6ad6aa'::uuid, 'twos',          21),
  ('5b65c524-cf37-4dd9-b1e4-37d87e6ad6aa'::uuid, 'three_to_five', 29),
  ('5b65c524-cf37-4dd9-b1e4-37d87e6ad6aa'::uuid, 'after_school',   0),
  -- 3-5 heavy: 12 / 12 / 38
  ('c2adcdf3-07d5-4518-af55-817868f38766'::uuid, 'babies',        12),
  ('c2adcdf3-07d5-4518-af55-817868f38766'::uuid, 'twos',          12),
  ('c2adcdf3-07d5-4518-af55-817868f38766'::uuid, 'three_to_five', 38),
  ('c2adcdf3-07d5-4518-af55-817868f38766'::uuid, 'after_school',   0),
  -- 3-5 only: 0 / 0 / 62
  ('25753911-0e74-4620-b664-a94ce91e775d'::uuid, 'babies',         0),
  ('25753911-0e74-4620-b664-a94ce91e775d'::uuid, 'twos',           0),
  ('25753911-0e74-4620-b664-a94ce91e775d'::uuid, 'three_to_five', 62),
  ('25753911-0e74-4620-b664-a94ce91e775d'::uuid, 'after_school',   0)
)
insert into fc_driver_value (driver_id, period, value)
select d.id, -1, t.places
from target t
join fc_driver d on d.scenario_id = t.scenario_id
  and d.module_key = 'locations'
  and d.driver_key = 'capacity.places.' || t.band
  and d.entity_id = '1fe8dae3-e494-4382-ba5a-0cd1dbd079bc'
on conflict (driver_id, period) do update set value = excluded.value;
